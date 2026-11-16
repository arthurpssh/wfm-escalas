import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsRepo } from '../server/data/sheetsRepo.js';
import { genConfigToMatrix, historyRow, loadGenConfig } from '../server/data/persist.js';
import { ConflictError } from '../server/core/drafts.js';

/** Planilha falsa em memória com a mesma interface do gateway (leitura + escrita). */
function fakeGateway({ writable = true } = {}) {
  const tabs = new Map();
  const g = {
    writable, tabs, fail: 0, calls: [],
    async readTab(n) { return structuredClone(tabs.get(n) ?? []); },
    async listTabs() { return [...tabs.keys()]; },
    async ensureTab(n, header) { if (!tabs.get(n)?.length) tabs.set(n, [header]); },
    async replaceTab(n, m) { if (g.fail > 0) { g.fail--; throw new Error('cota excedida'); } g.calls.push(['replace', n]); tabs.set(n, structuredClone(m)); },
    async appendRows(n, rows) { g.calls.push(['append', n]); tabs.set(n, [...(tabs.get(n) ?? []), ...structuredClone(rows)]); },
  };
  return g;
}
const shift = (s, e) => ({ taskType: 'workstream', taskId: 'W1', taskName: 'Chat', startTime: `2026-11-02T${s}:00-03:00`, endTime: `2026-11-02T${e}:00-03:00` });
const mk = (g) => createSheetsRepo({ gateway: g, debounceMs: 60_000 }); // debounce enorme: só o flush() grava

test('rascunho: grava na planilha e volta igual depois de reiniciar o app', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  const d = a.drafts.saveDay({ team: 't@x.com', month: '2026-11', email: 'a@x.com', day: 2, after: [shift('09:00', '10:00')], published: [shift('08:00', '09:00')], user: 'sup@x.com', version: 0 });
  assert.equal(d.version, 1);
  await a.flush();
  assert.equal(g.tabs.get('Rascunhos').length, 2);
  assert.equal(g.tabs.get('RascunhoItens')[1][1], 'a@x.com');

  const b = mk(g); const r = await b.init(); // "reinício"
  assert.equal(r.drafts, 1);
  const d2 = b.drafts.get('t@x.com', '2026-11');
  assert.equal(d2.version, 1);
  const it = [...d2.items.values()][0];
  assert.deepEqual(it.after, [shift('09:00', '10:00')]);
  assert.deepEqual(it.before, [shift('08:00', '09:00')]);
  assert.equal(it.kind, 'edited');
  // a versão continua valendo depois do reinício (controle de concorrência)
  assert.throws(() => b.drafts.saveDay({ team: 't@x.com', month: '2026-11', email: 'a@x.com', day: 3, after: [shift('09:00', '10:00')], published: [], user: 'u', version: 0 }), ConflictError);
});

test('rascunho vazio some da planilha (descartar e fechar)', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  a.drafts.saveDay({ team: 't', month: '2026-11', email: 'a@x.com', day: 2, after: [shift('09:00', '10:00')], published: [], user: 'u', version: 0 });
  await a.flush();
  assert.equal(g.tabs.get('Rascunhos').length, 2);
  a.drafts.discard({ team: 't', month: '2026-11', version: 1 });
  await a.flush();
  assert.equal(g.tabs.get('Rascunhos').length, 1); // só o cabeçalho
  assert.equal(g.tabs.get('RascunhoItens').length, 1);
});

test('várias alterações seguidas viram uma gravação por aba', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  let v = 0;
  for (let day = 1; day <= 5; day++) { const d = a.drafts.saveDay({ team: 't', month: '2026-11', email: 'a@x.com', day, after: [shift('09:00', '10:00')], published: [], user: 'u', version: v }); v = d.version; }
  await a.flush();
  assert.equal(g.calls.filter(([op, n]) => op === 'replace' && n === 'Rascunhos').length, 1);
  assert.equal(g.tabs.get('RascunhoItens').length, 6); // cabeçalho + 5 dias
});

test('histórico: só inclusão, uma aba por mês, e volta ao reiniciar', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  a.audit.log({ ts: '2026-11-13T10:00:00.000Z', actor: 'u@x.com', team: 't', month: '2026-11', action: 'draft.save', agentEmail: 'a@x.com', day: 2, before: [], after: [shift('09:00', '10:00')] });
  a.audit.log({ ts: '2026-12-01T10:00:00.000Z', actor: 'u@x.com', action: 'access.grant', details: 'x' });
  await a.flush();
  assert.deepEqual([...g.tabs.keys()].filter((n) => n.startsWith('Histórico')).sort(), ['Histórico 2026-11', 'Histórico 2026-12']);
  assert.equal(g.tabs.get('Histórico 2026-11').length, 2);
  await a.flush(); // sem novidades: não regrava nem duplica
  assert.equal(g.tabs.get('Histórico 2026-11').length, 2);

  const b = mk(g); const r = await b.init();
  assert.equal(r.historyEntries, 2);
  assert.deepEqual(b.audit.months(), ['2026-12', '2026-11']);
  const e = b.audit.query({ month: '2026-11' })[0];
  assert.equal(e.action, 'draft.save');
  assert.deepEqual(e.after, [shift('09:00', '10:00')]);
  assert.equal(e.day, 2);
});

test('gerador: configuração (escala padrão e personalizada) vai e volta', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.genConfig.set('t@x.com', { taskId: 'W1', updatedBy: 'u', agents: {
    'a@x.com': { scaleId: 'EP01', custom: null },
    'b@x.com': { scaleId: null, custom: { weekdays: '2345', entry: 11 * 60, lunch: 15 * 60, snack: 18 * 60, snackDur: 15, exit: 20 * 60 + 30 } },
    'c@x.com': { scaleId: null, custom: { weekdays: '34567', entry: 7 * 60, lunch: null, snack: 11 * 60, snackDur: 45, exit: 13 * 60 + 20 } },
  } });
  await a.flush();
  const b = mk(g); await b.init();
  const cfg = await b.genConfig.get('t@x.com');
  assert.equal(cfg.taskId, 'W1');
  assert.deepEqual(cfg.agents['a@x.com'], { scaleId: 'EP01', custom: null });
  assert.deepEqual(cfg.agents['b@x.com'].custom, { weekdays: '2345', entry: 660, lunch: 900, snack: 1080, snackDur: 15, exit: 1230 });
  assert.equal(cfg.agents['c@x.com'].custom.lunch, null);
});

test('falha de gravação não perde nada: o próximo flush regrava', async () => {
  const g = fakeGateway();
  const a = createSheetsRepo({ gateway: g, debounceMs: 60_000 });
  a.persister.lastError = null;
  a.drafts.saveDay({ team: 't', month: '2026-11', email: 'a@x.com', day: 2, after: [shift('09:00', '10:00')], published: [], user: 'u', version: 0 });
  g.fail = 1;
  await a.flush(); // falha (cota)
  assert.ok(a.persister.lastError);
  assert.equal(g.tabs.get('Rascunhos')?.length ?? 0, 1); // só o cabeçalho criado pelo ensure; nada gravado
  assert.ok(a.persister.pending());
  await a.flush();
  assert.equal(a.persister.lastError, null);
  assert.equal(g.tabs.get('Rascunhos').length, 2);
});

test('somente leitura: sem SHEETS_WRITE nada é gravado e as capacidades ficam desligadas', async () => {
  const g = fakeGateway({ writable: false });
  const a = mk(g);
  assert.deepEqual(await a.init(), { writable: false });
  assert.equal(a.readOnly, true);
  assert.ok(Object.values(a.capabilities).every((v) => v === false));
  await assert.rejects(() => a.genConfig.set('t', {}), (e) => e.status === 503);
  a.audit.log({ ts: '2026-11-13T10:00:00.000Z', actor: 'u', action: 'draft.save' });
  assert.equal(g.tabs.size, 0);
});

test('capacidades com escrita ligada: só rascunhos, gerador e histórico (o resto continua desligado)', () => {
  const a = mk(fakeGateway());
  assert.deepEqual(a.capabilities, { drafts: true, generator: true, audit: true, checkout: true, timeoffs: true, access: true, exports: true });
});

test('serialização: helpers puros', () => {
  assert.equal(historyRow({ ts: 't', action: 'a', before: null, after: [1] })[8], '[1]');
  const big = 'x'.repeat(50000);
  assert.match(historyRow({ ts: 't', action: 'a', after: big })[8], /truncado/);
  const m = new Map(); loadGenConfig(m, genConfigToMatrix(new Map([['t', { taskId: 'W', agents: {} }]])));
  assert.equal(m.get('t').taskId, 'W');
});
