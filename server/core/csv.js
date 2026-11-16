// Formato do CSV de importação do Tymeshift/WFM (import avançado).
// Colunas: agentName,agentEmail,taskType,taskId,taskName,timeOffType,startTime,endTime
// Folgas NUNCA vão neste CSV (Fase 0: criam folgas aprovadas na hora, duplicam e ampliam a janela dos turnos).
export const CSV_HEADER = ['agentName', 'agentEmail', 'taskType', 'taskId', 'taskName', 'timeOffType', 'startTime', 'endTime'];

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Linha de turno de um agente. Usa o nome do cadastro (o WFM casa o agente pelo e-mail). */
export const shiftRow = (agent, s) => ({
  agentName: agent.name, agentEmail: agent.email, taskType: s.taskType, taskId: s.taskId, taskName: s.taskName,
  timeOffType: '', startTime: s.startTime, endTime: s.endTime,
});

export const toCsv = (rows) => [CSV_HEADER.join(','), ...rows.map((r) => CSV_HEADER.map((h) => esc(r[h])).join(','))].join('\r\n') + '\r\n';
