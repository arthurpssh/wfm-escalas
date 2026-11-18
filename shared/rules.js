// Regras de negócio puras, compartilhadas entre servidor (Node) e front (browser).
// Convenção: todos os horários são "locais" do fuso fixo TZ. Dentro de um dia trabalhamos em
// minutos desde 00:00; strings ISO só são montadas na borda (shifts/CSV).

export const TZ = '-03:00';
export const LONG_DAY_MIN = 9 * 60; // >= 9h => tem almoço e snack curto
export const LUNCH_MIN = 60;
export const SNACK_LONG_DAY = 15; // jornada >= 9h
export const SNACK_SHORT_DAY = 45; // jornada < 9h
export const STEP = 1; // o WFM trabalha em minutos

// Fuso fixo do app (TZ): datas e horas mostradas e "hoje"/"mês atual" seguem -03:00, qualquer que seja o fuso do navegador ou do servidor.
const TZ_MIN = (TZ[0] === '-' ? -1 : 1) * (Number(TZ.slice(1, 3)) * 60 + Number(TZ.slice(4, 6)));
/** Instante (ms) -> 'YYYY-MM-DDTHH:mm' no fuso do app. */
export const localIso = (ms = Date.now()) => new Date(ms + TZ_MIN * 60000).toISOString().slice(0, 16);
export const localDate = (ms) => localIso(ms).slice(0, 10);
export const localMonth = (ms) => localIso(ms).slice(0, 7);
/** ISO com "Z" ou deslocamento (ex.: 2026-11-16T14:36:00.000Z) -> 'YYYY-MM-DDTHH:mm' no fuso do app. Sem fuso na string: só recorta. */
export function toLocalIso(iso) {
  const s = String(iso ?? '');
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) return s.slice(0, 16);
  const t = Date.parse(s);
  return Number.isNaN(t) ? s.slice(0, 16) : localIso(t);
}

export const pad = (n) => String(n).padStart(2, '0');
export const minToHHMM = (m) => (m == null ? '' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
export const hhmmToMin = (s) => {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
export const roundMin = (m) => Math.round(m / STEP) * STEP;
export const DAY_MIN = 1440;
export const addDaysIso = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Minutos desde 00:00 de `date`. A partir de 1440 o instante cai no(s) dia(s) seguinte(s): 1440 = 00:00 do dia seguinte (a "saída às 24:00"). */
export const toIso = (date, min) => (min >= DAY_MIN
  ? `${addDaysIso(date, Math.floor(min / DAY_MIN))}T${minToHHMM(min % DAY_MIN)}:00${TZ}`
  : `${date}T${minToHHMM(min)}:00${TZ}`);
export const isoDate = (iso) => iso.slice(0, 10);
export const isoMin = (iso) => hhmmToMin(iso.slice(11, 16));
/** Minutos do instante `iso` contados desde 00:00 de `date` (passa de 1440 se for depois da meia-noite seguinte). */
export const isoMinOn = (iso, date) => Math.round((Date.parse(`${isoDate(iso)}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000) * DAY_MIN + isoMin(iso);
/** O campo de hora vai de 00:00 a 23:59: na SAÍDA, "00:00" quer dizer 24:00 (meia-noite do dia seguinte). */
export const exitFromInput = (min) => (min === 0 ? DAY_MIN : min);
export const exitToInput = (min) => (min != null && min >= DAY_MIN ? min - DAY_MIN : min);
export const dateOf = (month, day) => `${month}-${pad(day)}`;

export const isLong = (entry, exit) => exit - entry >= LONG_DAY_MIN;
export const defaultSnackDur = (entry, exit) => (isLong(entry, exit) ? SNACK_LONG_DAY : SNACK_SHORT_DAY);

/** Config padrão ao "escalar" um agente num dia vazio. */
export function defaultConfig(taskId) {
  return { taskId, entry: 9 * 60, lunch: 13 * 60, snack: 16 * 60, snackDur: SNACK_LONG_DAY, exit: 18 * 60 };
}

/**
 * ctx = { lunch:{taskId,taskName}, snack:{taskId,taskName}, tasks: Map(taskId -> {taskType,taskId,taskName}) }
 * Converte a configuração do dia (formulário) na lista de shifts salva na planilha.
 */
export function configToShifts(cfg, date, ctx) {
  const main = ctx.tasks.get(cfg.taskId);
  const seg = (t, s, e) => ({ taskType: t.taskType ?? 'generalTask', taskId: t.taskId, taskName: t.taskName, startTime: toIso(date, s), endTime: toIso(date, e) });
  // pausas em ordem de horário: o snack pode vir antes do almoço
  const breaks = [];
  if (cfg.lunch != null) breaks.push([ctx.lunch, cfg.lunch, cfg.lunch + LUNCH_MIN]);
  breaks.push([ctx.snack, cfg.snack, cfg.snack + cfg.snackDur]);
  breaks.sort((a, b) => a[1] - b[1]);
  const out = [];
  let cursor = cfg.entry;
  for (const [t, s, e] of breaks) { out.push(seg(main, cursor, s), seg(t, s, e)); cursor = e; }
  out.push(seg(main, cursor, cfg.exit));
  return out.filter((s) => s.startTime < s.endTime);
}

/** Inverso: shifts -> config. `irregular` = não segue o padrão entrada/almoço/snack/saída. */
export function shiftsToConfig(shifts, ctx) {
  if (!shifts?.length) return { config: null, irregular: false };
  const sorted = [...shifts].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const lunches = sorted.filter((s) => s.taskId === ctx.lunch.taskId);
  const snacks = sorted.filter((s) => s.taskId === ctx.snack.taskId);
  const work = sorted.filter((s) => s.taskId !== ctx.lunch.taskId && s.taskId !== ctx.snack.taskId);
  const mainId = work[0]?.taskId ?? null;
  let irregular = lunches.length > 1 || snacks.length !== 1 || !mainId || work.some((w) => w.taskId !== mainId);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].startTime !== sorted[i - 1].endTime) irregular = true;
  const date0 = isoDate(sorted[0].startTime);
  const entry = isoMin(sorted[0].startTime);
  const exit = isoMinOn(sorted.at(-1).endTime, date0);
  if (exit > DAY_MIN) irregular = true; // vira o dia de verdade (ex.: 22:00 a 02:00): ainda não editável pelo padrão
  const snack = snacks[0] ? isoMin(snacks[0].startTime) : null;
  return {
    irregular,
    config: {
      taskId: mainId,
      entry,
      exit,
      lunch: lunches[0] ? isoMin(lunches[0].startTime) : null,
      snack,
      snackDur: snacks[0] ? isoMinOn(snacks[0].endTime, date0) - snack : defaultSnackDur(entry, exit),
    },
  };
}

/**
 * Aplica a edição de um campo e propaga as regras:
 *  - editar entrada/saída com tudo preenchido => almoço e snack se reposicionam proporcionalmente;
 *  - jornada < 9h => almoço zerado/bloqueado, snack 45min; >= 9h => almoço existe, snack 15min.
 */
export function applyEdit(cfg, field, value) {
  const c = { ...cfg };
  const wasFull = cfg.entry != null && cfg.exit != null && cfg.snack != null && (cfg.lunch != null || !isLong(cfg.entry, cfg.exit));
  c[field] = value;
  if (c.entry == null || c.exit == null) return c;

  if (wasFull && (field === 'entry' || field === 'exit') && cfg.exit > cfg.entry && c.exit > c.entry) {
    const map = (t) => roundMin(c.entry + ((t - cfg.entry) * (c.exit - c.entry)) / (cfg.exit - cfg.entry));
    if (cfg.lunch != null) c.lunch = map(cfg.lunch);
    c.snack = map(cfg.snack);
  }
  const longNow = isLong(c.entry, c.exit);
  const longBefore = cfg.entry != null && cfg.exit != null && isLong(cfg.entry, cfg.exit);
  if (!longNow) c.lunch = null;
  else if (c.lunch == null) c.lunch = roundMin(c.entry + (c.exit - c.entry) * 0.4);
  if (field !== 'snackDur' && (longNow !== longBefore || c.snackDur == null)) c.snackDur = defaultSnackDur(c.entry, c.exit);
  if (c.snack == null) c.snack = roundMin(c.entry + (c.exit - c.entry) * 0.7);
  return c;
}

export const LONG_SHIFT_WARN_MIN = 10 * 60;

/**
 * Valida a configuração do dia. `erros` bloqueiam (gerariam um CSV impossível ou rejeitado pelo WFM: pausa fora do turno ou
 * sobreposta, duração zero, saída antes da entrada); `avisos` só alertam e o supervisor decide (snack antes do almoço,
 * jornada longa sem almoço, pausa colada na entrada ou na saída, jornada acima de 10 h).
 */
export function checkConfig(c) {
  const erros = [], avisos = [];
  if (!c.taskId) erros.push('Selecione o workstream/multitask.');
  if (c.entry == null || c.exit == null) return { erros: [...erros, 'Informe entrada e saída.'], avisos };
  if (c.exit <= c.entry) return { erros: [...erros, 'A saída deve ser depois da entrada.'], avisos };
  if (c.exit > DAY_MIN) erros.push('A saída pode ir no máximo até 24:00 (meia-noite do dia seguinte).');
  if (c.snack == null) return { erros: [...erros, 'Informe o início do snack.'], avisos };
  if (!(c.snackDur > 0)) erros.push('A duração do snack deve ser maior que zero.');
  if (isLong(c.entry, c.exit) && c.lunch == null) avisos.push('Jornada de 9h ou mais sem almoço.');
  const pauses = [];
  if (c.lunch != null) pauses.push({ name: 'almoço', s: c.lunch, e: c.lunch + LUNCH_MIN });
  pauses.push({ name: 'snack', s: c.snack, e: c.snack + (c.snackDur > 0 ? c.snackDur : 0) });
  for (const p of pauses) {
    if (p.s < c.entry) erros.push(`O ${p.name} deve começar depois da entrada.`);
    else if (p.s === c.entry) avisos.push(`O ${p.name} começa junto com a entrada.`);
    if (p.e > c.exit) erros.push(`O ${p.name} deve terminar antes da saída.`);
    else if (p.e === c.exit && p.e > p.s) avisos.push(`O ${p.name} termina junto com a saída.`);
  }
  if (c.lunch != null && c.snackDur > 0) {
    const [first, second] = [...pauses].sort((a, b) => a.s - b.s);
    if (second.s < first.e) erros.push('O almoço e o snack se sobrepõem.');
    else if (c.snack < c.lunch) avisos.push('O snack começa antes do almoço.');
  }
  if (c.exit - c.entry > LONG_SHIFT_WARN_MIN) avisos.push('Jornada acima de 10h.');
  return { erros, avisos };
}
/** Só os erros que bloqueiam (compatível com quem só precisa saber se pode salvar). */
export const validateConfig = (c) => checkConfig(c).erros;

// ---------- Folgas x escala ----------

/** Minutos (fracionários) de `iso` projetados no dia `date`: antes => 0, depois => 1440. */
export function minutesOnDay(iso, date) {
  const d = isoDate(iso);
  if (d < date) return 0;
  if (d > date) return 1440;
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) + Number(iso.slice(17, 19) || 0) / 60;
}

export const timeoffTouchesDay = (t, date) => isoDate(t.startTime) <= date && isoDate(t.endTime) >= date;

/** 'none' | 'partial' | 'full' - quanto das horas escaladas do dia as folgas cobrem (união dos intervalos). */
export function coverage(shifts, date, timeoffs) {
  if (!shifts?.length) return 'none';
  const sorted = [...shifts].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const s0 = isoMin(sorted[0].startTime);
  const s1 = minutesOnDay(sorted.at(-1).endTime, date); // 1440 se termina às 24:00
  const ivs = timeoffs
    .filter((t) => timeoffTouchesDay(t, date))
    .map((t) => [Math.max(s0, minutesOnDay(t.startTime, date)), Math.min(s1, minutesOnDay(t.endTime, date))])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  if (!ivs.length) return 'none';
  let covered = 0;
  let [cs, ce] = ivs[0];
  for (const [a, b] of ivs.slice(1)) {
    if (a <= ce) ce = Math.max(ce, b);
    else { covered += ce - cs; [cs, ce] = [a, b]; }
  }
  covered += ce - cs;
  return covered >= s1 - s0 - 1 ? 'full' : 'partial';
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// ---------- Gerador de escala mensal ----------
// Definição = { weekdays: '23456', entry, lunch, snack, snackDur, exit } (minutos).
// weekdays: dígitos 1..7 = dom..sáb (segunda a sexta = '23456').
export const WD_SHORT = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
export const WD_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export const parseWeekdays = (s) => new Set(String(s ?? '').replace(/[^1-7]/g, '').split('').filter(Boolean).map(Number));
export const weekdaysToString = (set) => [...new Set(set)].sort((a, b) => a - b).join('');
/** Dígito do dia da semana (1=dom..7=sáb) de 'YYYY-MM-DD'. */
export const weekdayDigit = (date) => new Date(date + 'T12:00:00').getDay() + 1;

export function weekdaysLabel(s) {
  const d = [...parseWeekdays(s)].sort((a, b) => a - b);
  if (!d.length) return 'sem dias';
  if (d.length === 7) return 'todos os dias';
  const contiguous = d.length >= 3 && d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return contiguous ? `${WD_NAMES[d[0] - 1]}–${WD_NAMES[d.at(-1) - 1]}` : d.map((x) => WD_NAMES[x - 1]).join(', ');
}

export const definitionSummary = (def) => `${weekdaysLabel(def.weekdays)} · ${minToHHMM(def.entry)}–${minToHHMM(def.exit)}`;

/** { erros, avisos } de uma definição (dias da semana + horários do dia, com as regras de almoço/snack). */
export function checkDefinition(def) {
  const erros = [];
  if (!parseWeekdays(def.weekdays).size) erros.push('Marque ao menos um dia da semana.');
  const r = checkConfig({ taskId: 'x', entry: def.entry, lunch: isLong(def.entry ?? 0, def.exit ?? 0) ? def.lunch : null, snack: def.snack, snackDur: def.snackDur, exit: def.exit });
  return { erros: [...erros, ...r.erros], avisos: r.avisos };
}
export const validateDefinition = (def) => checkDefinition(def).erros;

/** Turnos do mês inteiro a partir de uma definição: { [dia]: Shift[] } (só os dias da semana marcados). */
export function planMonth(def, month, taskId, ctx) {
  const days = parseWeekdays(def.weekdays);
  const out = {};
  for (let d = 1; d <= daysInMonth(month); d++) {
    const date = dateOf(month, d);
    if (!days.has(weekdayDigit(date))) continue;
    out[d] = configToShifts({ taskId, entry: def.entry, lunch: isLong(def.entry, def.exit) ? def.lunch : null, snack: def.snack, snackDur: def.snackDur, exit: def.exit }, date, ctx);
  }
  return out;
}

/**
 * Marcas de folga para a grade: Map email -> { [dia]: { decisao?, agendada?, erro?, aprovada? } } (cada uma com a lista de folgas).
 * decisao = pedido de agente aguardando decisão (status "pendente"); agendada = do app, ainda não enviada; erro = falha no envio;
 * aprovada = já valendo. Folga de vários dias marca todos os dias do mês que ela toca. Negadas não marcam.
 */
export function timeoffMarks(timeoffs, month, n) {
  const first = dateOf(month, 1), last = dateOf(month, n);
  const KINDS = { pendente: 'decisao', agendada: 'agendada', erro: 'erro', aprovada: 'aprovada' };
  const out = new Map();
  for (const t of timeoffs) {
    const kind = KINDS[t.status];
    if (!kind) continue;
    const a = isoDate(t.startTime), b = isoDate(t.endTime);
    if (b < first || a > last) continue;
    const d0 = a < first ? 1 : Number(a.slice(8, 10)), d1 = b > last ? n : Number(b.slice(8, 10));
    if (!out.has(t.email)) out.set(t.email, {});
    const m = out.get(t.email);
    for (let d = d0; d <= d1; d++) ((m[d] ??= {})[kind] ??= []).push(t);
  }
  return out;
}

/**
 * "Já publiquei": pedido de verificação em andamento = pedido feito, sem resultado depois dele e ainda dentro do prazo.
 * Passado o prazo (VERIFY_TTL_MIN) sem resposta, o pedido é considerado "sem resposta" (provável gatilho do Apps Script parado)
 * e o botão volta, para o usuário não ficar bloqueado para sempre.
 */
export const VERIFY_TTL_MIN = 30;
const verifyOpen = (e) => !!e.verifyRequestedAt && (!e.lastCheckAt || e.verifyRequestedAt > e.lastCheckAt);
export const verifyPending = (e, now = Date.now()) => verifyOpen(e) && now - Date.parse(e.verifyRequestedAt) < VERIFY_TTL_MIN * 60000;
export const verifyStale = (e, now = Date.now()) => verifyOpen(e) && !verifyPending(e, now);

// ---------- escolher dias do mês (aplicar a mesma escala em vários dias de um agente) ----------
/**
 * Dias do mês escolhidos por intervalo e dias da semana. `from`/`to`: números de dia (inclusivos); `weekdays`: dígitos 1..7 (dom..sáb) em
 * texto, ou Set; vazio = todos os dias da semana. Dias bloqueados (`locked`, ex.: folga total) nunca entram. Sem `includeEmpty`, só entram dias
 * que já têm escala (`hasShift`): é o "ajustar uma escala que já existe num intervalo" sem escalar o agente em dias de folga por engano.
 */
export function pickDays({ month, from, to, weekdays = '', hasShift = () => true, locked = () => false, includeEmpty = false }) {
  const wd = weekdays instanceof Set ? weekdays : parseWeekdays(weekdays);
  const n = daysInMonth(month), a = Math.max(1, Math.min(from, to)), b = Math.min(n, Math.max(from, to));
  const out = [];
  for (let d = a; d <= b; d++) {
    if (locked(d)) continue;
    if (wd.size && !wd.has(weekdayDigit(dateOf(month, d)))) continue;
    if (!includeEmpty && !hasShift(d)) continue;
    out.push(d);
  }
  return out;
}
