// Health check da escala. Por ora é um stub que sempre aprova.
// Contrato final: { ok: boolean, violations: [{ rule, email, day, message }] }
// Ideias futuras: cobertura mínima por faixa, almoço fora de janela, descanso interjornada (11h),
// máximo de dias consecutivos, snack sobreposto entre agentes do mesmo time, etc.

export function runHealthCheck(/* { month, agents, cells, timeoffs } */) {
  return { ok: true, violations: [] };
}
