// Portal do agente: privacidade (o que um colega vê) e liberação (flag agent_portal).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortalSchedule, ownTimeoffs, tfLabel } from '../server/core/portal.js';
import { resolvePortal } from '../server/core/access.js';
import { configToShifts } from '../shared/rules.js';
import { CTX } from '../server/mockData.js';

const T = [...CTX.tasks.keys()][0];
const cfg = { taskId: T, entry: 540, lunch: 780, snack: 960, snackDur: 15, exit: 1080 }; // 09:00 a 18:00
const day = (d) => configToShifts(cfg, `2026-11-${String(d).padStart(2, '0')}`, CTX);
const tf = (over) => ({ id: 't', email: 'b@x.com', reasonId: 'R-DAYOFF', reasonName: 'Sick Day (atestado)', startTime: '2026-11-10T00:00:00-03:00', endTime: '2026-11-10T23:59:59-03:00', status: 'aprovada', ...over });
const agents = [{ id: 11, email: 'a@x.com', name: 'Ana' }, { id: 12, email: 'b@x.com', name: 'Bruno' }, { id: 13, email: 'c@x.com', name: 'Carla' }];
const cells = { 'a@x.com': { 10: day(10) }, 'b@x.com': { 10: day(10), 11: day(11) }, 'c@x.com': { 10: day(10) } };
const build = (timeoffs, vac = '') => buildPortalSchedule({ agents, self: 'c@x.com', month: '2026-11', cells, timeoffs, vacationReasonId: vac });

test('rótulo do dia: total cobre todo o trabalho, parcial só um intervalo, férias pela razão configurada', () => {
  const shifts = day(10);
  assert.equal(tfLabel(shifts, '2026-11-10', [tf()]), 'total');
  assert.equal(tfLabel(shifts, '2026-11-10', [tf({ startTime: '2026-11-10T14:00:00-03:00', endTime: '2026-11-10T15:00:00-03:00' })]), 'parcial');
  assert.equal(tfLabel(shifts, '2026-11-10', []), null);
  assert.equal(tfLabel(shifts, '2026-11-10', [tf({ reasonId: 'R-VAC' })], 'R-VAC'), 'ferias');
  assert.equal(tfLabel(shifts, '2026-11-10', [tf({ reasonId: 'R-VAC' })], ''), 'total'); // sem Config.reason_vacation: não quebra, cai em folga total
  assert.equal(tfLabel([], '2026-11-10', [tf({ reasonId: 'R-VAC' })], 'R-VAC'), 'ferias'); // férias aparecem até em dia sem escala
  assert.equal(tfLabel([], '2026-11-10', [tf()]), null); // folga comum em dia sem escala: nada a mostrar
  assert.equal(tfLabel(shifts, '2026-11-12', [tf()]), null); // outro dia
});

test('portal: colegas por id e nome, sem e-mail, sem motivo da folga, o próprio agente primeiro', () => {
  const v = build([tf()]);
  assert.deepEqual(v.agents.map((a) => [a.name, a.self]), [['Carla', true], ['Ana', false], ['Bruno', false]]);
  const json = JSON.stringify(v);
  assert.ok(!json.includes('@x.com'), 'nenhum e-mail na resposta');
  assert.ok(!json.includes('Sick Day') && !json.includes('atestado'), 'nenhum motivo da folga');
  assert.equal(v.tf['12'][10], 'total'); // Bruno, dia 10
  assert.equal(v.tf['11'][10], undefined);
  assert.equal(Object.keys(v.cells['12']).join(), '10,11');
  assert.deepEqual(Object.keys(v.cells['12'][10][0]).sort(), ['endTime', 'startTime', 'taskName', 'taskType']); // só o necessário de cada turno
});

test('portal: só folga APROVADA conta; pedido pendente, agendado, recusado ou com erro não aparece para ninguém', () => {
  for (const status of ['pendente', 'agendada', 'negada', 'erro']) assert.deepEqual(build([tf({ status })]).tf['12'], {}, status);
  assert.equal(build([tf({ status: 'aprovada' })]).tf['12'][10], 'total');
});

test('portal: o rascunho do supervisor não entra (só o que for passado em cells, que é o publicado)', () => {
  const v = buildPortalSchedule({ agents, self: 'a@x.com', month: '2026-11', cells: { 'a@x.com': {}, 'b@x.com': {}, 'c@x.com': {} }, timeoffs: [] });
  assert.deepEqual(Object.values(v.cells).map((c) => Object.keys(c).length), [0, 0, 0]);
});

test('minhas folgas: com motivo, todos os estados visíveis, erro vira "processando", sem decisor, só as do mês', () => {
  const list = ownTimeoffs([
    tf({ id: '1', email: 'c@x.com', status: 'aprovada', decidedBy: 'sup@x.com', createdBy: 'sup@x.com' }),
    tf({ id: '2', email: 'c@x.com', status: 'erro', startTime: '2026-11-20T00:00:00-03:00', endTime: '2026-11-20T23:59:59-03:00' }),
    tf({ id: '3', email: 'c@x.com', status: 'pendente', startTime: '2026-11-05T00:00:00-03:00', endTime: '2026-11-05T23:59:59-03:00' }),
    tf({ id: '4', email: 'b@x.com' }), // de outro agente
    tf({ id: '5', email: 'c@x.com', startTime: '2026-12-10T00:00:00-03:00', endTime: '2026-12-10T23:59:59-03:00' }), // outro mês
  ], 'c@x.com', '2026-11');
  assert.deepEqual(list.map((t) => [t.id, t.status]), [['3', 'pendente'], ['1', 'aprovada'], ['2', 'processando']]);
  assert.equal(list[1].reasonName, 'Sick Day (atestado)'); // o dono vê o próprio motivo
  assert.ok(!JSON.stringify(list).includes('sup@x.com'));
});

test('flag do portal: Config manda, ambiente é o padrão, valor inválido mantém desligado', () => {
  assert.deepEqual(resolvePortal('', ''), { on: false, source: 'ambiente' });
  assert.equal(resolvePortal('', 'on').on, true);
  assert.equal(resolvePortal('on', 'off').on, true);
  assert.equal(resolvePortal('OFF', 'on').on, false);
  assert.equal(resolvePortal('sim', '').on, true);
  assert.equal(resolvePortal('ligado', 'on').on, false); // valor errado na planilha: não liga
  assert.equal(resolvePortal('ligado', 'on').invalid, true);
});

test('isEmail (DEV_IMPERSONATE): aceita e-mails com qualquer letra, recusa o que não é e-mail', async () => {
  const { isEmail } = await import('../server/core/access.js');
  for (const ok of ['lucas.garcia@hotmart.com', 'paula.georgia@hotmart.com', 'sups@x.com', 'a_b-c@sub.dominio.com.br']) assert.equal(isEmail(ok), true, ok);
  for (const no of ['', 'semarroba', 'a@b', 'a b@x.com', '@x.com', 'a@@x.com', 'a@x. com', null, undefined]) assert.equal(isEmail(no), false, String(no));
});
