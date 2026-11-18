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

// ---------- etapa A: avisos em vez de bloqueios, pausas em qualquer ordem, saída às 24:00 ----------
import { checkConfig, validateDefinition, checkDefinition, exitFromInput, exitToInput, toIso, isoMinOn } from '../shared/rules.js';

test('snack antes do almoço é aviso (não bloqueia) e as pausas saem em ordem de horário', () => {
  const c = { ...long, snack: 600, lunch: 780 }; // snack 10:00, almoço 13:00
  const r = checkConfig(c);
  assert.deepEqual(r.erros, []);
  assert.ok(r.avisos.some((a) => a.includes('snack começa antes do almoço')));
  const shifts = configToShifts(c, '2026-11-10', CTX);
  assert.deepEqual(shifts.map((s) => s.startTime.slice(11, 16)), ['09:00', '10:00', '10:15', '13:00', '14:00']);
  assert.deepEqual(shifts.map((s) => s.endTime.slice(11, 16)), ['10:00', '10:15', '13:00', '14:00', '18:00']);
  assert.equal(shifts.at(-1).taskId, shifts[0].taskId);
  const back = shiftsToConfig(shifts, CTX);
  assert.equal(back.irregular, false); assert.deepEqual(back.config, c); // ida e volta
});

test('o que gera CSV impossível continua bloqueando', () => {
  assert.ok(checkConfig({ ...long, lunch: 780, snack: 790 }).erros.some((e) => e.includes('se sobrepõem'))); // snack dentro do almoço
  assert.ok(checkConfig({ ...long, snack: 1070 }).erros.some((e) => e.includes('terminar antes da saída'))); // snack passa da saída
  assert.ok(checkConfig({ ...long, snack: 500 }).erros.some((e) => e.includes('começar depois da entrada')));
  assert.ok(checkConfig({ ...long, exit: 500 }).erros.some((e) => e.includes('saída deve ser depois')));
  assert.ok(checkConfig({ ...long, snackDur: 0 }).erros.some((e) => e.includes('maior que zero')));
  assert.ok(checkConfig({ ...long, taskId: '' }).erros.length);
});

test('avisos: pausa colada na saída, jornada longa sem almoço, jornada acima de 10h', () => {
  assert.ok(checkConfig({ ...long, snack: 1065 }).avisos.some((a) => a.includes('snack termina junto com a saída')));
  assert.deepEqual(checkConfig({ ...long, snack: 1065 }).erros, []);
  assert.ok(checkConfig({ ...long, lunch: null }).avisos.some((a) => a.includes('sem almoço')));
  assert.ok(checkConfig({ ...long, exit: 1200 }).avisos.some((a) => a.includes('acima de 10h')));
  assert.deepEqual(checkConfig(long), { erros: [], avisos: [] });
  const def = { weekdays: '23456', entry: 540, lunch: 780, snack: 600, snackDur: 15, exit: 1080 };
  assert.deepEqual(validateDefinition(def), []); // compatibilidade: só os erros
  assert.ok(checkDefinition(def).avisos.length);
});

test('saída às 24:00: 00:00 do dia seguinte, ida e volta, entrada de hora e cobertura de folga', () => {
  assert.equal(toIso('2027-04-15', 1440), '2027-04-16T00:00:00-03:00');
  assert.equal(toIso('2027-04-30', 1440), '2027-05-01T00:00:00-03:00'); // vira o mês
  assert.equal(toIso('2027-04-15', 600), '2027-04-15T10:00:00-03:00');
  assert.equal(exitFromInput(0), 1440); assert.equal(exitFromInput(1080), 1080); assert.equal(exitFromInput(null), null);
  assert.equal(exitToInput(1440), 0); assert.equal(exitToInput(1080), 1080);
  assert.equal(isoMinOn('2027-04-16T00:00:00-03:00', '2027-04-15'), 1440);
  const c = { ...long, entry: 840, lunch: null, snack: 1200, snackDur: 45, exit: 1440 }; // 14:00 a 24:00
  assert.deepEqual(checkConfig(c).erros, []);
  const shifts = configToShifts(c, '2027-04-15', CTX);
  assert.equal(shifts.at(-1).endTime, '2027-04-16T00:00:00-03:00');
  const back = shiftsToConfig(shifts, CTX);
  assert.equal(back.irregular, false); assert.equal(back.config.exit, 1440); assert.equal(back.config.entry, 840);
  // folga até o fim do dia cobre tudo (full), não "parcial", mesmo com o turno terminando à meia-noite
  const tf = [{ startTime: '2027-04-15T00:00:00-03:00', endTime: '2027-04-15T23:59:59-03:00' }];
  assert.equal(coverage(shifts, '2027-04-15', tf), 'full');
  assert.ok(checkConfig({ ...c, exit: 1500 }).erros.some((e) => e.includes('24:00')));
});

test('turno que vira o dia de verdade (22:00 a 02:00) é lido, mas marcado como fora do padrão editável', () => {
  const shifts = [{ taskType: 'workstream', taskId: T, taskName: 'x', startTime: '2027-04-16T22:00:00-03:00', endTime: '2027-04-17T02:00:00-03:00' }];
  const { config, irregular } = shiftsToConfig(shifts, CTX);
  assert.equal(irregular, true); assert.equal(config.exit, 26 * 60);
});
