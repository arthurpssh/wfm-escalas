import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, configToShifts, shiftsToConfig, coverage, validateConfig } from '../shared/rules.js';
import { CTX } from '../server/mockData.js';

const T = [...CTX.tasks.keys()][0];
const long = { taskId: T, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 }; // 9h

test('jornada >= 9h tem almoço e snack de 15', () => {
  assert.equal(validateConfig(long).length, 0);
  const c = applyEdit({ ...long, lunch: null }, 'exit', 1080);
  assert.notEqual(c.lunch, null);
});
test('jornada < 9h zera almoço e snack vira 45', () => {
  const c = applyEdit(long, 'exit', 1000);
  assert.equal(c.lunch, null); assert.equal(c.snackDur, 45);
});
test('editar entrada com tudo preenchido reposiciona proporcionalmente', () => {
  const c = applyEdit(long, 'entry', 480); // jornada 10h
  assert.equal(c.entry, 480); assert.ok(c.lunch > 480 && c.lunch < 780 + 1); assert.ok(c.snack > c.lunch);
  assert.equal(validateConfig(c).length, 0);
});
test('config -> shifts -> config é idempotente', () => {
  const shifts = configToShifts(long, '2026-11-10', CTX);
  assert.equal(shifts.length, 5);
  const { config, irregular } = shiftsToConfig(shifts, CTX);
  assert.equal(irregular, false); assert.deepEqual(config, long);
});
test('cobertura de folga', () => {
  const shifts = configToShifts(long, '2026-11-10', CTX);
  const to = (s, e) => ({ startTime: s, endTime: e });
  assert.equal(coverage(shifts, '2026-11-10', []), 'none');
  assert.equal(coverage(shifts, '2026-11-10', [to('2026-11-10T14:00:00-03:00', '2026-11-10T16:00:00-03:00')]), 'partial');
  assert.equal(coverage(shifts, '2026-11-10', [to('2026-11-08T00:00:00-03:00', '2026-11-12T23:59:59-03:00')]), 'full');
});

import { timeoffMarks } from '../shared/rules.js';
test('marcas de folga na grade: pedido, agendada, erro, aprovada; vários dias; negada não marca; recorte do mês', () => {
  const tf = (id, email, status, s, e) => ({ id, email, status, reasonName: 'Day Off', startTime: `${s}T00:00:00-03:00`, endTime: `${e}T23:59:59-03:00` });
  const m = timeoffMarks([
    tf('1', 'a@x.com', 'pendente', '2026-11-20', '2026-11-20'),
    tf('2', 'a@x.com', 'agendada', '2026-11-20', '2026-11-20'),
    tf('3', 'a@x.com', 'aprovada', '2026-11-27', '2026-12-03'), // passa do mês: só 27..30
    tf('4', 'b@x.com', 'erro', '2026-10-30', '2026-11-02'), // começa antes: 1..2
    tf('5', 'b@x.com', 'negada', '2026-11-10', '2026-11-10'),
    tf('6', 'b@x.com', 'aprovada', '2026-12-05', '2026-12-06'), // fora do mês
  ], '2026-11', 30);
  assert.deepEqual(Object.keys(m.get('a@x.com')).map(Number), [20, 27, 28, 29, 30]);
  assert.deepEqual(Object.keys(m.get('a@x.com')[20]).sort(), ['agendada', 'decisao']); // as duas no mesmo dia
  assert.equal(m.get('a@x.com')[29].aprovada[0].id, '3');
  assert.deepEqual(Object.keys(m.get('b@x.com')).map(Number), [1, 2]);
  assert.ok(m.get('b@x.com')[1].erro && !m.get('b@x.com')[10]); // negada não marca; dezembro fora
});

import { localDate, localIso, localMonth, toLocalIso } from '../shared/rules.js';
test('fuso do app (-03:00): horários de UTC, "hoje" e "mês atual"', () => {
  assert.equal(toLocalIso('2026-11-16T14:36:00.000Z'), '2026-11-16T11:36'); // o caso da tela de exportações
  assert.equal(toLocalIso('2026-11-16T02:10:00.000Z'), '2026-11-15T23:10'); // vira o dia anterior
  assert.equal(toLocalIso('2026-12-01T01:00:00.000Z'), '2026-11-30T22:00'); // e o mês anterior
  assert.equal(toLocalIso('2026-11-20T00:00:00-03:00'), '2026-11-20T00:00'); // já no fuso do app: não muda
  assert.equal(toLocalIso('2026-11-20T10:00:00+00:00'), '2026-11-20T07:00'); // outro deslocamento: converte
  assert.equal(toLocalIso('2026-11-20T08:30:00'), '2026-11-20T08:30'); // sem fuso: só recorta
  assert.equal(toLocalIso(''), ''); assert.equal(toLocalIso(null), '');
  const t = Date.parse('2026-12-01T01:30:00Z'); // 22:30 de 30/11 em -03:00 (e já 01/12 em UTC)
  assert.deepEqual([localIso(t), localDate(t), localMonth(t)], ['2026-11-30T22:30', '2026-11-30', '2026-11']);
});

import { VERIFY_TTL_MIN, verifyPending, verifyStale } from '../shared/rules.js';
test('verificação pedida: em andamento, respondida e sem resposta (prazo)', () => {
  const now = Date.parse('2026-11-16T15:00:00Z');
  const at = (min) => new Date(now - min * 60000).toISOString();
  const e = (over) => ({ verifyRequestedAt: at(5), lastCheckAt: null, ...over });
  assert.equal(verifyPending(e({}), now), true); // pedido há 5 min, sem resultado
  assert.equal(verifyPending(e({ lastCheckAt: at(2) }), now), false); // já houve resultado depois do pedido
  assert.equal(verifyPending(e({ lastCheckAt: at(20) }), now), true); // resultado ANTIGO (anterior ao pedido): continua esperando
  assert.equal(verifyPending(e({ verifyRequestedAt: null }), now), false); // nunca pediu
  const velho = e({ verifyRequestedAt: at(VERIFY_TTL_MIN + 1) });
  assert.deepEqual([verifyPending(velho, now), verifyStale(velho, now)], [false, true]); // passou do prazo: "sem resposta"
  assert.equal(verifyStale(e({}), now), false);
  assert.equal(verifyStale(e({ lastCheckAt: at(1) }), now), false);
});
