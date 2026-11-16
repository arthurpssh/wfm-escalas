// Visão das folgas no app = folgas do WFM (aba TimeOffs, mantida pela extração do Apps Script) + pedidos do app em andamento
// (aba FolgasPedidos, dona: o app). O app nunca escreve em TimeOffs: grava pedidos; o Apps Script os envia ao WFM e a extração
// devolve o resultado em TimeOffs. Até lá, a visão mostra o efeito esperado do pedido, para a tela não parecer parada.
const DAY = 24 * 3600_000;

/**
 * wfmRows: linhas de TimeOffs (id = id do WFM). pedidos: linhas de FolgasPedidos.
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
    if (p.tipo === 'criar') {
      if (p.externalId && known.has(p.externalId)) continue; // a extração já trouxe a folga
      out.push({
        id: p.id, email: p.agentEmail, reasonId: p.reasonId, reasonName: p.reasonName, startTime: p.startTime, endTime: p.endTime,
        status: p.status === 'agendada' ? 'agendada' : p.status === 'enviada' || p.status === 'duplicada' ? 'aprovada' : 'erro',
        origin: 'app', createdBy: p.createdBy, createdAt: p.createdAt, scheduledAt: p.scheduledAt, externalId: p.externalId || '', note: p.note || '',
      });
    } else if (p.status !== 'erro' && now - Date.parse(p.createdAt) < DAY) {
      const row = byExt.get(p.targetExternalId);
      if (row) { row.status = p.tipo === 'aprovar' ? 'aprovada' : 'negada'; row.decidedBy = p.createdBy; }
    }
  }
  return out;
}
