// A mesma escala em vários dias de um agente: escolha de dias e gravação no rascunho.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, ConflictError } from '../server/core/drafts.js';
import { persistentDraftStore } from '../server/data/persist.js';
import { configToShifts, pickDays } from '../shared/rules.js';
import { CTX } from '../server/mockData.js';

// ---------- escolha de dias ----------
// novembro de 2026: dia 1 é domingo; 2 = segunda ... 6 = sexta, 7 = sábado
const hasShift = (d) => ![1, 7, 8, 14, 15, 21, 22, 28, 29].includes(d); // sem escala nos fins de semana

test('intervalo: só dias que já têm escala, inclusive nas pontas', () => {
  assert.deepEqual(pickDays({ month: '2026-11', from: 4, to: 10, hasShift }), [4, 5, 6, 9, 10]); // 7 e 8 (sáb, dom) ficam de fora
  assert.deepEqual(pickDays({ month: '2026-11', from: 10, to: 4, hasShift }), [4, 5, 6, 9, 10]); // de/até invertidos
});

test('incluir dias sem escala: o intervalo inteiro entra (para escalar o agente)', () => {
  assert.deepEqual(pickDays({ month: '2026-11', from: 5, to: 8, hasShift, includeEmpty: true }), [5, 6, 7, 8]);
});

test('dias da semana filtram o intervalo (1 = domingo ... 7 = sábado); vazio = todos', () => {
  assert.deepEqual(pickDays({ month: '2026-11', from: 1, to: 30, weekdays: '2', hasShift }), [2, 9, 16, 23, 30]); // só segundas
  assert.deepEqual(pickDays({ month: '2026-11', from: 1, to: 14, weekdays: new Set([2, 6]), hasShift }), [2, 6, 9, 13]); // segundas e sextas
  assert.deepEqual(pickDays({ month: '2026-11', from: 1, to: 14, weekdays: '', hasShift: () => true, includeEmpty: true }).length, 14);
});

test('dias bloqueados (folga total) nunca entram, e o intervalo respeita o mês', () => {
  assert.deepEqual(pickDays({ month: '2026-11', from: 2, to: 6, hasShift, locked: (d) => d === 4 }), [2, 3, 5, 6]);
  assert.deepEqual(pickDays({ month: '2026-11', from: 28, to: 99, hasShift: () => true }), [28, 29, 30]); // novembro tem 30 dias
  assert.deepEqual(pickDays({ month: '2026-02', from: 1, to: 99, hasShift: () => true }).length, 28);
});

// ---------- rascunho: saveDays ----------
const T = [...CTX.tasks.keys()][0];
const cfg = { taskId: T, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 };
const novo = { ...cfg, entry: 600, lunch: 840, snack: 1000, exit: 1140 }; // 10:00 a 19:00
const day = (d, c = cfg) => configToShifts(c, `2026-11-${String(d).padStart(2, '0')}`, CTX);
const base = { team: 'sup@x.com', month: '2026-11', email: 'a@x.com', user: 'sup@x.com' };

test('saveDays: vários dias numa só gravação e numa só versão; tipo de cada dia pelo publicado', () => {
  const s = createDraftStore();
  const entries = [{ day: 3, after: day(3, novo), published: day(3) }, { day: 4, after: day(4, novo), published: day(4) }, { day: 7, after: day(7, novo), published: [] }];
  const d = s.saveDays({ ...base, entries, version: 0 });
  assert.equal(d.version, 1); // uma subida só, não três
  assert.deepEqual([...d.items.values()].map((i) => [i.day, i.kind]), [[3, 'edited'], [4, 'edited'], [7, 'created']]);
  assert.equal(d.items.get('a@x.com|3').before.length, 5); // "antes" = publicado
});

test('saveDays: voltar ao publicado tira o dia do rascunho; rascunho vazio desaparece; "antes" do primeiro toque é preservado', () => {
  const s = createDraftStore();
  s.saveDays({ ...base, entries: [{ day: 3, after: day(3, novo), published: day(3) }, { day: 4, after: day(4, novo), published: day(4) }], version: 0 });
  // reaplicar o escalonamento original no dia 3: volta ao publicado e sai; o "antes" do dia 4 não muda mesmo com 2ª edição
  const d = s.saveDays({ ...base, entries: [{ day: 3, after: day(3), published: day(3) }, { day: 4, after: day(4, { ...novo, exit: 1200 }), published: day(4) }], version: 1 });
  assert.deepEqual([...d.items.values()].map((i) => i.day), [4]);
  assert.equal(d.items.get('a@x.com|4').before.length, 5);
  assert.equal(s.saveDays({ ...base, entries: [{ day: 4, after: day(4), published: day(4) }], version: 2 }), null); // nada mais alterado
  assert.equal(s.get('sup@x.com', '2026-11'), null);
});

test('saveDays: respeita a versão (409 se outra pessoa mexeu) e não mexe nos outros agentes', () => {
  const s = createDraftStore();
  s.saveDay({ ...base, email: 'b@x.com', day: 3, after: day(3, novo), published: day(3), version: 0 }); // outro agente já no rascunho
  assert.throws(() => s.saveDays({ ...base, entries: [{ day: 3, after: day(3, novo), published: day(3) }], version: 0 }), ConflictError);
  const d = s.saveDays({ ...base, entries: [{ day: 3, after: day(3, novo), published: day(3) }], version: 1 });
  assert.deepEqual([...d.items.keys()].sort(), ['a@x.com|3', 'b@x.com|3']);
});

test('rascunho persistente: saveDays marca o rascunho para gravar na planilha', () => {
  let marks = 0;
  const p = persistentDraftStore(createDraftStore(), { markDrafts: () => { marks++; } });
  p.saveDays({ ...base, entries: [{ day: 3, after: day(3, novo), published: day(3) }], version: 0 });
  assert.equal(marks, 1);
});
