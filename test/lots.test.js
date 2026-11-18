// Etapa B: folga em lote (loteId em FolgasPedidos) e feriados (aba Feriados).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsRepo } from '../server/data/sheetsRepo.js';
import { createMockRepo } from '../server/data/mockRepo.js';
import { holidaysFor, normalizeDate, parseHolidays } from '../server/data/holidays.js';
import { groupLots, lotStatusOfPedido, mergeTimeoffView, pedidosToLotRows } from '../server/data/timeoffView.js';

function fakeGateway() {
  const tabs = new Map();
  let writes = 0;
  return {
    writable: true, tabs, get writes() { return writes; },
    async readTab(n) { return structuredClone(tabs.get(n) ?? []); },
    async listTabs() { return [...tabs.keys()]; },
    async ensureTab(n, h) { if (!tabs.get(n)?.length) tabs.set(n, [h]); },
    async replaceTab(n, m) { writes++; tabs.set(n, structuredClone(m)); },
    async appendRows(n, rows) { tabs.set(n, [...(tabs.get(n) ?? []), ...structuredClone(rows)]); },
  };
}
const mk = (g) => createSheetsRepo({ gateway: g, debounceMs: 60_000 });
const folga = (n, email, over = {}) => ({ id: `f${n}`, email, reasonId: 'R1', reasonName: 'Holiday', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00', status: 'agendada', origin: 'app', createdAt: '2026-11-17T10:00:00.000Z', scheduledAt: '2026-11-17T10:02:00.000Z', createdBy: 'sup@x.com', loteId: 'L1', ...over });

test('lote: addMany grava todas as folgas numa só gravação da aba, com loteId, e sobrevive ao reinício', async () => {
  const g = fakeGateway(); g.tabs.set('FolgasPedidos', [['id']]);
  const a = mk(g); await a.init();
  const before = g.writes;
  await a.timeoffs.addMany([folga(1, 'a@x.com'), folga(2, 'b@x.com'), folga(3, 'c@x.com')]);
  assert.equal(g.writes - before, 1); // uma gravação, não três
  const tab = g.tabs.get('FolgasPedidos');
  assert.equal(tab[0].at(-1), 'loteId'); // coluna no fim: o Apps Script lê por nome
  assert.deepEqual(tab.slice(1).map((r) => [r[0], r[2], r.at(-1)]), [['f1', 'a@x.com', 'L1'], ['f2', 'b@x.com', 'L1'], ['f3', 'c@x.com', 'L1']]); // mesma ordem do pedido
  const b = mk(g); assert.equal((await b.init()).pedidos, 3);
  const lots = await b.timeoffs.lots();
  assert.equal(lots.length, 1); assert.equal(lots[0].items.length, 3);
});

test('lote: a visão traz o loteId e o resumo conta enviadas, agendadas, erros e canceladas', async () => {
  const g = fakeGateway(); g.tabs.set('FolgasPedidos', [['id']]);
  const a = mk(g); await a.init();
  await a.timeoffs.addMany([folga(1, 'a@x.com'), folga(2, 'b@x.com'), folga(3, 'c@x.com'), folga(4, 'd@x.com')]);
  assert.equal((await a.timeoffs.list())[0].loteId, 'L1');
  const peds = g.tabs.get('FolgasPedidos');
  assert.equal(await a.timeoffs.removeMany(['f3', 'f4', 'inexistente']), 2); // só as agendadas; uma gravação
  assert.deepEqual(peds.length, 5);
  const rows = pedidosToLotRows([
    { id: 'p1', tipo: 'criar', agentEmail: 'a@x.com', status: 'enviada', loteId: 'L9' }, { id: 'p2', tipo: 'criar', agentEmail: 'b@x.com', status: 'duplicada', loteId: 'L9' },
    { id: 'p3', tipo: 'criar', agentEmail: 'c@x.com', status: 'erro', loteId: 'L9' }, { id: 'p4', tipo: 'criar', agentEmail: 'd@x.com', status: 'agendada', loteId: 'L9' },
    { id: 'p5', tipo: 'criar', agentEmail: 'e@x.com', status: 'cancelada', loteId: 'L9' }, { id: 'p6', tipo: 'aprovar', agentEmail: 'e@x.com', status: 'enviada', loteId: 'L9' }, // não é "criar": fora
    { id: 'p7', tipo: 'criar', agentEmail: 'f@x.com', status: 'enviada', loteId: '' }, // sem lote: fora
  ]);
  const [lot] = groupLots(rows);
  assert.equal(lot.items.length, 5);
  assert.deepEqual(lot.items.map((i) => i.status), ['enviada', 'enviada', 'erro', 'agendada', 'cancelada']);
  assert.equal(lotStatusOfPedido('duplicada'), 'enviada');
});

test('lote: cancelar o lote não toca nas já enviadas (removeMany só cancela as agendadas)', async () => {
  const g = fakeGateway(); g.tabs.set('FolgasPedidos', [['id']]);
  const a = mk(g); await a.init();
  await a.timeoffs.addMany([folga(1, 'a@x.com'), folga(2, 'b@x.com')]);
  // simula o Apps Script ter enviado a primeira
  const tab = g.tabs.get('FolgasPedidos'); tab[1][8] = 'enviada'; tab[1][12] = 'ext1';
  const b = mk(g); await b.init();
  assert.equal(await b.timeoffs.removeMany(['f1', 'f2']), 1);
  const lot = (await b.timeoffs.lots())[0];
  assert.deepEqual(lot.items.map((i) => i.status).sort(), ['cancelada', 'enviada']);
});

test('mock: lote com addMany, resumo e cancelamento', async () => {
  const r = createMockRepo({});
  await r.timeoffs.addMany([folga(1, 'a@x.com'), folga(2, 'b@x.com')]);
  assert.equal((await r.timeoffs.lots())[0].items.length, 2);
  assert.equal(await r.timeoffs.removeMany(['f1']), 1);
  assert.deepEqual((await r.timeoffs.lots())[0].items.map((i) => i.status).sort(), ['agendada', 'cancelada']);
});

test('mergeTimeoffView: a linha criada pelo lote leva o loteId', () => {
  const v = mergeTimeoffView([], [{ id: 'p1', tipo: 'criar', agentEmail: 'a@x.com', reasonId: 'R', reasonName: 'N', startTime: 's', endTime: 'e', status: 'agendada', createdAt: '2026-11-17T10:00:00Z', scheduledAt: 'x', createdBy: 'u', loteId: 'L1' }]);
  assert.equal(v[0].loteId, 'L1');
});

test('feriados: data como número de série, texto ISO ou dd/mm/aaaa; sem repetidos; ordenado', () => {
  assert.equal(normalizeDate(46346), '2026-11-20'); // 20/11/2026 em número de série do Sheets
  assert.equal(normalizeDate('2026-11-20'), '2026-11-20');
  assert.equal(normalizeDate('20/11/2026'), '2026-11-20');
  assert.equal(normalizeDate('x'), '');
  const list = parseHolidays([
    ['data', 'nome', 'tipo', 'origem', 'time'],
    ['2026-11-20', 'Consciência Negra', 'nacional', 'google', ''],
    [46341, 'Proclamação da República', 'nacional', 'google', ''], // 15/11/2026
    ['2026-11-20', 'consciência negra', 'nacional', 'google', ''], // repetido
    ['2026-11-25', 'Aniversário da cidade', 'municipal', 'municipal', 'sup.alfa@x.com'],
    ['', 'Sem data', '', '', ''],
    ['2026-12-24', 'Recesso', '', '', '*'],
  ]);
  assert.deepEqual(list.map((h) => h.date + ' ' + h.name), ['2026-11-15 Proclamação da República', '2026-11-20 Consciência Negra', '2026-11-25 Aniversário da cidade', '2026-12-24 Recesso']);
  assert.deepEqual([list[3].type, list[3].source, list[3].team], ['nacional', 'manual', '']); // vazios assumem padrão; * = todos
});

test('feriados do mês: vale para o time, e data comemorativa não vira sugestão', () => {
  const list = [
    { date: '2026-11-15', name: 'Proclamação', type: 'nacional', source: 'google', team: '' },
    { date: '2026-11-25', name: 'Aniversário da cidade', type: 'municipal', source: 'municipal', team: 'sup.alfa@x.com' },
    { date: '2026-11-10', name: 'Dia dos Pais', type: 'comemorativa', source: 'google', team: '' },
    { date: '2026-12-25', name: 'Natal', type: 'nacional', source: 'google', team: '' },
  ];
  assert.deepEqual(holidaysFor(list, 'sup.alfa@x.com', '2026-11').map((h) => h.name), ['Proclamação', 'Aniversário da cidade']);
  assert.deepEqual(holidaysFor(list, 'sup.beta@x.com', '2026-11').map((h) => h.name), ['Proclamação']); // municipal de outro time não vale
});

test('feriados na planilha: aba inexistente = lista vazia; aba preenchida é lida', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  assert.deepEqual(await a.holidays.list(), []);
  g.tabs.set('Feriados', [['data', 'nome', 'tipo', 'origem', 'time'], ['2026-11-20', 'Consciência Negra', 'nacional', 'google', '']]);
  const b = mk(g); await b.init();
  assert.equal((await b.holidays.list())[0].name, 'Consciência Negra');
});
