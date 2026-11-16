import test from 'node:test';
import assert from 'node:assert/strict';
import { planExports } from '../server/core/exporter.js';
import { ACTIVITIES, AGENTS, CTX } from '../server/mockData.js';
import { configToShifts } from '../shared/rules.js';

const A = AGENTS[0], B = AGENTS[1];
const task = ACTIVITIES.find((a) => a.taskType === 'workstream').taskId;
const cfg = { taskId: task, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 };
const day = (d, c = cfg) => configToShifts(c, '2027-04-' + String(d).padStart(2, '0'), CTX);
// escala base: A e B trabalham dias 5..9 (09:00-18:00)
const base = Object.fromEntries([A, B].map((a) => [a.email, Object.fromEntries([5, 6, 7, 8, 9].map((d) => [d, day(d)]))]));
const common = { team: A.team, month: '2027-04', agents: AGENTS, activities: ACTIVITIES, today: '2027-03-01', baseCells: base };
const item = (a, d, after, kind = 'edited') => ({ email: a.email, day: d, kind, before: base[a.email][d] ?? [], after });

test('janela reemitida: um dia alterado entre dias iguais gera todos os dias da janela do agente', () => {
  const items = [item(A, 5, day(5, { ...cfg, entry: 600, lunch: 840, snack: 1000, exit: 1080 })), item(A, 8, day(8, { ...cfg, exit: 1020, snack: 950 }))];
  const { files, errors } = planExports({ ...common, items, gapDays: 2 });
  assert.deepEqual(errors, []);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].window, { from: '2027-04-05', to: '2027-04-08' });
  const days = new Set(files[0].csv.split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[6].slice(0, 10)));
  assert.deepEqual([...days].sort(), ['2027-04-05', '2027-04-06', '2027-04-07', '2027-04-08']); // inclui 06 e 07 (não alterados)
});

test('só agentes alterados entram; cada um é reemitido em toda a janela (janela vale pro arquivo)', () => {
  const items = [item(A, 5, day(5, { ...cfg, exit: 1020, snack: 950 })), item(B, 7, day(7, { ...cfg, exit: 1020, snack: 950 }))];
  const { files } = planExports({ ...common, items });
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].agents.sort(), [A.email, B.email].sort());
  assert.deepEqual(Object.keys(files[0].expected[A.email]), ['5', '6', '7']); // A também reemitido em 6 e 7
});

test('datas distantes viram arquivos separados', () => {
  const items = [item(A, 5, day(5, { ...cfg, exit: 1020, snack: 950 })), item(A, 20, day(20), 'created')];
  const { files } = planExports({ ...common, baseCells: { ...base, [A.email]: { ...base[A.email] } }, items, gapDays: 2 });
  assert.equal(files.length, 2);
  assert.ok(files[0].window.to < files[1].window.from);
});

test('remoção sem outras linhas do agente na janela não cabe no CSV (fallback)', () => {
  const only = { [A.email]: { 5: day(5) } };
  const items = [{ email: A.email, day: 5, kind: 'removed', before: only[A.email][5], after: [] }];
  const r = planExports({ ...common, baseCells: only, items });
  assert.equal(r.files.length, 0);
  assert.equal(r.unexpressible.length, 1);
});

test('remoção por omissão: agente continua no arquivo por outros dias da janela', () => {
  const items = [{ email: A.email, day: 6, kind: 'removed', before: base[A.email][6], after: [] }, item(A, 8, day(8, { ...cfg, exit: 1020, snack: 950 }))];
  const { files } = planExports({ ...common, items });
  const days = new Set(files[0].csv.split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[6].slice(0, 10)));
  assert.ok(!days.has('2027-04-06')); // dia 6 sem linhas => será apagado pelo import
  assert.ok(days.has('2027-04-05') === false && days.has('2027-04-08'));
});

test('pré-voo: janela no passado, atividade inexistente, sobreposição e atribuição', () => {
  const past = planExports({ ...common, today: '2027-06-30', items: [item(A, 5, day(5, { ...cfg, exit: 1020, snack: 950 }))] });
  assert.ok(past.errors.some((e) => e.includes('30 dias')));
  const bad = day(5).map((s) => ({ ...s }));
  bad[0].taskId = 'nao-existe';
  assert.ok(planExports({ ...common, items: [item(A, 5, bad)] }).errors.some((e) => e.includes('inexistente')));
  const ov = day(5).map((s) => ({ ...s }));
  ov[1].startTime = ov[0].startTime;
  assert.ok(planExports({ ...common, items: [item(A, 5, ov)] }).errors.length > 0);
  const assignments = new Map([[A.email, new Set()]]);
  assert.ok(planExports({ ...common, assignments, items: [item(A, 5, day(5, { ...cfg, exit: 1020, snack: 950 }))] }).errors.some((e) => e.includes('não atribuído')));
});

test('padrão: alterações distantes continuam em UM arquivo, reemitindo os dias do meio', () => {
  const items = [item(A, 5, day(5, { ...cfg, exit: 1020, snack: 950 })), item(A, 20, day(20), 'created')];
  const { files } = planExports({ ...common, items }); // sem gapDays => um arquivo
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].window, { from: '2027-04-05', to: '2027-04-20' });
  assert.equal(files[0].days, 16);
  assert.equal(files[0].reemitted, 4); // dias 6..9 do agente A (base) reemitidos sem alteração
});
