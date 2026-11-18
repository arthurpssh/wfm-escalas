// Dias extras e trocas: regras puras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extraDays, isExtraDay } from '../server/core/extras.js';
import { expiredIds, swapOps, swapWarnings, validateSwap } from '../server/core/swaps.js';
import { configToShifts } from '../shared/rules.js';
import { CTX } from '../server/mockData.js';

const T = [...CTX.tasks.keys()][0];
const LUNCH = CTX.lunch.taskId;
const cfg = { taskId: T, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 }; // 09:00 a 18:00
const day = (date, c = cfg) => configToShifts(c, date, CTX);
// 2026-11-21 é sábado, 22 domingo, 23 segunda, 20 sexta
const SEG_SEX = '23456';

test('dia extra: turno em dia da semana fora da escala padrão; sem escala padrão definida, nada é extra', () => {
  const cells = { 'a@x.com': { 20: day('2026-11-20'), 21: day('2026-11-21'), 22: [] }, 'b@x.com': { 21: day('2026-11-21') } };
  const ex = extraDays({ month: '2026-11', cells, weekdays: { 'a@x.com': SEG_SEX, 'b@x.com': '' } });
  assert.deepEqual(ex, { 'a@x.com': { 21: true } }); // sábado de quem é seg-sex; a sexta não; b sem escala padrão: nada
  assert.equal(isExtraDay(day('2026-11-21'), SEG_SEX, '2026-11-21'), true);
  assert.equal(isExtraDay(day('2026-11-23'), SEG_SEX, '2026-11-23'), false);
  assert.equal(isExtraDay([], SEG_SEX, '2026-11-21'), false); // sem turno não é dia extra
  assert.equal(isExtraDay(day('2026-11-21'), '2345678', '2026-11-21'), false);
});

// ---- cenário: João (seg-sex) trabalha no sábado 21 (extra); Maria (seg-sex) está livre no sábado 21 e tem um domingo extra 22
const world = (over = {}) => {
  const sched = { 'joao@x.com': { '2026-11-21': day('2026-11-21'), '2026-11-23': day('2026-11-23') }, 'maria@x.com': { '2026-11-22': day('2026-11-22'), '2026-11-23': day('2026-11-23') }, ...over.sched };
  return {
    today: '2026-11-17', team: new Set(['joao@x.com', 'maria@x.com', 'pedro@x.com']), shiftsOn: (e, d) => sched[e]?.[d] ?? [],
    weekdaysOf: () => SEG_SEX, timeoffOn: (e, d) => (over.timeoff ?? []).includes(`${e}|${d}`), openSwaps: over.open ?? [],
  };
};
const req = { requester: 'maria@x.com', owner: 'joao@x.com', date: '2026-11-21' };

test('pedido válido: assumir o dia extra do colega, com ou sem oferta em troca (a oferta é opcional)', () => {
  assert.deepEqual(validateSwap(req, world()), []);
  assert.deepEqual(validateSwap({ ...req, offerDate: '2026-11-22' }, world()), []);
});

test('pedido inválido: cada regra com a sua mensagem', () => {
  const w = world();
  assert.match(validateSwap({ ...req, owner: 'maria@x.com' }, w).join(' '), /com você mesmo/);
  assert.match(validateSwap({ ...req, owner: 'zeca@x.com' }, w).join(' '), /mesmo time/);
  assert.match(validateSwap({ ...req, date: '2026-11-17' }, w).join(' '), /futuro/);
  assert.match(validateSwap({ ...req, date: '2026-11-23' }, w).join(' '), /não é um dia extra do colega/); // segunda é do padrão do João
  assert.match(validateSwap(req, world({ sched: { 'maria@x.com': { '2026-11-21': day('2026-11-21') } } })).join(' '), /já está escalado no dia 21\/11/);
  assert.match(validateSwap(req, world({ timeoff: ['maria@x.com|2026-11-21'] })).join(' '), /folga no dia 21\/11/);
  assert.match(validateSwap(req, world({ open: [{ id: 'x', status: 'pendente_agente', owner: 'joao@x.com', requester: 'pedro@x.com', date: '2026-11-21' }] })).join(' '), /pedido em aberto/);
  assert.deepEqual(validateSwap(req, world({ open: [{ id: 'x', status: 'recusada', owner: 'joao@x.com', requester: 'pedro@x.com', date: '2026-11-21' }] })), []); // encerrado não conta
  assert.deepEqual(validateSwap(req, world({ open: [{ id: 'self', status: 'pendente_agente', owner: 'joao@x.com', requester: 'maria@x.com', date: '2026-11-21' }] }), 'self'), []); // revalidar a própria troca
});

test('oferta: precisa ser dia extra de quem pede, livre para o colega, e não estar em outro pedido', () => {
  const w = world();
  assert.match(validateSwap({ ...req, offerDate: '2026-11-23' }, w).join(' '), /não é um dia extra seu/); // segunda é do padrão da Maria
  assert.match(validateSwap({ ...req, offerDate: '2026-11-21' }, w).join(' '), /diferente do dia pedido/);
  assert.match(validateSwap({ ...req, offerDate: '2026-11-22' }, world({ sched: { 'joao@x.com': { '2026-11-21': day('2026-11-21'), '2026-11-22': day('2026-11-22') } } })).join(' '), /colega já está escalado no dia 22\/11/);
  assert.match(validateSwap({ ...req, offerDate: '2026-11-22' }, world({ timeoff: ['joao@x.com|2026-11-22'] })).join(' '), /colega tem folga no dia 22\/11/);
  assert.match(validateSwap({ ...req, offerDate: '2026-11-22' }, world({ open: [{ id: 'y', status: 'pendente_supervisor', requester: 'maria@x.com', owner: 'pedro@x.com', date: '2026-11-28', offerDate: '2026-11-22' }] })).join(' '), /já está em outro pedido/);
});

test('o que a troca muda: o dono sai do dia, quem pediu entra com os mesmos turnos; com oferta, o inverso no outro dia', () => {
  const w = world();
  const ops = swapOps(req, w.shiftsOn);
  assert.deepEqual(ops.map((o) => [o.email, o.date, o.after.length]), [['joao@x.com', '2026-11-21', 0], ['maria@x.com', '2026-11-21', 5]]);
  assert.equal(ops[1].after[0].startTime, '2026-11-21T09:00:00-03:00');
  const ops2 = swapOps({ ...req, offerDate: '2026-11-22' }, w.shiftsOn);
  assert.deepEqual(ops2.map((o) => [o.email, o.date, o.after.length]), [['joao@x.com', '2026-11-21', 0], ['maria@x.com', '2026-11-21', 5], ['maria@x.com', '2026-11-22', 0], ['joao@x.com', '2026-11-22', 5]]);
  ops[1].after[0].taskId = 'mudou'; assert.notEqual(w.shiftsOn('joao@x.com', '2026-11-21')[0].taskId, 'mudou'); // cópia, não referência
});

test('avisos para a supervisão: interjornada, dias seguidos e carga semanal (almoço não conta)', () => {
  const nameOf = (e) => e.split('@')[0];
  const tarde = day('2026-11-20', { ...cfg, entry: 840, lunch: null, snack: 1200, snackDur: 45, exit: 1439 }); // 14:00 a 23:59
  const manha = day('2026-11-21', { ...cfg, entry: 360, lunch: null, snack: 480, snackDur: 45, exit: 900 }); // 06:00 a 15:00
  const ops = [{ email: 'maria@x.com', date: '2026-11-21', after: manha }];
  const w = swapWarnings({ ops, shiftsOn: (e, d) => (e === 'maria@x.com' && d === '2026-11-20' ? tarde : []), lunchTaskId: LUNCH, nameOf });
  assert.equal(w.length, 1); assert.match(w[0], /maria: só 6 h01 de descanso entre 20\/11 e 21\/11/);
  // 7 dias seguidos
  const sched = Object.fromEntries(['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'].map((d) => [d, day(d)]));
  const w2 = swapWarnings({ ops: [{ email: 'maria@x.com', date: '2026-11-21', after: day('2026-11-21') }], shiftsOn: (e, d) => sched[d] ?? [], lunchTaskId: LUNCH, nameOf });
  assert.ok(w2.some((t) => /7 dias seguidos/.test(t)));
  // carga semanal: 6 dias de 8h (9h - almoço) = 48 h > 44 h; semana de segunda 16/11 a domingo 22/11
  assert.ok(w2.some((t) => /48 h00 trabalhadas na semana de 16\/11/.test(t)));
  // sem problemas: nenhum aviso
  assert.deepEqual(swapWarnings({ ops: [{ email: 'maria@x.com', date: '2026-11-21', after: day('2026-11-21') }], shiftsOn: () => [], lunchTaskId: LUNCH, nameOf }), []);
  // quem perde o dia (after vazio) não gera aviso
  assert.deepEqual(swapWarnings({ ops: [{ email: 'joao@x.com', date: '2026-11-21', after: [] }], shiftsOn: () => [], lunchTaskId: LUNCH, nameOf }), []);
});

test('expiram as trocas em aberto cujo dia (ou o dia oferecido) chegou', () => {
  const s = [
    { id: '1', status: 'pendente_agente', date: '2026-11-21' }, { id: '2', status: 'pendente_supervisor', date: '2026-11-17' },
    { id: '3', status: 'pendente_agente', date: '2026-11-25', offerDate: '2026-11-18' }, { id: '4', status: 'consolidada', date: '2026-11-10' }, { id: '5', status: 'recusada', date: '2026-11-01' },
  ];
  assert.deepEqual(expiredIds(s, '2026-11-18'), ['2', '3']);
});
