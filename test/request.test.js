// Pedido de folga do agente (portal): nasce "solicitar", vai ao WFM como pendente, o agente cancela até o supervisor decidir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsRepo } from '../server/data/sheetsRepo.js';
import { createMockRepo } from '../server/data/mockRepo.js';
import { mergeTimeoffView } from '../server/data/timeoffView.js';
import { cancelableByAgent, ownTimeoffs } from '../server/core/portal.js';

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
const pedido = (over = {}) => ({ id: 'r1', tipo: 'solicitar', agentEmail: 'a@x.com', reasonId: 'R1', reasonName: 'Day Off', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00', status: 'agendada', createdAt: '2026-11-17T10:00:00.000Z', scheduledAt: '2026-11-17T10:02:00.000Z', createdBy: 'a@x.com', externalId: '', note: '', loteId: '', ...over });
const wfmRow = (over = {}) => ({ id: 'w1', email: 'a@x.com', reasonId: 'R1', reasonName: 'Day Off', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00', status: 'pendente', createdAt: '', externalId: 'w1', createdBy: 'a@x.com', origin: 'agent', ...over });

test('visão: pedido do agente na carência aparece como agendada+request; enviado vira PENDENTE (não aprovada); erro e cancelado', () => {
  const [ag] = mergeTimeoffView([], [pedido()]);
  assert.deepEqual([ag.status, ag.request, ag.origin, ag.createdBy], ['agendada', true, 'agent', 'a@x.com']);
  assert.equal(mergeTimeoffView([], [pedido({ status: 'enviada' })])[0].status, 'pendente');
  assert.equal(mergeTimeoffView([], [pedido({ status: 'duplicada' })])[0].status, 'pendente');
  assert.equal(mergeTimeoffView([], [pedido({ status: 'erro' })])[0].status, 'erro');
  assert.equal(mergeTimeoffView([], [pedido({ status: 'cancelada' })]).length, 0);
  // folga criada pela supervisão continua aprovada ao ser enviada
  const sup = mergeTimeoffView([], [{ ...pedido({ tipo: 'criar', status: 'enviada' }) }])[0];
  assert.deepEqual([sup.status, sup.request, sup.origin], ['aprovada', false, 'app']);
});

test('visão: quando a extração traz a folga pendente do WFM, o pedido some (sem duplicar)', () => {
  const v = mergeTimeoffView([wfmRow()], [pedido({ status: 'enviada', externalId: 'w1' })]);
  assert.equal(v.length, 1); assert.equal(v[0].id, 'w1');
});

test('planilha: solicitar grava tipo "solicitar", cancela na carência e o histórico fica como "cancelada"', async () => {
  const g = fakeGateway(); g.tabs.set('FolgasPedidos', [['id']]);
  const a = mk(g); await a.init();
  await a.timeoffs.add({ id: 'r1', email: 'a@x.com', reasonId: 'R1', reasonName: 'Day Off', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00', status: 'agendada', request: true, createdAt: '2026-11-17T10:00:00.000Z', scheduledAt: '2026-11-17T10:02:00.000Z', createdBy: 'a@x.com' });
  assert.equal(g.tabs.get('FolgasPedidos')[1][1], 'solicitar');
  assert.equal((await a.timeoffs.get('r1')).request, true);
  await a.timeoffs.remove('r1');
  assert.equal(g.tabs.get('FolgasPedidos')[1][8], 'cancelada');
  assert.equal((await a.timeoffs.list()).length, 0);
  // e o pedido normal da supervisão segue "criar"
  await a.timeoffs.add({ id: 'c1', email: 'a@x.com', reasonId: 'R1', reasonName: 'Day Off', startTime: '2026-11-21T00:00:00-03:00', endTime: '2026-11-21T23:59:59-03:00', status: 'agendada', scheduledAt: 'x', createdBy: 's@x.com' });
  assert.equal(g.tabs.get('FolgasPedidos')[1][1], 'criar');
});

test('planilha: cancelar pedido já no WFM = pedido "negar" por id, e a linha passa a negada', async () => {
  const g = fakeGateway();
  g.tabs.set('FolgasPedidos', [['id']]);
  g.tabs.set('TimeOffs', [['id', 'agentEmail', 'reasonId', 'reasonName', 'startTime', 'endTime', 'status', 'createdAt', 'scheduledAt', 'externalId', 'createdBy'], ['w1', 'a@x.com', 'R1', 'Day Off', '2026-11-20T00:00:00-03:00', '2026-11-20T23:59:59-03:00', 'pendente', '', '', 'w1', 'a@x.com']]);
  const a = mk(g); await a.init();
  const r = await a.timeoffs.update('w1', { status: 'negada', decidedBy: 'a@x.com' });
  assert.equal(r.status, 'negada');
  const neg = g.tabs.get('FolgasPedidos')[1];
  assert.deepEqual([neg[1], neg[7], neg[2]], ['negar', 'w1', 'a@x.com']);
  assert.equal(await a.timeoffs.update('inexistente', { status: 'negada' }), null); // pedido que ainda não voltou na extração: o servidor responde 409
});

test('mock: o pedido do agente, passada a carência, vira pendente (nunca aprovado)', async () => {
  const r = createMockRepo({});
  await r.timeoffs.add({ id: 'q1', email: 'a@x.com', reasonId: 'R', reasonName: 'N', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00', status: 'agendada', request: true, scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await r.timeoffs.add({ id: 'q2', email: 'a@x.com', reasonId: 'R', reasonName: 'N', startTime: '2026-11-21T00:00:00-03:00', endTime: '2026-11-21T23:59:59-03:00', status: 'agendada', scheduledAt: new Date(Date.now() - 1000).toISOString() });
  await r.tick();
  assert.equal((await r.timeoffs.get('q1')).status, 'pendente');
  assert.equal((await r.timeoffs.get('q2')).status, 'aprovada');
});

test('portal: o agente só pode cancelar o que ainda aguarda decisão (carência ou pendente no WFM)', () => {
  assert.equal(cancelableByAgent({ request: true, status: 'agendada' }), true);
  assert.equal(cancelableByAgent({ status: 'pendente' }), true);
  assert.equal(cancelableByAgent({ status: 'aprovada' }), false);
  assert.equal(cancelableByAgent({ status: 'negada' }), false);
  assert.equal(cancelableByAgent({ request: false, status: 'agendada' }), false); // agendada pela supervisão: não é pedido do agente
  const list = ownTimeoffs([
    { id: '1', email: 'a@x.com', reasonName: 'Day Off', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00', status: 'agendada', request: true },
    { id: '2', email: 'a@x.com', reasonName: 'Day Off', startTime: '2026-11-21T00:00:00-03:00', endTime: '2026-11-21T23:59:59-03:00', status: 'pendente' },
    { id: '3', email: 'a@x.com', reasonName: 'Day Off', startTime: '2026-11-22T00:00:00-03:00', endTime: '2026-11-22T23:59:59-03:00', status: 'agendada' },
  ], 'a@x.com', '2026-11');
  assert.deepEqual(list.map((t) => [t.id, t.status, t.cancelable]), [['1', 'solicitada', true], ['2', 'pendente', true], ['3', 'agendada', false]]);
});
