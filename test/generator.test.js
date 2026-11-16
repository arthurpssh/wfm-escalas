import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeekdays, planMonth, validateDefinition, weekdayDigit, weekdaysLabel, weekdaysToString } from '../shared/rules.js';
import { createDraftStore } from '../server/core/drafts.js';
import { noScale, resolveAgentDefinition, rowToDefinition } from '../server/core/scales.js';
import { AGENTS, CTX, STANDARD_SCALES, TEAMS } from '../server/mockData.js';

const task = [...CTX.tasks.keys()][0];
const long = { weekdays: '23456', entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 };

test('dias da semana: dígitos 1=dom..7=sáb, rótulos e dígito de uma data', () => {
  assert.deepEqual([...parseWeekdays('23456')], [2, 3, 4, 5, 6]);
  assert.equal(weekdaysToString(new Set([6, 2, 3])), '236');
  assert.equal(weekdaysLabel('23456'), 'Seg–Sex');
  assert.equal(weekdaysLabel('167'), 'Dom, Sex, Sáb');
  assert.equal(weekdayDigit('2026-11-01'), 1); // domingo
  assert.equal(weekdayDigit('2026-11-02'), 2); // segunda
});

test('planMonth: só os dias marcados, com almoço quando a jornada tem 9h ou mais', () => {
  const plan = planMonth(long, '2026-11', task, CTX);
  assert.equal(Object.keys(plan).length, 21); // seg a sex de nov/2026
  assert.equal(plan[2].length, 5); // trabalho, almoço, trabalho, snack, trabalho
  assert.equal(plan[1], undefined); // domingo fora
  const short = planMonth({ weekdays: '2', entry: 600, lunch: 780, snack: 840, snackDur: 45, exit: 980 }, '2026-11', task, CTX);
  assert.equal(short[2].length, 3); // jornada < 9h ignora o almoço
});

test('validateDefinition: exige dia marcado e respeita as regras de horário', () => {
  assert.deepEqual(validateDefinition(long), []);
  assert.ok(validateDefinition({ ...long, weekdays: '' }).some((e) => e.includes('dia da semana')));
  assert.ok(validateDefinition({ ...long, exit: 500 }).length > 0);
});

test('escalas: vazio, null e "-" significam personalizada; id inexistente cai em personalizada', () => {
  assert.ok(noScale('') && noScale(null) && noScale('-') && !noScale('EP01'));
  const scales = new Map(STANDARD_SCALES.map((s) => [s.id, s]));
  const r = resolveAgentDefinition({ escalaPadraoId: 'EP01' }, scales);
  assert.equal(r.scaleId, 'EP01'); assert.equal(r.def.entry, 540);
  const missing = resolveAgentDefinition({ escalaPadraoId: 'XX', diasSemana: '2', entrada: '08:00', snack: '12:00', duracaoSnack: 45, saida: '14:00' }, scales);
  assert.equal(missing.scaleId, null); assert.equal(missing.missingScale, true);
  assert.equal(rowToDefinition({ diasSemana: '2,3', entrada: '09:00', almoco: '', snack: '12:00', duracaoSnack: '45', saida: '14:00' }).lunch, null);
});

test('mock: equipes têm workstream padrão e agentes têm escala padrão ou definição própria', () => {
  assert.ok(TEAMS.every((t) => CTX.tasks.has(t.defaultTaskId)));
  assert.ok(AGENTS.every((a) => (a.scaleId ? true : validateDefinition(a.def).length === 0)));
  assert.ok(AGENTS.some((a) => !a.scaleId) && AGENTS.some((a) => a.scaleId));
});

test('rascunho em lote: substitui o mês dos agentes envolvidos e mantém os demais', () => {
  const store = createDraftStore();
  const [a, b] = ['a@x.com', 'b@x.com'];
  const plan = planMonth(long, '2026-11', task, CTX);
  const published = { [a]: { 2: plan[2] }, [b]: {} };
  // rascunho prévio: edição manual de b no dia 3
  store.saveDay({ team: 't', month: '2026-11', email: b, day: 3, after: plan[3], published: [], user: 'u', version: 0 });
  // gerador para a: dia 2 igual ao publicado (sem item), dia 3 novo, dia 4 vazio sem publicado (sem item)
  const entries = [2, 3, 4].map((d) => ({ email: a, day: d, after: d === 4 ? [] : plan[d], published: published[a][d] ?? [] }));
  const d1 = store.replaceAgents({ team: 't', month: '2026-11', emails: [a], entries, user: 'u', version: 1 });
  const items = [...d1.items.values()];
  assert.equal(items.length, 2); // b|3 (preservado) + a|3 (novo)
  assert.ok(items.some((i) => i.email === b && i.day === 3));
  assert.ok(items.some((i) => i.email === a && i.day === 3 && i.kind === 'created'));
  // reaplicar para a, agora removendo o dia 2 publicado e sem o dia 3: limpa o item anterior de a
  const d2 = store.replaceAgents({ team: 't', month: '2026-11', emails: [a], entries: [{ email: a, day: 2, after: [], published: published[a][2] }], user: 'u', version: d1.version });
  const k = [...d2.items.values()].map((i) => `${i.email}|${i.day}|${i.kind}`).sort();
  assert.deepEqual(k, [`${a}|2|removed`, `${b}|3|created`].sort());
  // conflito de versão
  assert.throws(() => store.replaceAgents({ team: 't', month: '2026-11', emails: [a], entries: [], user: 'u', version: 0 }), /rascunho foi alterado/);
});
