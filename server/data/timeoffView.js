// Visão das folgas no app = folgas do WFM (aba TimeOffs, mantida pela extração do Apps Script) + pedidos do app em andamento
// (aba FolgasPedidos, dona: o app). O app nunca escreve em TimeOffs: grava pedidos; o Apps Script os envia ao WFM e a extração
// devolve o resultado em TimeOffs. Até lá, a visão mostra o efeito esperado do pedido, para a tela não parecer parada.
const DAY = 24 * 3600_000;

/**
 * wfmRows: linhas de TimeOffs (id = id do WFM). pedidos: linhas de FolgasPedidos.
 *  - solicitar (pedido do agente, portal): agendada → "agendada" com request=true (só o agente enxerga; o supervisor só vê depois do envio);
 *    enviada/duplicada → "pendente" (aguarda decisão) até a extração trazer a folga do WFM (mesmo id, aí o pedido some);
 *  - criar agendada → aparece como "agendada" (cancelável até a carência acabar);
 *  - criar enviada/duplicada → aparece como "aprovada" até a extração trazer a folga (mesmo id do WFM, aí o pedido some);
 *  - criar com erro → "erro";
 *  - aprovar/negar (não deu erro, últimas 24 h) → a linha de destino já aparece aprovada/negada.
 */
export function mergeTimeoffView(wfmRows, pedidos, now = Date.now()) {
  const out = wfmRows.map((r) => ({ ...r }));
  const known = new Set(wfmRows.map((r) => r.externalId || r.id));
  const byExt = new Map(out.map((r) => [r.externalId || r.id, r]));
  const ordered = [...pedidos].sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1)); // o mais recente vence
  for (const p of ordered) {
    if (p.status === 'cancelada') continue;
    if (p.tipo === 'criar' || p.tipo === 'solicitar') {
      const req = p.tipo === 'solicitar';
      if (p.externalId && known.has(p.externalId)) continue; // a extração já trouxe a folga
      out.push({
        id: p.id, email: p.agentEmail, reasonId: p.reasonId, reasonName: p.reasonName, startTime: p.startTime, endTime: p.endTime,
        status: p.status === 'agendada' ? 'agendada' : p.status === 'enviada' || p.status === 'duplicada' ? (req ? 'pendente' : 'aprovada') : 'erro',
        origin: req ? 'agent' : 'app', request: req, createdBy: p.createdBy, createdAt: p.createdAt, scheduledAt: p.scheduledAt, externalId: p.externalId || '', note: p.note || '', loteId: p.loteId || '',
      });
    } else if (p.status !== 'erro' && now - Date.parse(p.createdAt) < DAY) {
      const row = byExt.get(p.targetExternalId);
      if (row) { row.status = p.tipo === 'aprovar' ? 'aprovada' : 'negada'; row.decidedBy = p.createdBy; }
    }
  }
  return out;
}

/**
 * Lote de folgas = várias folgas criadas de uma vez (uma por agente), ligadas por `loteId`. Cada linha mantém o próprio status.
 * rows: { id, email, reasonId, reasonName, startTime, endTime, status, note, createdAt, scheduledAt, createdBy, loteId } com status JÁ normalizado:
 * 'agendada' (ainda dentro da carência) | 'enviada' (no WFM) | 'erro' | 'cancelada'.
 */
export function groupLots(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.loteId) continue;
    if (!by.has(r.loteId)) by.set(r.loteId, { loteId: r.loteId, items: [] });
    by.get(r.loteId).items.push(r);
  }
  return [...by.values()];
}
/** Status de um pedido do app (FolgasPedidos) no vocabulário do lote. */
export const lotStatusOfPedido = (s) => (s === 'agendada' ? 'agendada' : s === 'cancelada' ? 'cancelada' : s === 'enviada' || s === 'duplicada' ? 'enviada' : 'erro');
/** Pedidos "criar" com lote -> linhas de lote. */
export const pedidosToLotRows = (pedidos) => pedidos.filter((p) => p.tipo === 'criar' && p.loteId).map((p) => ({
  id: p.id, email: p.agentEmail, reasonId: p.reasonId, reasonName: p.reasonName, startTime: p.startTime, endTime: p.endTime,
  status: lotStatusOfPedido(p.status), note: p.note || '', createdAt: p.createdAt, scheduledAt: p.scheduledAt, createdBy: p.createdBy, loteId: p.loteId,
}));
