// Notificação ao supervisor responsável por uma exportação. STUB: a definir (canal, texto).
// Chamada quando um CSV foi importado mas não publicado (e nas verificações que pedem ação humana).
export function notifySupervisor({ exportEntry, reason }) {
  console.log(`[notify:stub] ${exportEntry.createdBy} — ${exportEntry.name}: ${reason}`);
  return { sent: false, stub: true };
}

/**
 * Notificação de trocas de dia extra. STUB (sem canal ainda; o alvo é o Google Chat, que pede uma conta de serviço própria).
 * Eventos: 'pedido' (para o dono do dia), 'aceita' e 'recusada_agente' (para quem pediu e para a supervisão), 'consolidada', 'recusada_supervisao' (para os dois agentes).
 */
export function notifySwap({ event, swap }) {
  console.log(`[notify:stub] troca ${swap.id} (${event}): ${swap.requester} ↔ ${swap.owner}, dia ${swap.date}`);
  return { sent: false, stub: true };
}
