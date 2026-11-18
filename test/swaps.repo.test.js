// Trocas: gravação na aba Trocas (sobrevive ao reinício), mock e dias extras no portal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsRepo } from '../server/data/sheetsRepo.js';
import { createMockRepo } from '../server/data/mockRepo.js';
import { loadSwaps, swapsToMatrix } from '../server/data/persist.js';
import { buildPortalSchedule } from '../server/core/portal.js';
import { configToShifts } from '../shared/rules.js';
import { CTX } from '../server/mockData.js';

function fakeGateway() {
  const tabs = new Map();
  return {
    writable: true, tabs,
    async readTab(n) { return structuredClone(tabs.get(n) ?? []); },
    async listTabs() { return [...tabs.keys()]; },
    async ensureTab(n, h) { if (!tabs.get(n)?.length) tabs.set(n, [h]); },
    async replaceTab(n, m) { tabs.set(n, structuredClone(m)); },
    async appendRows(n, rows) { tabs.set(n, [...(tabs.get(n) ?? []), ...structuredClone(rows)]); },
  };
}
const mk = (g) => createSheetsRepo({ gateway: g, debounceMs: 60_000 });
const swap = (over = {}) => ({ id: 's1', team: 'sup@x.com', requester: 'maria@x.com', owner: 'joao@x.com', date: '2026-11-21', offerDate: '', status: 'pendente_agente', refusedBy: '', createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:00.000Z', decidedBy: '', note: '', ...over });

test('planilha: troca grava na aba Trocas, atualiza e sobrevive ao reinício', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.swaps.add(swap());
  await a.swaps.add(swap({ id: 's2', date: '2026-11-28', offerDate: '2026-11-22' }));
  assert.deepEqual(g.tabs.get('Trocas').slice(1).map((r) => [r[0], r[2], r[3], r[4], r[5], r[6]]), [['s2', 'maria@x.com', 'joao@x.com', '2026-11-28', '2026-11-22', 'pendente_agente'], ['s1', 'maria@x.com', 'joao@x.com', '2026-11-21', '', 'pendente_agente']]);
  const upd = await a.swaps.update('s1', { status: 'recusada', refusedBy: 'agente', updatedAt: '2026-11-17T11:00:00.000Z' });
  assert.equal(upd.status, 'recusada');
  assert.equal(await a.swaps.update('nao-existe', { status: 'x' }), null);
  const b = mk(g); await b.init();
  const list = await b.swaps.list();
  assert.equal(list.length, 2);
  assert.deepEqual([(await b.swaps.get('s1')).status, (await b.swaps.get('s1')).refusedBy, (await b.swaps.get('s2')).offerDate], ['recusada', 'agente', '2026-11-22']);
  assert.equal(a.capabilities.swaps, true);
});

test('planilha somente leitura: trocas vazias e sem gravar', async () => {
  const g = { ...fakeGateway(), writable: false };
  const a = mk(g);
  assert.deepEqual(await a.swaps.list(), []);
  await assert.rejects(() => a.swaps.add(swap()), /Escrita/);
});

test('serialização: ida e volta, e-mails em minúsculas e data só com 10 caracteres', () => {
  const m = swapsToMatrix([swap({ note: 'x'.repeat(2000) })]);
  assert.equal(m[1][11].length, 1000); // nota limitada
  const back = loadSwaps([m[0], ['s9', 't', 'MARIA@X.com', 'Joao@x.com', '2026-11-21T00:00:00', '', 'consolidada', '', '', '', 'sup@x.com', '']]);
  assert.deepEqual([back[0].requester, back[0].owner, back[0].date, back[0].status], ['maria@x.com', 'joao@x.com', '2026-11-21', 'consolidada']);
  assert.deepEqual(loadSwaps([m[0], ['']]), []); // linha sem id é ignorada
});

test('mock: trocas em memória, e reset limpa', async () => {
  const r = createMockRepo({});
  await r.swaps.add(swap());
  assert.equal((await r.swaps.get('s1')).status, 'pendente_agente');
  await r.swaps.update('s1', { status: 'consolidada' });
  assert.equal((await r.swaps.list())[0].status, 'consolidada');
  await r.reset();
  assert.deepEqual(await r.swaps.list(), []);
});

test('portal: o dia extra sai por id do colega (sem e-mail) e só onde há turno', () => {
  const T = [...CTX.tasks.keys()][0];
  const cfg = { taskId: T, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 };
  const cells = { 'a@x.com': { 21: configToShifts(cfg, '2026-11-21', CTX) }, 'b@x.com': {} };
  const v = buildPortalSchedule({ agents: [{ id: 1, email: 'a@x.com', name: 'Ana' }, { id: 2, email: 'b@x.com', name: 'Bia' }], self: 'b@x.com', month: '2026-11', cells, timeoffs: [], extra: { 'a@x.com': { 21: true } } });
  assert.deepEqual(v.extra, { 2: {}, 1: { 21: true } });
  assert.ok(!JSON.stringify(v).includes('@x.com'));
});
