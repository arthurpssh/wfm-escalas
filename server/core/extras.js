// Dia extra = dia com turno cujo dia da semana NÃO está na escala padrão do agente (fim de semana, dia útil fora do padrão...).
// É derivado (sem coluna nova): vem da definição de escala do agente (Users/EscalasPadrao, ou a que o supervisor escolheu no gerador).
// Agente sem dias da semana definidos não tem dia extra (não dá para classificar). Feriado trabalhado em dia normal da escala NÃO é extra.
import { dateOf, parseWeekdays, weekdayDigit } from '../../shared/rules.js';

/** { email: { dia: true } } dos dias extras de um mês. cells: { email: { dia: Shift[] } }; weekdays: { email: '23456' }. */
export function extraDays({ month, cells, weekdays }) {
  const out = {};
  for (const [email, days] of Object.entries(cells)) {
    const wd = parseWeekdays(weekdays[email]);
    if (!wd.size) continue;
    for (const [d, shifts] of Object.entries(days)) {
      if (shifts?.length && !wd.has(weekdayDigit(dateOf(month, Number(d))))) (out[email] ??= {})[d] = true;
    }
  }
  return out;
}

/** Um dia específico: tem turno e o dia da semana está fora da escala padrão? */
export const isExtraDay = (shifts, weekdaysStr, date) => {
  const wd = parseWeekdays(weekdaysStr);
  return !!shifts?.length && wd.size > 0 && !wd.has(weekdayDigit(date));
};
