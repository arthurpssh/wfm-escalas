import test from 'node:test';
import assert from 'node:assert/strict';
import { roleFor, isAdmin, defaultTeam } from '../server/core/access.js';
import { createDraftStore, effectiveCells, staleItems, ConflictError } from '../server/core/drafts.js';
import { openRemovalsCard } from '../server/core/jira.js';
import { createAudit } from '../server/core/audit.js';
import { TEAMS, ACCESS_SEED, AGENTS, ORPHAN_AGENT_IDS, CTX, generateMonth } from '../server/mockData.js';
import { configToShifts } from '../shared/rules.js';

const today = '2026-11-10';
const ctx = { access: ACCESS_SEED, today };
const alfa = TEAMS[0], beta = TEAMS[1], gama = TEAMS[2];

test('permissões: supervisor, coordenador, acesso com validade e leitura', () => {
  assert.equal(roleFor('sup.alfa@example.com', alfa, ctx), 'editor');
  assert.equal(roleFor('sup.alfa@example.com', beta, ctx), 'viewer');
  assert.equal(roleFor('coord@example.com', alfa, ctx), 'editor');
  assert.equal(roleFor('coord@example.com', beta, ctx), 'editor');
  assert.equal(roleFor('coord@example.com', gama, ctx), 'viewer'); // gama sem coordenação
  assert.equal(roleFor('sup.gama@example.com', alfa, ctx), 'editor'); // cobertura (Acessos)
  assert.equal(roleFor('visitante@example.com', beta, ctx), 'viewer'); // acesso expirado não vale
  assert.equal(isAdmin('admin@example.com', ctx), true);
  assert.equal(isAdmin('sup.alfa@example.com', ctx), false);
  assert.equal(defaultTeam('sup.beta@example.com', TEAMS, ctx), 'sup.beta@example.com');
});

test('times: ids sem Users são ignorados e contados', () => {
  assert.deepEqual(ORPHAN_AGENT_IDS, ['999999']);
  assert.ok(AGENTS.every((a) => a.email));
});

const mk = (email, day, cfg) => configToShifts(cfg, `2026-11-${String(day).padStart(2, '0')}`, CTX);
const task = [...CTX.tasks.keys()][0];
const A = { taskId: task, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 };

test('rascunho: tipos, versão, reversão e conflito', () => {
  const email = AGENTS[0].email, team = AGENTS[0].team;
  const pub = generateMonth('2026-11')[email];
  const store = createDraftStore();
  const after = mk(email, 2, A);
  let d = store.saveDay({ team, month: '2026-11', email, day: 2, after, published: pub[2] ?? [], user: 'u', version: 0 });
  assert.equal(d.version, 1);
  const kind = d.items.get(`${email}|2`).kind;
  assert.ok(['created', 'edited'].includes(kind));
  // versão velha => conflito
  assert.throws(() => store.saveDay({ team, month: '2026-11', email, day: 3, after, published: [], user: 'v', version: 0 }), ConflictError);
  // remover
  d = store.saveDay({ team, month: '2026-11', email, day: 2, after: [], published: pub[2] ?? [], user: 'u', version: 1 });
  if (pub[2]?.length) assert.equal(d.items.get(`${email}|2`).kind, 'removed'); else assert.equal(d, null);
  // voltar ao publicado remove o item e fecha o rascunho
  if (d) {
    d = store.saveDay({ team, month: '2026-11', email, day: 2, after: pub[2], published: pub[2], user: 'u', version: d.version });
    assert.equal(d, null);
  }
});

test('escala efetiva e itens obsoletos (stale)', () => {
  const email = AGENTS[0].email, team = AGENTS[0].team;
  const pub = { [email]: generateMonth('2026-11')[email] };
  const store = createDraftStore();
  const after = mk(email, 2, A);
  const d = store.saveDay({ team, month: '2026-11', email, day: 2, after, published: pub[email][2] ?? [], user: 'u', version: 0 });
  assert.deepEqual(effectiveCells(pub, d, [email])[email][2], after);
  assert.equal(staleItems(d, pub).length, 0);
  pub[email][2] = mk(email, 2, { ...A, entry: 480 }); // alguém mexeu direto no WFM
  assert.equal(staleItems(d, pub).length, 1);
});

test('Jira: um card consolidado por checkout, dry-run por padrão', async () => {
  const email = AGENTS[0].email;
  const prev = generateMonth('2026-11')[email][2] ?? mk(email, 2, A);
  const r = await openRemovalsCard({ team: AGENTS[0].team, month: '2026-11', requestedBy: 'u', removals: [{ agent: AGENTS[0], date: '2026-11-02', previousShifts: prev }, { agent: AGENTS[0], date: '2026-11-03', previousShifts: prev }] });
  assert.equal(r.dryRun, true); assert.match(r.key, /^DRYRUN-/);
  assert.match(r.payload.fields.summary, /Remover 2 dia/);
});

test('histórico: uma aba por mês e filtros', () => {
  const a = createAudit();
  a.log({ ts: '2026-10-31T10:00:00Z', actor: 'x', action: 'checkout' });
  a.log({ ts: '2026-11-01T10:00:00Z', actor: 'y', action: 'draft.save', team: 't' });
  assert.deepEqual(a.months(), ['2026-11', '2026-10']);
  assert.equal(a.query({ month: '2026-11' }).length, 1);
  assert.equal(a.query({ actor: 'x' })[0].action, 'checkout');
});

import { hasAccess } from '../server/core/access.js';
test('modo restrito: entra só quem tem linha válida em Acessos (qualquer papel); vencida não vale', () => {
  const c = { access: [...ACCESS_SEED, { email: 'Analista@x.com', team: '*', role: 'viewer', validUntil: '' }], today };
  assert.equal(hasAccess('admin@example.com', c), true); // admin
  assert.equal(hasAccess('sup.gama@example.com', c), true); // editor com validade em vigor
  assert.equal(hasAccess('analista@x.com', c), true); // viewer, e-mail em outra caixa
  assert.equal(hasAccess('visitante@example.com', c), false); // acesso vencido
  assert.equal(hasAccess('sup.alfa@example.com', c), false); // é supervisor, mas não está em Acessos
  assert.equal(hasAccess('', c), false);
});

import { resolveAccessMode } from '../server/core/access.js';
test('modo de entrada: a Config manda; vazio usa o ambiente; valor inválido FECHA', () => {
  assert.deepEqual(resolveAccessMode(undefined, 'open'), { mode: 'open', source: 'ambiente' });
  assert.deepEqual(resolveAccessMode('', 'restricted'), { mode: 'restricted', source: 'ambiente' });
  assert.equal(resolveAccessMode('  Restricted ', 'open').mode, 'restricted'); // caixa e espaços não importam
  assert.equal(resolveAccessMode('OPEN', 'restricted').mode, 'open'); // a planilha vence o ambiente
  const typo = resolveAccessMode('restrito', 'open'); // erro de digitação: não pode abrir o acesso
  assert.deepEqual([typo.mode, typo.invalid, typo.source], ['restricted', true, 'planilha (Config)']);
});

import { createDraftLocks } from '../server/core/locks.js';
test('trava por rascunho: o 2º checkout simultâneo é barrado (409), a trava sai mesmo com erro e libera depois', async () => {
  const locks = createDraftLocks();
  const key = 't@x.com|2026-11';
  let liberar; const emAndamento = new Promise((ok) => { liberar = ok; });
  let criadas = 0;
  const checkout = (user) => locks.run(key, user, 'confirmando', async () => { await emAndamento; criadas++; return user; }); // simula a gravação lenta na planilha
  const a = checkout('arthur@x.com'); // começa e fica "gravando"
  const b = checkout('ramon@x.com'); // 130 ms depois, na vida real
  await assert.rejects(b, (e) => e.status === 409 && /arthur@x.com está confirmando este rascunho agora/.test(e.message));
  assert.throws(() => locks.assertFree(key), (e) => e.status === 409); // edições também esperam
  assert.equal(locks.isLocked(key), true);
  liberar();
  assert.equal(await a, 'arthur@x.com');
  assert.equal(criadas, 1); // só UMA exportação teria sido gerada
  assert.equal(locks.isLocked(key), false);
  locks.assertFree(key); // livre de novo
  await assert.rejects(locks.run(key, 'x', 'confirmando', async () => { throw new Error('falhou'); }), /falhou/);
  assert.equal(locks.isLocked(key), false); // erro não deixa a trava presa
  assert.equal(await locks.run(key, 'y', 'confirmando', async () => 'ok'), 'ok');
  assert.equal(locks.isLocked('outro|2026-11'), false); // outro rascunho não é afetado
});

test('trava: "acabou de ser confirmado por X" só vale por alguns minutos', () => {
  let t = 0;
  const locks = createDraftLocks({ now: () => t, recentMs: 5 * 60_000 });
  assert.equal(locks.recent('k'), null);
  locks.markDone('k', 'arthur@x.com');
  assert.equal(locks.recent('k').user, 'arthur@x.com');
  t = 5 * 60_000 + 1;
  assert.equal(locks.recent('k'), null);
});

import { createPresence, displayName } from '../server/core/presence.js';
test('presença: online por 60 s, várias abas = uma pessoa, sair, mesmo time/mês, e o "editando"', () => {
  let t = 1_000_000;
  const p = createPresence({ now: () => t });
  p.ping({ sid: 'a1', email: 'arthur.santos@x.com', page: 'escalas', team: 'sup@x.com', month: '2026-11' });
  p.ping({ sid: 'r1', email: 'ramon.soares@x.com', page: 'escalas', team: 'sup@x.com', month: '2026-11' });
  p.ping({ sid: 'r2', email: 'ramon.soares@x.com', page: 'folgas', team: 'sup@x.com', month: '2026-11', visible: false }); // 2ª aba, oculta
  p.ping({ sid: 'o1', email: 'outra@x.com', page: 'escalas', team: 'outro@x.com', month: '2026-11' }); // outro time
  p.ping({ sid: 'm1', email: 'mes@x.com', page: 'escalas', team: 'sup@x.com', month: '2026-12' }); // outro mês

  const vistoPeloArthur = p.users({ team: 'sup@x.com', month: '2026-11', excludeEmail: 'arthur.santos@x.com' });
  assert.deepEqual(vistoPeloArthur.map((u) => u.email), ['ramon.soares@x.com']); // só o mesmo time e mês; ele mesmo não aparece
  assert.deepEqual([vistoPeloArthur[0].name, vistoPeloArthur[0].tabs, vistoPeloArthur[0].active], ['Ramon Soares', 2, true]); // 2 abas = 1 pessoa; uma visível = ativo
  assert.equal(vistoPeloArthur[0].editing, false);

  p.markEdit('ramon.soares@x.com', 'sup@x.com', '2026-11'); // ramon salvou um dia
  assert.equal(p.users({ team: 'sup@x.com', month: '2026-11', excludeEmail: 'arthur.santos@x.com' })[0].editing, true);
  assert.equal(p.users({ team: 'sup@x.com', month: '2026-12', excludeEmail: 'x' }).find((u) => u.email === 'ramon.soares@x.com'), undefined); // no outro mês ele não está

  t += 61_000; assert.equal(p.users({ all: true }).filter((u) => u.email.startsWith('ramon')).length, 1, 'aba oculta ainda vale (ttl x3)'); t += 120_000; // ninguém pingou há mais de 3 min
  assert.deepEqual(p.users({ all: true }), []);
  p.ping({ sid: 'a1', email: 'arthur.santos@x.com', page: 'admin' });
  assert.equal(p.users({ all: true }).length, 1);
  p.leave('a1', 'outro@x.com'); // não pode tirar a sessão de outra pessoa
  assert.equal(p.users({ all: true }).length, 1);
  p.leave('a1', 'arthur.santos@x.com');
  assert.equal(p.users({ all: true }).length, 0);
});

test('presença: o "editando" expira em 3 min; lista global traz onde editou; sid reaproveitado por outro e-mail recomeça', () => {
  let t = 0;
  const p = createPresence({ now: () => t, ttlMs: 10 * 60_000 });
  p.ping({ sid: 's1', email: 'a@x.com', page: 'escalas', team: 'sup@x.com', month: '2026-11' });
  p.markEdit('a@x.com', 'sup@x.com', '2026-11');
  const g = p.users({ all: true })[0];
  assert.deepEqual([g.editing[0].team, g.editing[0].month], ['sup@x.com', '2026-11']);
  t = 181_000;
  assert.deepEqual(p.users({ all: true })[0].editing, []);
  assert.equal(p.users({ team: 'sup@x.com', month: '2026-11', excludeEmail: 'x' })[0].editing, false);
  t = 200_000;
  p.ping({ sid: 's1', email: 'b@x.com', page: 'escalas', team: 'sup@x.com', month: '2026-11' }); // mesmo sid, outra pessoa
  const u = p.users({ all: true }).map((x) => [x.email, x.since]);
  assert.deepEqual(u, [['b@x.com', new Date(200_000).toISOString()]]); // não herdou a sessão da outra pessoa
  assert.equal(displayName('ramon.soares@hotmart.com'), 'Ramon Soares');
  assert.equal(displayName('sup_alfa-1@x.com'), 'Sup Alfa 1');
});
