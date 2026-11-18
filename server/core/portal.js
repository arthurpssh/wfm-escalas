// Portal do agente (somente leitura): o que um agente pode ver da escala do próprio time e das próprias folgas.
// Princípio: o servidor só devolve o necessário. Os colegas aparecem por id e nome (sem e-mail); a folga de um colega vira só
// "Férias", "Folga total" ou "Folga parcial", nunca o motivo; pedidos pendentes, agendados ou recusados dos colegas não aparecem.
import { coverage, dateOf, daysInMonth, isoDate, timeoffTouchesDay } from '../../shared/rules.js';

export const PORTAL_LABEL = { ferias: 'Férias', total: 'Folga total', parcial: 'Folga parcial' };

/**
 * Rótulo do dia de um agente por causa de folgas aprovadas: 'ferias' | 'total' | 'parcial' | null.
 * Total/parcial segue o critério da grade do supervisor (coverage): total = as folgas cobrem todo o trabalho do dia.
 * Férias = alguma folga do dia tem a razão configurada em Config.reason_vacation (vale mesmo em dia sem escala).
 */
export function tfLabel(shifts, date, timeoffs, vacationReasonId = '') {
  const day = timeoffs.filter((t) => timeoffTouchesDay(t, date));
  if (!day.length) return null;
  if (vacationReasonId && day.some((t) => t.reasonId === vacationReasonId)) return 'ferias';
  const c = coverage(shifts, date, day);
  return c === 'full' ? 'total' : c === 'partial' ? 'parcial' : null;
}

/**
 * Escala do time para o portal.
 * agents: [{ id, email, name }] do time; cells: { email: { dia: Shift[] } } (PUBLICADO, nunca o rascunho do supervisor);
 * timeoffs: folgas do time (qualquer status; só as aprovadas contam aqui).
 * Devolve { agents: [{ id, name, self }], cells: { id: { dia: [{ taskType, taskName, startTime, endTime }] } }, tf: { id: { dia: rótulo } } }, com o próprio agente primeiro.
 */
export function buildPortalSchedule({ agents, self, month, cells, timeoffs, vacationReasonId = '', extra = {} }) {
  const n = daysInMonth(month);
  const approved = timeoffs.filter((t) => t.status === 'aprovada');
  const out = { agents: [], cells: {}, tf: {}, extra: {} };
  const sorted = [...agents].sort((a, b) => (a.email === self ? -1 : b.email === self ? 1 : a.name.localeCompare(b.name, 'pt-BR')));
  for (const a of sorted) {
    const id = String(a.id);
    out.agents.push({ id, name: a.name, self: a.email === self });
    const mine = approved.filter((t) => t.email === a.email);
    const c = {}, tf = {};
    for (let d = 1; d <= n; d++) {
      const date = dateOf(month, d), shifts = cells[a.email]?.[d] ?? [];
      if (shifts.length) c[d] = shifts.map((s) => ({ taskType: s.taskType, taskName: s.taskName, startTime: s.startTime, endTime: s.endTime }));
      const label = tfLabel(shifts, date, mine, vacationReasonId);
      if (label) tf[d] = label;
    }
    out.cells[id] = c; out.tf[id] = tf; out.extra[id] = { ...(extra[a.email] ?? {}) };
  }
  return out;
}

// O agente vê a própria folga com o motivo, mas sem detalhes internos (erro de envio vira "processando"; ninguém aparece como decisor).
const OWN_STATUS = { agendada: 'agendada', aprovada: 'aprovada', pendente: 'pendente', negada: 'negada', erro: 'processando' };
/** O agente pode cancelar o que pediu e ainda não foi decidido: pedido na carência (nem foi ao WFM) ou pendente no WFM. */
export const cancelableByAgent = (t) => (t.request === true && t.status === 'agendada') || t.status === 'pendente';

/** Folgas do próprio agente que tocam o mês `month`. */
export function ownTimeoffs(timeoffs, email, month) {
  const first = `${month}-01`, last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  return timeoffs
    .filter((t) => t.email === email && OWN_STATUS[t.status] && isoDate(t.startTime) <= last && isoDate(t.endTime) >= first)
    .map((t) => ({ id: t.id, reasonName: t.reasonName, startTime: t.startTime, endTime: t.endTime, status: t.request === true && t.status === 'agendada' ? 'solicitada' : OWN_STATUS[t.status], cancelable: cancelableByAgent(t), createdAt: t.createdAt ?? null }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}
