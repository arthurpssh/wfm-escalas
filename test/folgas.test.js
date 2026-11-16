import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsRepo, parseAccess } from '../server/data/sheetsRepo.js';
import { mergeTimeoffView } from '../server/data/timeoffView.js';

function fakeGateway({ writable = true } = {}) {
  const tabs = new Map();
  const g = {
    writable, tabs,
    async readTab(n) { return structuredClone(tabs.get(n) ?? []); },
    async listTabs() { return [...tabs.keys()]; },
    async ensureTab(n, h) { if (!tabs.get(n)?.length) tabs.set(n, [h]); },
    async replaceTab(n, m) { tabs.set(n, structuredClone(m)); },
    async appendRows(n, rows) { tabs.set(n, [...(tabs.get(n) ?? []), ...structuredClone(rows)]); },
  };
  return g;
}
const mk = (g, extra = {}) => createSheetsRepo({ gateway: g, debounceMs: 60_000, ...extra });
const TH = ['id', 'agentEmail', 'reasonId', 'reasonName', 'startTime', 'endTime', 'status', 'createdAt', 'scheduledAt', 'externalId', 'createdBy'];
const wfmRow = (id, status, over = {}) => [id, 'a@x.com', 'R1', 'Day Off', '2026-11-20T00:00:00-03:00', '2026-11-20T23:59:59-03:00', status, '', '', id, ...(over.createdBy !== undefined ? [over.createdBy] : [''])];
const novaFolga = (over = {}) => ({ id: 'u1', email: 'a@x.com', reasonId: 'R1', reasonName: 'Day Off', startTime: '2026-11-22T00:00:00-03:00', endTime: '2026-11-22T23:59:59-03:00', status: 'agendada', origin: 'app', createdAt: '2026-11-13T10:00:00.000Z', scheduledAt: '2026-11-13T10:02:00.000Z', createdBy: 'sup@x.com', ...over });

test('criar folga: vira pedido "agendada", aparece na lista e sobrevive ao reinício', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.timeoffs.add(novaFolga());
  assert.equal(g.tabs.get('FolgasPedidos')[1][1], 'criar');
  const l = await a.timeoffs.list();
  assert.deepEqual([l[0].id, l[0].status, l[0].origin], ['u1', 'agendada', 'app']);
  const b = mk(g); assert.equal((await b.init()).pedidos, 1);
  assert.equal((await b.timeoffs.get('u1')).status, 'agendada');
});

test('editar e cancelar folga dentro da carência; cancelada some da lista mas fica no histórico', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.timeoffs.add(novaFolga());
  const e = await a.timeoffs.update('u1', { reasonId: 'R2', reasonName: 'Vacation', startTime: '2026-11-23T00:00:00-03:00', endTime: '2026-11-23T23:59:59-03:00', scheduledAt: '2026-11-13T10:05:00.000Z' });
  assert.deepEqual([e.reasonName, e.startTime.slice(0, 10), e.scheduledAt], ['Vacation', '2026-11-23', '2026-11-13T10:05:00.000Z']);
  await a.timeoffs.remove('u1');
  assert.equal((await a.timeoffs.list()).length, 0);
  assert.equal(g.tabs.get('FolgasPedidos')[1][8], 'cancelada');
});

test('aceitar pedido de agente / cancelar aprovada: gera pedido aprovar/negar e a linha já aparece com o efeito', async () => {
  const g = fakeGateway();
  g.tabs.set('TimeOffs', [TH, wfmRow('w1', 'pendente', { createdBy: 'a@x.com' }), wfmRow('w2', 'aprovada')]);
  const a = mk(g); await a.init();
  const ok = await a.timeoffs.update('w1', { status: 'aprovada', decidedBy: 'sup@x.com' });
  assert.equal(ok.status, 'aprovada'); assert.equal(ok.decidedBy, 'sup@x.com');
  const no = await a.timeoffs.update('w2', { status: 'negada', decidedBy: 'sup@x.com' });
  assert.equal(no.status, 'negada');
  const peds = g.tabs.get('FolgasPedidos').slice(1);
  assert.deepEqual(peds.map((p) => [p[1], p[7], p[8]]).sort(), [['aprovar', 'w1', 'agendada'], ['negar', 'w2', 'agendada']]);
  assert.equal(await a.timeoffs.update('inexistente', { status: 'negada' }), null);
});

test('resultado do envio (FolgasEnvios): enviada, erro, duplicada, e cancelada depois que já tinha sido enviada', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  for (const id of ['p1', 'p2', 'p3', 'p4']) await a.timeoffs.add(novaFolga({ id }));
  await a.timeoffs.remove('p4'); // cancelada
  g.tabs.set('FolgasEnvios', [['ts', 'pedidoId', 'resultado', 'externalId', 'detalhe'],
    ['2026-11-13T10:03:00.000Z', 'p1', 'enviada', 'w100', ''],
    ['2026-11-13T10:03:01.000Z', 'p2', 'erro', '', 'WFM recusou'],
    ['2026-11-13T10:03:02.000Z', 'p3', 'duplicada', 'w101', 'Já existia'],
    ['2026-11-13T10:03:03.000Z', 'p4', 'enviada', 'w102', '']]);
  await a.tick();
  const by = Object.fromEntries((await a.timeoffs.list()).map((t) => [t.id, t]));
  assert.equal(by.p1.status, 'aprovada'); assert.equal(by.p1.externalId, 'w100');
  assert.equal(by.p2.status, 'erro'); assert.equal(by.p2.note, 'WFM recusou');
  assert.equal(by.p3.status, 'aprovada');
  assert.equal(by.p4.status, 'aprovada'); assert.match(by.p4.note, /antes do cancelamento/);
  await a.tick(); // idempotente
  await a.flush();
  assert.equal(g.tabs.get('FolgasPedidos').find((r) => r[0] === 'p1')[8], 'enviada');
});

test('quando a extração traz a folga criada pelo app (mesmo id do WFM), o pedido some da lista (sem duplicar)', () => {
  const wfm = [{ id: 'w100', externalId: 'w100', email: 'a@x.com', status: 'aprovada', origin: 'app' }];
  const peds = [{ id: 'p1', tipo: 'criar', status: 'enviada', externalId: 'w100', agentEmail: 'a@x.com', createdAt: '2026-11-13T10:00:00.000Z' }];
  assert.equal(mergeTimeoffView(wfm, peds).length, 1);
  assert.equal(mergeTimeoffView([], peds).length, 1); // antes da extração: aparece como aprovada
});

test('decisões antigas (mais de 24 h) não sobrescrevem o que o WFM diz agora; a mais recente vence', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const wfm = [{ id: 'w1', externalId: 'w1', status: 'aprovada' }];
  const ped = (id, tipo, createdAt) => ({ id, tipo, targetExternalId: 'w1', status: 'enviada', createdAt, createdBy: 'u' });
  assert.equal(mergeTimeoffView(wfm, [ped('a', 'negar', '2026-11-12T12:00:00.000Z')], now)[0].status, 'aprovada'); // 48 h: ignora
  const r = mergeTimeoffView(wfm, [ped('a', 'negar', '2026-11-14T10:00:00.000Z'), ped('b', 'aprovar', '2026-11-14T11:00:00.000Z')], now);
  assert.equal(r[0].status, 'aprovada'); // negou e depois aprovou: vale o último
});

test('acessos: incluir por append, e revogar relendo a aba (recusa se a linha mudou)', async () => {
  const g = fakeGateway();
  g.tabs.set('Acessos', [['email', 'team (nome do time ou *)', 'role', 'validUntil', 'grantedBy', 'grantedAt', 'note'], ['admin@x.com', '*', 'admin', '', '', '', ''], [], ['outro@x.com', 'sup@x.com', 'editor', '', '', '', '']]);
  const a = mk(g); await a.init();
  const antes = await a.access.list();
  assert.deepEqual(antes.map((r) => r.id), ['r2', 'r4']); // número real da linha (a linha 3 está vazia)
  await a.access.add({ email: 'novo@x.com', team: '*', role: 'editor', validUntil: '2026-12-31', grantedBy: 'admin@x.com', note: 'cobertura' });
  assert.equal(g.tabs.get('Acessos').at(-1)[0], 'novo@x.com');
  const lista = await a.access.list();
  const alvo = lista.find((r) => r.email === 'outro@x.com');
  await a.access.remove(alvo.id, alvo);
  assert.deepEqual((await a.access.list()).map((r) => r.email), ['admin@x.com', 'novo@x.com']);
  // alguém editou a aba à mão: o id antigo agora aponta para outra linha → recusa
  await assert.rejects(() => a.access.remove('r2', { email: 'outro@x.com', team: 'sup@x.com', role: 'editor' }), (e) => e.status === 409);
  assert.equal(g.tabs.get('Acessos').length, 4); // nada foi apagado (cabeçalho, admin, linha vazia, novo)
});

test('acessos: data convertida pelo Sheets (número de série) volta como AAAA-MM-DD', () => {
  const [r] = parseAccess([['email', 'team (nome do time ou *)', 'role', 'validUntil'], ['a@x.com', '*', 'editor', 46387]]);
  assert.equal(r.validUntil, '2026-12-31');
});

test('somente leitura: folgas e acessos não gravam (503)', async () => {
  const ro = mk(fakeGateway({ writable: false }));
  await assert.rejects(() => ro.timeoffs.add(novaFolga()), (e) => e.status === 503);
  await assert.rejects(() => ro.access.add({ email: 'x@x.com' }), (e) => e.status === 503);
});

test('erro no envio: o motivo fica no pedido e no histórico (auditável), e é aplicado uma vez só', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.timeoffs.add(novaFolga({ id: 'p1' }));
  const motivo = '[criar] post /v2/timeOff/import -> 422 {"message":"inválido"} · corpo enviado: {"data":[{"agentId":111}]}';
  g.tabs.set('FolgasEnvios', [['ts', 'pedidoId', 'resultado', 'externalId', 'detalhe'], ['2026-11-16T15:00:00.000Z', 'p1', 'erro', '', motivo]]);
  await a.tick();
  const t = await a.timeoffs.get('p1');
  assert.deepEqual([t.status, t.note], ['erro', motivo]); // a tela mostra o motivo
  const log = a.audit.query({ action: 'timeoff.erro_envio' });
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].actor, log[0].agentEmail, log[0].details], ['apps-script', 'a@x.com', `criar: ${motivo}`]);
  await a.tick(); await a.tick();
  assert.equal(a.audit.query({ action: 'timeoff.erro_envio' }).length, 1); // sem duplicar
  await a.flush();
  assert.ok([...g.tabs.keys()].some((n) => n.startsWith('Histórico'))); // gravado na aba de histórico
});
