// Trocas de dia extra entre agentes. A Maria pede para assumir o dia extra do João e PODE oferecer um dia extra dela em troca.
// Fluxo: pendente_agente (o João aceita ou recusa) -> pendente_supervisor (a supervisão consolida ou recusa) -> consolidada
// (as mudanças entram no RASCUNHO dos dois; confirmar e exportar segue o fluxo de sempre; o app nunca grava no WFM por causa da troca).
// Outros finais: recusada (pelo agente ou pela supervisão), cancelada (pela Maria enquanto ninguém decidiu), expirada (o dia passou),
// invalidada (a escala mudou e a troca não faz mais sentido).
import { addDaysIso, weekdayDigit } from '../../shared/rules.js';
import { isExtraDay } from './extras.js';

export const OPEN = ['pendente_agente', 'pendente_supervisor'];
export const STATUS_LABEL = {
  pendente_agente: 'aguardando o colega', pendente_supervisor: 'aguardando a supervisão', consolidada: 'consolidada (no rascunho)',
  recusada: 'recusada', cancelada: 'cancelada', expirada: 'expirada', invalidada: 'invalidada',
};
const dm = (date) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/**
 * Erros de um pedido de troca (lista vazia = pode). ctx: { today, team: Set(emails), shiftsOn(email, date) -> Shift[],
 * weekdaysOf(email) -> '23456', timeoffOn(email, date) -> bool, openSwaps: [] }. `ignoreId`: a própria troca ao revalidar.
 */
export function validateSwap({ requester, owner, date, offerDate = '' }, ctx, ignoreId = null) {
  const e = [];
  if (!ctx.team.has(owner) || !ctx.team.has(requester)) e.push('A troca só vale entre agentes do mesmo time.');
  if (owner === requester) e.push('Você não pode trocar com você mesmo.');
  if (!(date > ctx.today)) e.push('O dia a assumir precisa ser futuro.');
  if (!isExtraDay(ctx.shiftsOn(owner, date), ctx.weekdaysOf(owner), date)) e.push(`O dia ${dm(date)} não é um dia extra do colega (ou ele não está mais escalado).`);
  if (ctx.shiftsOn(requester, date).length) e.push(`Você já está escalado no dia ${dm(date)}.`);
  if (ctx.timeoffOn(requester, date)) e.push(`Você tem folga no dia ${dm(date)}.`);
  const open = (ctx.openSwaps ?? []).filter((s) => OPEN.includes(s.status) && s.id !== ignoreId);
  if (open.some((s) => s.owner === owner && s.date === date)) e.push(`Já existe um pedido em aberto para o dia ${dm(date)} desse colega.`);
  if (offerDate) {
    if (offerDate === date) e.push('O dia oferecido precisa ser diferente do dia pedido.');
    if (!(offerDate > ctx.today)) e.push('O dia oferecido precisa ser futuro.');
    if (!isExtraDay(ctx.shiftsOn(requester, offerDate), ctx.weekdaysOf(requester), offerDate)) e.push(`O dia ${dm(offerDate)} não é um dia extra seu.`);
    if (ctx.shiftsOn(owner, offerDate).length) e.push(`O colega já está escalado no dia ${dm(offerDate)}.`);
    if (ctx.timeoffOn(owner, offerDate)) e.push(`O colega tem folga no dia ${dm(offerDate)}.`);
    if (open.some((s) => (s.requester === requester && s.offerDate === offerDate) || (s.owner === requester && s.date === offerDate))) e.push(`Seu dia ${dm(offerDate)} já está em outro pedido.`);
  }
  return e;
}

/** O que a troca muda na escala: [{ email, date, after }] (after = turnos que o agente terá no dia; [] = sai da escala). */
export function swapOps({ requester, owner, date, offerDate = '' }, shiftsOn) {
  const ops = [{ email: owner, date, after: [] }, { email: requester, date, after: shiftsOn(owner, date).map((s) => ({ ...s })) }];
  if (offerDate) ops.push({ email: requester, date: offerDate, after: [] }, { email: owner, date: offerDate, after: shiftsOn(requester, offerDate).map((s) => ({ ...s })) });
  return ops;
}

const hours = (h) => `${Math.floor(h)} h${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const weekIndex = (date) => (weekdayDigit(date) + 5) % 7; // 0 = segunda ... 6 = domingo

/**
 * Avisos (não bloqueiam) para a supervisão, olhando a escala DEPOIS da troca: interjornada menor que 11 h, mais de 6 dias seguidos
 * e carga da semana (segunda a domingo) acima de 44 h trabalhadas (o almoço não conta).
 */
export function swapWarnings({ ops, shiftsOn, lunchTaskId, nameOf }) {
  const over = new Map(ops.map((o) => [`${o.email}|${o.date}`, o.after]));
  const on = (email, date) => over.get(`${email}|${date}`) ?? shiftsOn(email, date) ?? [];
  const worked = (shifts) => shifts.filter((s) => s.taskId !== lunchTaskId).reduce((n, s) => n + (Date.parse(s.endTime) - Date.parse(s.startTime)) / 60000, 0);
  const out = [], seen = new Set();
  for (const o of ops.filter((x) => x.after.length)) {
    const who = nameOf(o.email), cur = on(o.email, o.date);
    const warn = (key, text) => { if (!seen.has(key)) { seen.add(key); out.push(text); } };
    const prevD = addDaysIso(o.date, -1), nextD = addDaysIso(o.date, 1), prev = on(o.email, prevD), next = on(o.email, nextD);
    if (prev.length) { const gap = (Date.parse(cur[0].startTime) - Date.parse(prev.at(-1).endTime)) / 3600000; if (gap < 11) warn(`rest|${o.email}|${prevD}`, `${who}: só ${hours(gap)} de descanso entre ${dm(prevD)} e ${dm(o.date)} (o recomendado é 11 h).`); }
    if (next.length) { const gap = (Date.parse(next[0].startTime) - Date.parse(cur.at(-1).endTime)) / 3600000; if (gap < 11) warn(`rest|${o.email}|${o.date}`, `${who}: só ${hours(gap)} de descanso entre ${dm(o.date)} e ${dm(nextD)} (o recomendado é 11 h).`); }
    let run = 1;
    for (let d = prevD; on(o.email, d).length; d = addDaysIso(d, -1)) run++;
    for (let d = nextD; on(o.email, d).length; d = addDaysIso(d, 1)) run++;
    if (run > 6) warn(`run|${o.email}`, `${who}: ${run} dias seguidos de trabalho.`);
    const monday = addDaysIso(o.date, -weekIndex(o.date));
    let min = 0;
    for (let i = 0; i < 7; i++) min += worked(on(o.email, addDaysIso(monday, i)));
    if (min > 44 * 60) warn(`week|${o.email}|${monday}`, `${who}: ${hours(min / 60)} trabalhadas na semana de ${dm(monday)} (acima de 44 h).`);
  }
  return out;
}

/** Trocas em aberto cujo dia (ou o dia oferecido) já chegou: expiram. */
export const expiredIds = (swaps, today) => swaps.filter((s) => OPEN.includes(s.status) && (s.date <= today || (s.offerDate && s.offerDate <= today))).map((s) => s.id);
