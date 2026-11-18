// Escalas padrão e definição de escala de cada agente (base do gerador de escala mensal).
// Espelha as colunas da planilha: aba EscalasPadrao (id, diasSemana, entrada, almoco, snack, duracaoSnack, saida) e,
// na aba Users, escalaPadraoId + as mesmas colunas particulares (diasSemana, entrada, almoco, snack, duracaoSnack, saida).
import { exitFromInput, hhmmToMin } from '../../shared/rules.js';

/** Vazio, null ou "-" = sem escala padrão (escala personalizada). */
export const noScale = (v) => v == null || ['', '-', 'null'].includes(String(v).trim().toLowerCase());

/** Linha da planilha (strings) -> definição em minutos. */
export const rowToDefinition = (r) => ({
  weekdays: String(r.diasSemana ?? '').replace(/[^1-7]/g, ''),
  entry: hhmmToMin(r.entrada),
  lunch: r.almoco ? hhmmToMin(r.almoco) : null,
  snack: hhmmToMin(r.snack),
  snackDur: Number(r.duracaoSnack) || null,
  exit: exitFromInput(hhmmToMin(r.saida)), // "00:00" = meia-noite do dia seguinte
});

/** { scaleId|null, def, missingScale } de um agente, dado o mapa id -> linha de EscalasPadrao. */
export function resolveAgentDefinition(user, scales) {
  if (!noScale(user.escalaPadraoId)) {
    const s = scales.get(String(user.escalaPadraoId).trim());
    if (s) return { scaleId: s.id, def: rowToDefinition(s), missingScale: false };
    return { scaleId: null, def: rowToDefinition(user), missingScale: true }; // id inexistente: trata como personalizada
  }
  return { scaleId: null, def: rowToDefinition(user), missingScale: false };
}
