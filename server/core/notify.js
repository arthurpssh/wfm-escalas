// Notificação ao supervisor responsável por uma exportação. STUB: a definir (canal, texto).
// Chamada quando um CSV foi importado mas não publicado (e nas verificações que pedem ação humana).
export function notifySupervisor({ exportEntry, reason }) {
  console.log(`[notify:stub] ${exportEntry.createdBy} — ${exportEntry.name}: ${reason}`);
  return { sent: false, stub: true };
}
