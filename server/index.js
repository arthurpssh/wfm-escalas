// Servidor mock (sem dependências). Simula o que, em produção, seria a camada sobre a planilha/Apps Script.
// Identidade: cabeçalho IDENTITY_HEADER (padrão X-Auth-Request-Email, injetado pelo ingress). Local: DEV_USER_EMAIL.
// No mock o front envia o usuário escolhido em "entrar como".
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo } from './data/repo.js';
import { rowToDefinition } from './core/scales.js';
import { planExports } from './core/exporter.js';
import { runHealthCheck } from './core/health.js';
import { openRemovalsCard } from './core/jira.js';
import { ConflictError, draftView, effectiveCells, staleItems } from './core/drafts.js';
import { ACTIONS } from './core/audit.js';
import { createDraftLocks } from './core/locks.js';
import { createPresence, displayName } from './core/presence.js';
import { buildPortalSchedule, cancelableByAgent, ownTimeoffs } from './core/portal.js';
import { extraDays } from './core/extras.js';
import { STATUS_LABEL as SWAP_LABEL, OPEN as SWAP_OPEN, expiredIds, swapOps, swapWarnings, validateSwap } from './core/swaps.js';
import { notifySwap } from './core/notify.js';
import { defaultTeam, hasAccess, isAdmin, isEmail, resolveAccessMode, resolvePortal, roleFor } from './core/access.js';
import { addDaysIso, checkConfig, daysInMonth, isoDate, localDate, localMonth, parseWeekdays, planMonth, shiftsToConfig, toLocalIso, validateDefinition, verifyPending, verifyStale, weekdayDigit } from '../shared/rules.js';
import { holidaysFor } from './data/holidays.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = Number(process.env.PORT) || 3000;
const GRACE_MIN = Number(process.env.GRACE_MIN ?? 2); // janela para cancelar uma folga antes de ir ao WFM
const CONSOLIDATE_AFTER_SEC = Number(process.env.CONSOLIDATE_AFTER_SEC ?? 0); // mock: >0 simula a verificação agendada do Apps Script (padrão desligado, para testar o botão "Já publiquei")
const IDENTITY_HEADER = (process.env.IDENTITY_HEADER ?? 'x-auth-request-email').toLowerCase();
const DEV_USER_EMAIL = process.env.DEV_USER_EMAIL; // só desenvolvimento local; nunca em produção
const CSV_GAP_DAYS = process.env.CSV_GAP_DAYS ? Number(process.env.CSV_GAP_DAYS) : Infinity; // padrão: sempre um arquivo; número = divide se houver buraco maior
// Modo de entrada: aba Config (access_mode) manda; ACCESS_MODE do ambiente é o padrão. open: todos os autenticados entram e veem tudo | restricted: só quem está em Acessos.
const ENV_ACCESS_MODE = (process.env.ACCESS_MODE ?? 'open').toLowerCase();
if (!['open', 'restricted'].includes(ENV_ACCESS_MODE)) throw new Error(`ACCESS_MODE inválido: ${ENV_ACCESS_MODE} (use open ou restricted)`);
let lastAccessMode = null;
async function accessMode() {
  const r = resolveAccessMode((await repo.settings()).access_mode, ENV_ACCESS_MODE);
  const key = `${r.mode}|${r.source}|${r.invalid}`;
  if (key !== lastAccessMode) { lastAccessMode = key; console.log(`[acesso] modo ${r.mode.toUpperCase()} (${r.source})${r.invalid ? ' · VALOR INVÁLIDO em Config.access_mode: usando restricted por segurança' : ''}`); }
  return r.mode;
}
// Portal do agente: aba Config (agent_portal) manda; AGENT_PORTAL do ambiente é o padrão (off). Desligado, nada muda para ninguém.
const ENV_AGENT_PORTAL = process.env.AGENT_PORTAL ?? 'off';
let lastPortal = null;
async function portalState() {
  const r = resolvePortal((await repo.settings()).agent_portal, ENV_AGENT_PORTAL);
  const key = `${r.on}|${r.source}|${r.invalid}`;
  if (key !== lastPortal) { lastPortal = key; console.log(`[portal] ${r.on ? 'LIGADO' : 'desligado'} (${r.source})${r.invalid ? ' · VALOR INVÁLIDO em Config.agent_portal: mantido desligado' : ''}`); }
  return r;
}
/** Quem é a pessoa para o portal: agente de algum time? tem papel de supervisão? Só agente sem papel (e portal ligado) vê SÓ o portal. */
async function portalCtx(user) {
  const st = await portalState(), e = user.toLowerCase();
  const agent = C.agents.find((a) => a.email.toLowerCase() === e) ?? null;
  const staff = isAdmin(user, actx()) || hasAccess(user, actx()) || C.teams.some((t) => roleFor(user, t, actx()) === 'editor');
  return { on: st.on, agent, staff, agentOnly: st.on && !!agent && !staff };
}
const MOCK_AUTH = process.env.MOCK_AUTH !== '0'; // seletor "entrar como..." (só mock)
// Simular outra pessoa com dados reais, SÓ no seu computador: DEV_IMPERSONATE=1 + ?as=e-mail na URL. O que for gravado fica no nome dessa pessoa.
const DEV_IMPERSONATE = process.env.DEV_IMPERSONATE === '1' && !MOCK_AUTH;
const impersonated = new Set();

// Em contêiner (APP_NAME vem do Dockerfile): a identidade só pode vir do ingress e os dados têm de ser os reais.
if (process.env.APP_NAME) {
  if (process.env.DEV_IMPERSONATE) throw new Error('DEV_IMPERSONATE não pode existir em produção (qualquer pessoa poderia agir como outra): remova do values.yml.');
  if (process.env.DEV_USER_EMAIL) throw new Error('DEV_USER_EMAIL não pode existir em produção (qualquer pessoa seria vista como esse usuário): remova do values.yml/secrets.');
  if ((process.env.DATA_SOURCE ?? 'mock').toLowerCase() === 'mock') console.warn('[AVISO] Contêiner com DATA_SOURCE=mock (dados de exemplo). Defina DATA_SOURCE=sheets no values.yml.');
}
const repo = await createRepo(); // DATA_SOURCE=mock (padrão) | sheets — ver server/data/repo.js
const store = repo.drafts;
const audit = repo.audit;
// Catálogo (times, agentes, atividades...) e acessos do request corrente: carregados no início de api().
let C = null, ACC = [];

const locks = createDraftLocks(); // trava por rascunho: o checkout não pode rodar duas vezes ao mesmo tempo
const dkey = (team, month) => `${team}|${month}`;
// Presença (quem está com o app aberto): só memória; o navegador pinga a cada PRESENCE_PING_SEC e some da lista após PRESENCE_TTL_SEC sem pingar.
const PRESENCE_PING_SEC = Number(process.env.PRESENCE_PING_SEC ?? 20);
const presence = createPresence({ ttlMs: Number(process.env.PRESENCE_TTL_SEC ?? 60) * 1000 });
const PRESENCE_PAGES = ['escalas', 'trocas', 'folgas', 'exportacoes', 'admin'];

class HttpError extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }
const nowMonth = () => localMonth(); // "hoje" e "mês atual" no fuso do app (-03:00), não em UTC
const today = () => localDate();
const actx = () => ({ access: ACC, today: today() });

// ---------- helpers ----------
const send = (res, code, body, headers = {}) => {
  const isStr = typeof body === 'string';
  res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, ko) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { ko(new HttpError(400, 'JSON inválido.')); } });
});
const identify = (req) => {
  // `||` (não `??`): o front envia o cabeçalho vazio quando não há "entrar como"; aí vale o DEV_USER_EMAIL local.
  // Local sem "entrar como" (MOCK_AUTH=0): o DEV_USER_EMAIL manda. Senão um valor antigo do seletor, guardado no navegador
  // (localStorage) e enviado pelo front, passaria a valer como identidade. Em produção não há DEV_USER_EMAIL: vale o cabeçalho do proxy.
  if (DEV_IMPERSONATE) {
    const as = String(req.headers[IDENTITY_HEADER] || '').trim().toLowerCase();
    if (isEmail(as)) { if (!impersonated.has(as)) { impersonated.add(as); console.warn(`[DEV_IMPERSONATE] agindo como ${as} (dados ${repo.kind}); gravações ficam no nome dessa pessoa.`); } return as; }
  }
  const email = String(!MOCK_AUTH && DEV_USER_EMAIL ? DEV_USER_EMAIL : (req.headers[IDENTITY_HEADER] || DEV_USER_EMAIL || '')).trim().toLowerCase();
  if (!email) throw new HttpError(401, 'Identidade ausente.');
  return email;
};
const teamOf = (name) => { const t = C.teams.find((x) => x.name === name); if (!t) throw new HttpError(404, 'Time não encontrado.'); return t; };
const agentsOf = (team) => C.agents.filter((a) => a.team === team);
const requireEditor = (user, team) => { if (roleFor(user, teamOf(team), actx()) !== 'editor') throw new HttpError(403, 'Você tem acesso apenas de visualização a este time.'); };
const requireAdmin = (user) => { if (!isAdmin(user, actx())) throw new HttpError(403, 'Apenas administradores.'); };
const dd = (n) => String(n).padStart(2, '0');
const teamTimeoffs = async (team, m) => {
  const timeoffs = await repo.timeoffs.list(m);
  const emails = new Set(agentsOf(team).map((a) => a.email));
  const first = `${m}-01`, last = `${m}-${dd(daysInMonth(m))}`;
  // pedido do agente ainda na carência (não foi ao WFM) é só do agente: o supervisor passa a ver depois do envio
  return timeoffs.filter((t) => emails.has(t.email) && !(t.request && t.status === 'agendada') && isoDate(t.startTime) <= last && isoDate(t.endTime) >= first);
};

function validateTimeoff(b) {
  if (!C.agents.some((a) => a.email === b.email)) return 'Agente inválido.';
  if (!C.reasons.find((r) => r.taskId === b.reasonId)) return 'Razão inexistente.';
  if (!b.startTime || !b.endTime || b.startTime >= b.endTime) return 'Período inválido (fim deve ser depois do início).';
  return null;
}
/** Dias da semana da escala padrão de cada agente do time (a do gerador, se o supervisor escolheu outra). Base dos dias extras. */
async function weekdaysOfTeam(team) {
  return Object.fromEntries(agentsOf(team).map((a) => [a.email, a.def?.weekdays ?? '']));
}

/**
 * Contexto para validar trocas e calcular avisos: escala (publicada + exportações a consolidar) dos meses em volta das datas, folgas que valem
 * (aprovadas ou agendadas) e trocas em aberto do time. `dates`: datas 'YYYY-MM-DD' envolvidas.
 */
async function swapContext(team, dates) {
  const months = [...new Set(dates.flatMap((d) => [addDaysIso(d, -8), d, addDaysIso(d, 8)].map((x) => x.slice(0, 7))))];
  const cells = {}, tos = new Map();
  for (const mo of months) {
    cells[mo] = (await baseCellsOf(team, mo)).cells;
    for (const t of await repo.timeoffs.list(mo)) tos.set(t.id, t);
  }
  const wd = await weekdaysOfTeam(team);
  const active = [...tos.values()].filter((t) => ['aprovada', 'agendada'].includes(t.status));
  return {
    today: localDate(), team: new Set(agentsOf(team).map((a) => a.email)),
    shiftsOn: (email, date) => cells[date.slice(0, 7)]?.[email]?.[Number(date.slice(8, 10))] ?? [],
    weekdaysOf: (email) => wd[email] ?? '',
    timeoffOn: (email, date) => active.some((t) => t.email === email && isoDate(toLocalIso(t.startTime)) <= date && isoDate(toLocalIso(t.endTime)) >= date),
    openSwaps: (await repo.swaps.list()).filter((s) => s.team === team),
  };
}
/** Troca em aberto cujo dia chegou vira "expirada" (feito na hora de listar). */
async function expireSwaps() {
  const list = await repo.swaps.list();
  for (const id of expiredIds(list, localDate())) await repo.swaps.update(id, { status: 'expirada', updatedAt: new Date().toISOString() });
}
const swapDates = (s) => [s.date, s.offerDate].filter(Boolean);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

const LOT_MAX = 300; // agentes por lote

/**
 * Prévia de um lote de folgas: por agente do time, se tem turno no período, se a escala padrão dele cai no período e quais folgas já se sobrepõem
 * (agendadas, pendentes ou aprovadas). A tela usa isso para sugerir quem marcar e avisar de conflitos; quem decide é o supervisor.
 */
async function lotPreview(team, startTime, endTime) {
  const s0 = toLocalIso(startTime), s1 = toLocalIso(endTime);
  const d0 = s0.slice(0, 10), d1 = s1.slice(0, 10);
  const dates = [];
  for (let d = d0; d <= d1; d = addDaysIso(d, 1)) { dates.push(d); if (dates.length > 366) throw new HttpError(422, 'Período longo demais (máximo de 1 ano).'); }
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  const cells = {};
  for (const mo of months) cells[mo] = (await baseCellsOf(team, mo)).cells;
  const seen = new Map();
  for (const mo of months) for (const t of await repo.timeoffs.list(mo)) seen.set(t.id, t);
  const ACTIVE = new Set(['agendada', 'pendente', 'aprovada']);
  const mine = [...seen.values()].filter((t) => ACTIVE.has(t.status) && toLocalIso(t.startTime) < s1 && toLocalIso(t.endTime) > s0);
  return agentsOf(team).map((a) => {
    const wd = parseWeekdays(a.def?.weekdays);
    const stdWorks = wd.size ? dates.some((d) => wd.has(weekdayDigit(d))) : null; // null = sem escala padrão cadastrada
    const shiftDays = dates.filter((d) => (cells[d.slice(0, 7)]?.[a.email]?.[Number(d.slice(8, 10))] ?? []).length).length;
    const conflicts = mine.filter((t) => t.email === a.email).map((t) => ({ id: t.id, reasonName: t.reasonName, status: t.status, startTime: t.startTime, endTime: t.endTime }));
    return { email: a.email, name: a.name, hasShift: shiftDays > 0, shiftDays, stdWorks, conflicts };
  });
}

/** Resumo de um lote para a tela. */
function lotView(lot) {
  const it = lot.items, first = it[0];
  const count = (s) => it.filter((i) => i.status === s).length;
  const pending = it.filter((i) => i.status === 'agendada').map((i) => i.scheduledAt).filter(Boolean).sort();
  return {
    loteId: lot.loteId, createdBy: first.createdBy, createdAt: first.createdAt, reasonName: first.reasonName,
    startTime: first.startTime, endTime: first.endTime, total: it.length,
    agendada: count('agendada'), enviada: count('enviada'), erro: count('erro'), cancelada: count('cancelada'),
    nextSendAt: pending[0] ?? null, agents: it.map((i) => i.email),
    errors: it.filter((i) => i.status === 'erro').slice(0, 5).map((i) => ({ email: i.email, note: i.note })),
  };
}
const schedulePending = () => new Date(Date.now() + GRACE_MIN * 60_000).toISOString();

// ---------- exportações (arquivos CSV) ----------
const OPEN = ['aguardando_verificacao', 'nao_publicada'];

/** Escala base = publicado + dias de exportações ainda não consolidadas (o que o supervisor já pediu ao WFM). */
async function baseCellsOf(team, month) {
  const cells = await repo.cells(month);
  const out = {};
  for (const a of agentsOf(team)) out[a.email] = { ...(cells[a.email] ?? {}) };
  const pending = {};
  for (const e of await repo.exports.list()) {
    if (e.team !== team || e.month !== month || !OPEN.includes(e.status)) continue;
    for (const [email, days] of Object.entries(e.expected)) {
      for (const [d, shifts] of Object.entries(days)) {
        if (!out[email]) continue;
        if (shifts.length) out[email][d] = shifts; else delete out[email][d];
        (pending[email] ??= new Set()).add(Number(d));
      }
    }
  }
  return { cells: out, pending: Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, [...v]])) };
}

/** Avisos de regra (não bloqueiam) dos dias do rascunho, calculados no servidor com as mesmas regras do navegador. */
function configWarnings(items) {
  const ctx = { lunch: C.ctx.lunch, snack: C.ctx.snack, tasks: new Map(C.activities.map((a) => [a.taskId, a])) };
  const out = [];
  for (const i of items) {
    if (!i.after?.length) continue;
    const { config, irregular } = shiftsToConfig(i.after, ctx);
    if (!config || irregular) continue;
    const { avisos } = checkConfig(config);
    if (avisos.length) out.push({ email: i.email, agentName: C.agents.find((a) => a.email === i.email)?.name, day: i.day, avisos });
  }
  return out;
}

/** Dia 1 do mês seguinte por agente (só importa quando um turno do último dia do mês termina às 24:00). null = não deu para ler. */
async function nextMonthFirstDay(team, month) {
  const [y, mo] = month.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${dd(mo + 1)}`;
  try {
    const cells = (await baseCellsOf(team, next)).cells;
    return Object.fromEntries(Object.entries(cells).map(([email, days]) => [email, days[1] ?? []]));
  } catch { return null; }
}

// ---------- revisão / checkout ----------
async function buildReview(team, month) {
  const agents = agentsOf(team);
  const emails = agents.map((a) => a.email);
  const d = store.get(team, month);
  const items = [...(d?.items.values() ?? [])].sort((a, b) => a.email.localeCompare(b.email) || a.day - b.day);
  const base = await baseCellsOf(team, month);
  const eff = effectiveCells(base.cells, d, emails);
  const stale = staleItems(d, base.cells);
  const health = runHealthCheck({ month, agents, cells: eff, timeoffs: await repo.timeoffs.list(month) });
  const plan = planExports({ team, month, items, baseCells: base.cells, nextMonthFirst: await nextMonthFirstDay(team, month), agents, activities: C.activities, today: today(), gapDays: CSV_GAP_DAYS });
  const unexpressible = plan.unexpressible.map((u) => ({ agent: agents.find((a) => a.email === u.email), date: `${month}-${dd(u.day)}`, previousShifts: u.before }));
  return { draft: d, items, stale, health, plan, unexpressible };
}

/** Confirma o rascunho. Com a trava, um segundo checkout do mesmo rascunho (outra pessoa ou outra aba) recebe 409 em vez de gerar exportações duplicadas. */
async function checkout(user, args) {
  requireEditor(user, args.team);
  const key = dkey(args.team, args.month);
  const r = await locks.run(key, user, 'confirmando', () => doCheckout(user, args));
  presence.markEdit(user, args.team, args.month);
  locks.markDone(key, user);
  return r;
}

async function doCheckout(user, { team, month, version }) {
  const rv = await buildReview(team, month);
  if (!rv.draft) {
    const rec = locks.recent(dkey(team, month));
    if (rec) throw new HttpError(409, `Este rascunho acabou de ser confirmado por ${rec.user}. Recarregue a página e confira em Exportações.`);
    throw new HttpError(422, 'Não há alterações no rascunho.');
  }
  if (Number(version) !== rv.draft.version) throw new ConflictError();
  if (rv.stale.length) throw new HttpError(409, 'Alguns dias foram alterados no WFM depois de entrarem no rascunho. Descarte-os ou reabra o rascunho.', { violations: rv.stale.map((s) => `${s.email} dia ${s.day}`) });
  if (!rv.health.ok) throw new HttpError(422, 'Health check reprovado.', { violations: rv.health.violations.map((v) => v.message) });
  if (rv.plan.errors.length) throw new HttpError(422, 'Pré-voo do CSV reprovado.', { violations: rv.plan.errors });
  if (!rv.plan.files.length && !rv.unexpressible.length) throw new HttpError(422, 'Nada a exportar.');

  const batchId = randomUUID().slice(0, 8);
  // 1) Arquivos primeiro (com sheets: CSV no Drive + linha em Exportacoes). Se falhar, nada foi registrado e o rascunho continua intacto.
  // O publicado NÃO muda aqui: só muda quando a verificação (Apps Script) consolidar cada arquivo.
  await repo.exports.addMany(rv.plan.files.map((f) => ({
    id: randomUUID().slice(0, 8), batchId, team, month, name: f.name, window: f.window, agents: f.agents, rows: f.rows, expected: f.expected,
    csv: f.csv, csvHash: createHash('sha1').update(f.csv).digest('hex').slice(0, 10), status: 'aguardando_verificacao', createdAt: Date.now(), createdBy: user, attempts: 0,
  })));
  // 2) Fallback: remoções que o CSV não consegue expressar (card do Jira; hoje em dry-run)
  let jira = null;
  if (rv.unexpressible.length) {
    jira = await openRemovalsCard({ team, month, removals: rv.unexpressible, requestedBy: user });
    audit.log({ actor: user, team, month, action: 'jira.card', batchId, details: jira.error ? `erro: ${jira.error}` : `${jira.key}${jira.dryRun ? ' (simulado)' : ''} — ${rv.unexpressible.length} dia(s)` });
  }
  const batch = {
    batchId, team, month, createdBy: user, createdAt: Date.now(), items: rv.items.length, emails: [...new Set(rv.items.map((i) => i.email))],
    files: rv.plan.files.length, csvRows: rv.plan.files.reduce((n, f) => n + f.rows, 0),
    removals: rv.unexpressible.map((r) => ({ email: r.agent.email, date: r.date })),
    jira: jira ? { key: jira.key, url: jira.url, dryRun: jira.dryRun, error: jira.error } : null,
  };
  await repo.batches.add(batch);
  for (const it of rv.items) audit.log({ actor: user, team, month, action: 'checkout', agentEmail: it.email, day: it.day, before: it.before, after: it.after, batchId, details: it.kind });
  store.close(team, month); // por último: só depois de arquivos e lote gravados
  await repo.flush?.(); // sheets: o rascunho fechado também vai para a planilha antes de responder
  return { batchId, files: rv.plan.files.map((f) => ({ name: f.name, csv: f.csv, rows: f.rows, window: f.window, agents: f.agents })), jira: batch.jira, unexpressible: rv.unexpressible.length };
}

const batchView = (b, exportsLog) => ({
  ...b, createdAt: new Date(b.createdAt).toISOString(),
  exports: exportsLog.filter((e) => e.batchId === b.batchId).map((e) => ({ name: e.name, status: e.status, window: e.window, agents: e.agents.length })),
});

const exportView = (e) => ({
  id: e.id, batchId: e.batchId, team: e.team, month: e.month, name: e.name, window: e.window, agents: e.agents.length, agentList: e.agents, rows: e.rows,
  status: e.status, createdAt: new Date(e.createdAt).toISOString(), createdBy: e.createdBy, attempts: e.attempts ?? 0, lastCheckAt: e.lastCheckAt ?? null,
  consolidatedAt: e.consolidatedAt ?? null, deleteAfter: e.deleteAfter ?? null, note: e.note ?? '', verifyRequestedAt: e.verifyRequestedAt ?? null,
  diffs: e.diffs ?? null, diffTotal: e.diffTotal ?? null,
  verifyPending: verifyPending(e), verifyStale: verifyStale(e), // calculado no servidor (relógio único)
});

// ---------- API ----------
async function api(req, res, url) {
  const q = url.searchParams;
  const path = url.pathname;
  const m = q.get('month') || nowMonth();

  if (req.method === 'GET' && path === '/api/health') return send(res, 200, { status: 'ok' }); // instantâneo: não consulta Sheets nem WFM
  if (req.method === 'GET' && path === '/api/dev/impersonate') return send(res, 200, { enabled: DEV_IMPERSONATE });
  if (req.method === 'GET' && path === '/api/mock/users') return send(res, 200, MOCK_AUTH ? (await repo.catalog()).logins : []);
  // mock: simula o Apps Script (envio de folgas, consolidação de exportações). Sheets: lê os resultados do Apps Script; se o Google recusar por cota,
  // a requisição segue com o que já se sabe (a próxima lê de novo) em vez de falhar.
  try { await repo.tick(); } catch (e) { if (e.code !== 'sheets_unavailable') throw e; console.warn(`[sheets] tick adiado: ${e.message}`); }
  C = await repo.catalog();
  ACC = await repo.access.list();
  const need = (cap) => { if (repo.capabilities && !repo.capabilities[cap]) throw new HttpError(503, `Ainda não disponível com DATA_SOURCE=sheets (${cap}): a escrita chega por etapas na Fase 3.`); };

  if (req.method === 'GET' && path === '/api/meta') {
    return send(res, 200, {
      defaultMonth: nowMonth(), graceMinutes: GRACE_MIN, mockAuth: MOCK_AUTH,
      readOnly: !!repo.readOnly, source: repo.kind, capabilities: repo.capabilities ?? null,
      workTasks: C.activities.filter((a) => a.taskType !== 'generalTask' || a.taskName === 'Backoffice Hotmart'),
      lunch: C.ctx.lunch, snack: C.ctx.snack, timeoffReasons: C.reasons, actions: ACTIONS,
    });
  }

  const user = identify(req);
  const pc = await portalCtx(user);
  if (pc.agentOnly) {
    // Agente (sem papel de supervisão) com o portal ligado: entra sempre (mesmo no modo restrito) e só vê o portal.
    if (!(path === '/api/me' || path === '/api/meta' || path.startsWith('/api/portal/'))) throw new HttpError(403, 'Esta área é da supervisão. Use "Minha escala".', { code: 'agent_only' });
  } else if ((await accessMode()) === 'restricted' && !hasAccess(user, actx())) {
    throw new HttpError(403, 'Você ainda não tem acesso a este app. Peça a liberação a quem administra a aba Acessos.', { code: 'no_access' });
  }

  // ----- presença: o ping já devolve quem está no mesmo time e mês (sem segunda consulta). Não grava nada, não entra no histórico. -----
  if (req.method === 'POST' && path === '/api/presence') {
    const b = await readBody(req);
    const sid = String(b.sid ?? '');
    if (b.leave) { presence.leave(sid, user); return send(res, 200, { ok: true }); }
    if (!/^[\w-]{8,64}$/.test(sid)) throw new HttpError(400, 'sid inválido.');
    const page = PRESENCE_PAGES.includes(b.page) ? b.page : 'escalas';
    const team = C.teams.some((x) => x.name === b.team) ? b.team : '';
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month ?? '')) ? b.month : '';
    presence.ping({ sid, email: user, page, team, month, visible: b.visible !== false });
    return send(res, 200, { intervalSec: PRESENCE_PING_SEC, online: presence.users({ team, month, excludeEmail: user }) });
  }

  if (req.method === 'GET' && path === '/api/me') {
    const teams = pc.agentOnly ? [] : C.teams.map((t) => ({ name: t.name, coordinator: t.coordinator, role: roleFor(user, t, actx()), agentCount: agentsOf(t.name).length }));
    return send(res, 200, { email: user, isAdmin: isAdmin(user, actx()), teams, defaultTeam: pc.agentOnly ? null : defaultTeam(user, C.teams, actx()), agentOnly: pc.agentOnly, isAgent: !!pc.agent, portal: pc.on });
  }

  // ----- portal do agente (somente leitura): o time do próprio agente e as folgas dele -----
  if (path.startsWith('/api/portal/')) {
    if (!pc.agent) throw new HttpError(404, 'Você não aparece como agente de nenhum time.');
    if (!pc.on && !isAdmin(user, actx())) throw new HttpError(403, 'O portal do agente ainda não foi liberado.', { code: 'portal_off' });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new HttpError(422, 'Mês inválido.');
    const team = pc.agent.team;
    if (req.method === 'GET' && path === '/api/portal/schedule') {
      const agents = agentsOf(team);
      const all = await repo.cells(m); // PUBLICADO (extração do WFM): nunca o rascunho do supervisor
      const cells = Object.fromEntries(agents.map((a) => [a.email, all[a.email] ?? {}]));
      const vac = String((await repo.settings()).reason_vacation ?? '').trim();
      const vacationReasonId = C.reasons.some((r) => r.taskId === vac) ? vac : '';
      const view = buildPortalSchedule({ agents, self: user.toLowerCase(), month: m, cells, timeoffs: await teamTimeoffs(team, m), vacationReasonId, extra: extraDays({ month: m, cells, weekdays: await weekdaysOfTeam(team) }) });
      return send(res, 200, { month: m, today: localDate(), daysInMonth: daysInMonth(m), teamLabel: `Time de ${displayName(team)}`, ...view });
    }
    // ----- trocas de dia extra (agente): pedir, o colega aceitar ou recusar, quem pediu cancelar -----
    const nameOf = (email) => agentsOf(team).find((a) => a.email === email)?.name ?? email;
    if (req.method === 'GET' && path === '/api/portal/swaps') {
      await expireSwaps();
      const me = pc.agent.email.toLowerCase(), floor = addDaysIso(localDate(), -60);
      const mine = (await repo.swaps.list()).filter((s) => s.team === team && (s.requester === me || s.owner === me) && swapDates(s).some((d) => d >= floor));
      return send(res, 200, mine.map((s) => ({
        id: s.id, role: s.requester === me ? 'solicitante' : 'dono', otherName: nameOf(s.requester === me ? s.owner : s.requester), date: s.date, offerDate: s.offerDate || '',
        status: s.status, statusLabel: SWAP_LABEL[s.status] ?? s.status, refusedBy: s.refusedBy || '', createdAt: s.createdAt, note: s.status === 'invalidada' ? s.note : '',
      })));
    }
    if (req.method === 'POST' && path === '/api/portal/swaps') {
      need('swaps');
      await expireSwaps();
      const b = await readBody(req), me = pc.agent.email.toLowerCase();
      const owner = agentsOf(team).find((a) => String(a.id) === String(b.ownerId));
      if (!owner) throw new HttpError(404, 'Colega não encontrado no seu time.');
      if (!isDate(b.date) || (b.offerDate && !isDate(b.offerDate))) throw new HttpError(422, 'Data inválida.');
      const now = new Date().toISOString();
      const swap = { id: randomUUID().slice(0, 8), team, requester: me, owner: owner.email.toLowerCase(), date: b.date, offerDate: b.offerDate || '', status: 'pendente_agente', refusedBy: '', createdAt: now, updatedAt: now, decidedBy: '', note: '' };
      const ctx = await swapContext(team, swapDates(swap));
      if (ctx.openSwaps.filter((s) => s.requester === me && SWAP_OPEN.includes(s.status)).length >= 10) throw new HttpError(409, 'Você já tem 10 pedidos de troca em aberto.');
      const errs = validateSwap(swap, ctx);
      if (errs.length) throw new HttpError(422, errs[0], { violations: errs });
      await repo.swaps.add(swap);
      audit.log({ actor: user, team, month: swap.date.slice(0, 7), action: 'swap.request', agentEmail: swap.owner, details: `${swap.id}: ${me} pede o dia ${swap.date} de ${swap.owner}${swap.offerDate ? ` e oferece ${swap.offerDate}` : ''}` });
      notifySwap({ event: 'pedido', swap });
      return send(res, 201, { id: swap.id });
    }
    const smatch = path.match(/^\/api\/portal\/swaps\/([\w-]+)\/(respond|cancel)$/);
    if (req.method === 'POST' && smatch) {
      need('swaps');
      const swap = await repo.swaps.get(smatch[1]), me = pc.agent.email.toLowerCase();
      if (!swap || swap.team !== team || (swap.requester !== me && swap.owner !== me)) throw new HttpError(404, 'Troca não encontrada.');
      const now = new Date().toISOString(), month = swap.date.slice(0, 7);
      if (smatch[2] === 'cancel') {
        if (swap.requester !== me) throw new HttpError(403, 'Só quem pediu pode cancelar.');
        if (!SWAP_OPEN.includes(swap.status)) throw new HttpError(409, 'Essa troca já foi decidida ou encerrada.');
        await repo.swaps.update(swap.id, { status: 'cancelada', updatedAt: now });
        audit.log({ actor: user, team, month, action: 'swap.cancel', agentEmail: swap.owner, details: swap.id });
        return send(res, 200, { ok: true });
      }
      if (swap.owner !== me) throw new HttpError(403, 'Só o colega dono do dia responde ao pedido.');
      if (swap.status !== 'pendente_agente') throw new HttpError(409, 'Essa troca não está aguardando a sua resposta.');
      const b = await readBody(req);
      if (b.accept === true) {
        const errs = validateSwap(swap, await swapContext(team, swapDates(swap)), swap.id);
        if (errs.length) {
          await repo.swaps.update(swap.id, { status: 'invalidada', note: errs[0], updatedAt: now });
          audit.log({ actor: user, team, month, action: 'swap.invalidate', agentEmail: swap.requester, details: `${swap.id}: ${errs[0]}` });
          throw new HttpError(409, `Essa troca não vale mais: ${errs[0]}`);
        }
        await repo.swaps.update(swap.id, { status: 'pendente_supervisor', updatedAt: now });
        audit.log({ actor: user, team, month, action: 'swap.respond', agentEmail: swap.requester, details: `${swap.id}: aceita` });
        notifySwap({ event: 'aceita', swap });
      } else {
        await repo.swaps.update(swap.id, { status: 'recusada', refusedBy: 'agente', updatedAt: now });
        audit.log({ actor: user, team, month, action: 'swap.respond', agentEmail: swap.requester, details: `${swap.id}: recusada` });
        notifySwap({ event: 'recusada_agente', swap });
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/api/portal/timeoffs') {
      return send(res, 200, ownTimeoffs(await repo.timeoffs.list(m), pc.agent.email.toLowerCase(), m));
    }
    if (req.method === 'POST' && path === '/api/portal/timeoffs') {
      need('timeoffs');
      const b = await readBody(req);
      const reason = C.reasons.find((r) => r.taskId === b.reasonId);
      if (!reason) throw new HttpError(422, 'Escolha o motivo da folga.');
      if (!b.startTime || !b.endTime || b.startTime >= b.endTime) throw new HttpError(422, 'Período inválido (o fim deve ser depois do início).');
      const s0 = toLocalIso(b.startTime), s1 = toLocalIso(b.endTime);
      if (!(Date.parse(`${s1.slice(0, 10)}T12:00:00Z`) - Date.parse(`${s0.slice(0, 10)}T12:00:00Z`) <= 400 * 86400000)) throw new HttpError(422, 'Período longo demais.');
      const email = pc.agent.email.toLowerCase();
      const mine = (await repo.timeoffs.list(s0.slice(0, 7))).filter((t) => t.email.toLowerCase() === email);
      const clash = mine.find((t) => ['agendada', 'pendente', 'aprovada'].includes(t.status) && toLocalIso(t.startTime) < s1 && toLocalIso(t.endTime) > s0);
      if (clash) throw new HttpError(409, `Você já tem uma folga ou pedido nesse período (${clash.reasonName}).`);
      if (mine.filter(cancelableByAgent).length >= 20) throw new HttpError(409, 'Você já tem 20 pedidos aguardando decisão. Espere a supervisão decidir ou cancele algum.');
      const t = { id: randomUUID(), email: pc.agent.email, reasonId: reason.taskId, reasonName: reason.taskName, startTime: b.startTime, endTime: b.endTime, status: 'agendada', request: true, origin: 'agent', createdAt: new Date().toISOString(), scheduledAt: schedulePending(), createdBy: user };
      await repo.timeoffs.add(t);
      audit.log({ actor: user, team, month: s0.slice(0, 7), action: 'timeoff.request', agentEmail: t.email, after: t, details: reason.taskName });
      return send(res, 201, { id: t.id, scheduledAt: t.scheduledAt });
    }
    const pc2 = path.match(/^\/api\/portal\/timeoffs\/([\w-]+)\/cancel$/);
    if (req.method === 'POST' && pc2) {
      need('timeoffs');
      const t = await repo.timeoffs.get(pc2[1]);
      if (!t || t.email.toLowerCase() !== pc.agent.email.toLowerCase()) throw new HttpError(404, 'Pedido não encontrado.');
      if (t.request && t.status === 'agendada') { // ainda na carência: nada foi ao WFM
        await repo.timeoffs.remove(t.id);
        audit.log({ actor: user, team, month: isoDate(t.startTime).slice(0, 7), action: 'timeoff.request.cancel', agentEmail: t.email, before: t, details: `${t.reasonName} (antes do envio)` });
        return send(res, 200, { ok: true });
      }
      if (t.status === 'pendente') { // já no WFM e ainda sem decisão: nega por id
        const upd = await repo.timeoffs.update(t.id, { status: 'negada', decidedBy: user, deniedAt: new Date().toISOString() });
        if (!upd) throw new HttpError(409, 'Este pedido acabou de ser enviado ao WFM e ainda não voltou na extração. Tente de novo em alguns minutos.');
        audit.log({ actor: user, team, month: isoDate(t.startTime).slice(0, 7), action: 'timeoff.request.cancel', agentEmail: t.email, before: t, details: `${t.reasonName} (cancelado pelo agente)` });
        return send(res, 200, { ok: true });
      }
      throw new HttpError(409, 'Só dá para cancelar um pedido que ainda aguarda decisão.');
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  if (req.method === 'GET' && path === '/api/schedule') {
    const team = teamOf(q.get('team') ?? defaultTeam(user, C.teams, actx()));
    const agents = agentsOf(team.name);
    const d = store.get(team.name, m);
    const base = await baseCellsOf(team.name, m);
    return send(res, 200, {
      month: m, team: team.name, role: roleFor(user, team, actx()), daysInMonth: daysInMonth(m), agents,
      cells: effectiveCells(base.cells, d, agents.map((a) => a.email)), draft: draftView(d), pending: base.pending,
      extra: extraDays({ month: m, cells: effectiveCells(base.cells, d, agents.map((a) => a.email)), weekdays: await weekdaysOfTeam(team.name) }),
    });
  }

  // ----- rascunho -----
  if (req.method === 'PUT' && path === '/api/draft/day') {
    need('drafts');
    const b = await readBody(req);
    requireEditor(user, b.team);
    const agent = agentsOf(b.team).find((a) => a.email === b.email);
    if (!agent) throw new HttpError(404, 'Agente não pertence ao time.');
    for (const s of b.shifts ?? []) if (s.startTime >= s.endTime) throw new HttpError(422, 'Atividade com duração zero.');
    const published = (await baseCellsOf(b.team, b.month)).cells[b.email]?.[b.day] ?? [];
    locks.assertFree(dkey(b.team, b.month)); // não altera o rascunho no meio de um checkout (a edição se perderia ao fechar)
    const d = store.saveDay({ team: b.team, month: b.month, email: b.email, day: b.day, after: b.shifts ?? [], published, user, version: b.version });
    presence.markEdit(user, b.team, b.month);
    audit.log({ actor: user, team: b.team, month: b.month, action: 'draft.save', agentEmail: b.email, day: b.day, before: published, after: b.shifts ?? [] });
    return send(res, 200, { ok: true, draft: draftView(d) });
  }
  // a mesma escala em vários dias de um agente (clicar no nome do agente na grade): entra no rascunho de uma vez
  if (req.method === 'PUT' && path === '/api/draft/days') {
    need('drafts');
    const b = await readBody(req);
    requireEditor(user, b.team);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month ?? ''))) throw new HttpError(422, 'Mês inválido.');
    if (!agentsOf(b.team).some((a) => a.email === b.email)) throw new HttpError(404, 'Agente não pertence ao time.');
    const days = Array.isArray(b.days) ? b.days : [];
    if (!days.length) throw new HttpError(422, 'Selecione ao menos um dia.');
    const nDays = daysInMonth(b.month), seen = new Set();
    for (const x of days) {
      if (!Number.isInteger(x.day) || x.day < 1 || x.day > nDays) throw new HttpError(422, `Dia inválido: ${x.day}.`);
      if (seen.has(x.day)) throw new HttpError(422, `Dia repetido: ${x.day}.`);
      seen.add(x.day);
      for (const s of x.shifts ?? []) if (s.startTime >= s.endTime) throw new HttpError(422, `Dia ${x.day}: atividade com duração zero.`);
    }
    const base = (await baseCellsOf(b.team, b.month)).cells[b.email] ?? {};
    locks.assertFree(dkey(b.team, b.month));
    const entries = days.map((x) => ({ day: x.day, after: x.shifts ?? [], published: base[x.day] ?? [] }));
    const d = store.saveDays({ team: b.team, month: b.month, email: b.email, entries, user, version: b.version });
    presence.markEdit(user, b.team, b.month);
    for (const e of entries) audit.log({ actor: user, team: b.team, month: b.month, action: 'draft.save', agentEmail: b.email, day: e.day, before: e.published, after: e.after, details: `em lote (${entries.length} dia(s))` });
    return send(res, 200, { ok: true, days: entries.length, draft: draftView(d) });
  }
  if (req.method === 'DELETE' && path === '/api/draft/item') {
    need('drafts');
    const team = q.get('team'); requireEditor(user, team);
    locks.assertFree(dkey(team, m));
    const d = store.discardItem({ team, month: m, email: q.get('email'), day: Number(q.get('day')), user, version: q.get('version') });
    presence.markEdit(user, team, m);
    audit.log({ actor: user, team, month: m, action: 'draft.item.discard', agentEmail: q.get('email'), day: Number(q.get('day')) });
    return send(res, 200, { ok: true, draft: draftView(d) });
  }
  if (req.method === 'DELETE' && path === '/api/draft') {
    need('drafts');
    const team = q.get('team'); requireEditor(user, team);
    locks.assertFree(dkey(team, m));
    const d = store.discard({ team, month: m, version: q.get('version') });
    presence.markEdit(user, team, m);
    audit.log({ actor: user, team, month: m, action: 'draft.discard', details: `${d?.items.size ?? 0} alteração(ões) descartada(s)` });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && path === '/api/draft/review') {
    const team = q.get('team');
    const rv = await buildReview(team, m);
    return send(res, 200, {
      version: rv.draft?.version ?? 0, items: rv.items.map((i) => ({ ...i, agentName: C.agents.find((a) => a.email === i.email)?.name })),
      stale: rv.stale.map((s) => ({ email: s.email, day: s.day })), health: rv.health,
      files: rv.plan.files.map((f) => ({ name: f.name, window: f.window, agents: f.agents.length, rows: f.rows, days: f.days, reemitted: f.reemitted })),
      errors: rv.plan.errors, warnings: rv.plan.warnings, configWarnings: configWarnings(rv.items),
      unexpressible: rv.unexpressible.map((r) => ({ email: r.agent.email, date: r.date })),
    });
  }
  if (req.method === 'POST' && path === '/api/draft/checkout') {
    need('checkout');
    return send(res, 200, await checkout(user, await readBody(req)));
  }
  if (req.method === 'GET' && path === '/api/batches') {
    const team = q.get('team');
    const ex = await repo.exports.list();
    return send(res, 200, (await repo.batches.list()).filter((b) => b.team === team && b.month === m).slice(0, 10).map((b) => batchView(b, ex)));
  }

  // ----- gerador de escala mensal -----
  if (req.method === 'GET' && path === '/api/generator') {
    const team = teamOf(q.get('team') ?? defaultTeam(user, C.teams, actx()));
    const ov = await repo.genConfig.get(team.name);
    const scales = C.standardScales.map((sc) => ({ id: sc.id, ...rowToDefinition(sc) }));
    return send(res, 200, {
      team: team.name, month: m, role: roleFor(user, team, actx()),
      taskId: ov?.taskId ?? team.defaultTaskId, defaultTaskId: team.defaultTaskId,
      tasks: C.activities.filter((a) => a.taskType !== 'generalTask'),
      scales,
      agents: agentsOf(team.name).map((a) => ({ email: a.email, name: a.name, scaleId: a.scaleId, def: a.def })), // sempre o cadastro (Users)
    });
  }
  if (req.method === 'POST' && path === '/api/draft/generate') {
    need('generator');
    const b = await readBody(req);
    requireEditor(user, b.team);
    const task = C.activities.find((a) => a.taskId === b.taskId && a.taskType !== 'generalTask');
    if (!task) throw new HttpError(422, 'Selecione um workstream ou multitask válido.');
    const teamAgents = new Map(agentsOf(b.team).map((a) => [a.email, a]));
    const byScale = new Map(C.standardScales.map((sc) => [sc.id, { id: sc.id, ...rowToDefinition(sc) }]));
    const errors = [];
    const resolved = (b.agents ?? []).map((x) => {
      if (!teamAgents.has(x.email)) { errors.push(`${x.email}: agente não pertence ao time.`); return null; }
      if (x.scaleId && !byScale.has(x.scaleId)) { errors.push(`${x.email}: escala padrão ${x.scaleId} inexistente.`); return null; }
      const def = x.scaleId ? byScale.get(x.scaleId) : { weekdays: String(x.def?.weekdays ?? ''), entry: x.def?.entry, lunch: x.def?.lunch ?? null, snack: x.def?.snack, snackDur: x.def?.snackDur, exit: x.def?.exit };
      const errs = validateDefinition(def);
      if (errs.length) errors.push(`${teamAgents.get(x.email).name}: ${errs.join(' ')}`);
      return { email: x.email, scaleId: x.scaleId ?? null, def };
    }).filter(Boolean);
    if (!resolved.length) throw new HttpError(422, 'Nenhum agente informado.');
    if (errors.length) throw new HttpError(422, 'Há definições inválidas.', { violations: errors });

    const base = (await baseCellsOf(b.team, b.month)).cells;
    const entries = [];
    for (const r of resolved) {
      const plan = planMonth(r.def, b.month, b.taskId, C.ctx);
      for (let d = 1; d <= daysInMonth(b.month); d++) entries.push({ email: r.email, day: d, after: plan[d] ?? [], published: base[r.email]?.[d] ?? [] });
    }
    locks.assertFree(dkey(b.team, b.month));
    const d = store.replaceAgents({ team: b.team, month: b.month, emails: resolved.map((r) => r.email), entries, user, version: b.version });
    presence.markEdit(user, b.team, b.month);
    // guarda as configurações (mock da aba GeradorConfig): a próxima abertura do gerador já vem com elas
    await repo.genConfig.set(b.team, { taskId: b.taskId, updatedBy: user }); // só o workstream padrão; a escala de cada agente vem sempre de Users
    audit.log({ actor: user, team: b.team, month: b.month, action: 'draft.generate', details: `${resolved.length} agente(s) · ${task.taskName} · ${d?.items.size ?? 0} alteração(ões) no rascunho` });
    return send(res, 200, { ok: true, draft: draftView(d), agents: resolved.length, items: d?.items.size ?? 0 });
  }

  // ----- folgas -----
  if (req.method === 'GET' && path === '/api/timeoffs') {
    return send(res, 200, await teamTimeoffs(q.get('team') ?? defaultTeam(user, C.teams, actx()), m));
  }
  if (req.method === 'POST' && path === '/api/timeoffs') {
    need('timeoffs');
    const b = await readBody(req);
    const err = validateTimeoff(b);
    if (err) throw new HttpError(422, err);
    requireEditor(user, C.agents.find((a) => a.email === b.email).team);
    const reason = C.reasons.find((r) => r.taskId === b.reasonId);
    const t = { id: randomUUID(), email: b.email, reasonId: reason.taskId, reasonName: reason.taskName, startTime: b.startTime, endTime: b.endTime, status: 'agendada', origin: 'app', createdAt: new Date().toISOString(), scheduledAt: schedulePending(), createdBy: user };
    await repo.timeoffs.add(t);
    audit.log({ actor: user, team: C.agents.find((a) => a.email === b.email).team, month: isoDate(b.startTime).slice(0, 7), action: 'timeoff.create', agentEmail: b.email, after: t, details: reason.taskName });
    return send(res, 201, t);
  }
  // ----- trocas de dia extra (supervisão): ver, consolidar no rascunho ou recusar -----
  if (req.method === 'GET' && path === '/api/swaps') {
    const team = teamOf(q.get('team') ?? defaultTeam(user, C.teams, actx())).name;
    await expireSwaps();
    const list = (await repo.swaps.list()).filter((s) => s.team === team && swapDates(s).some((d) => d.startsWith(m)));
    const nameOf = (email) => agentsOf(team).find((a) => a.email === email)?.name ?? email;
    const ctx = list.length ? await swapContext(team, list.flatMap(swapDates)) : null;
    return send(res, 200, list.map((s) => {
      const waiting = s.status === 'pendente_supervisor';
      return {
        id: s.id, status: s.status, statusLabel: SWAP_LABEL[s.status] ?? s.status, requesterName: nameOf(s.requester), ownerName: nameOf(s.owner), date: s.date, offerDate: s.offerDate || '',
        createdAt: s.createdAt, decidedBy: s.decidedBy, refusedBy: s.refusedBy, note: s.note,
        warnings: waiting ? swapWarnings({ ops: swapOps(s, ctx.shiftsOn), shiftsOn: ctx.shiftsOn, lunchTaskId: C.ctx.lunch.taskId, nameOf }) : [],
        problems: waiting ? validateSwap(s, ctx, s.id) : [],
      };
    }).sort((a, b) => (a.status === 'pendente_supervisor' ? 0 : 1) - (b.status === 'pendente_supervisor' ? 0 : 1) || a.date.localeCompare(b.date)));
  }
  const dmatch = path.match(/^\/api\/swaps\/([\w-]+)\/decision$/);
  if (req.method === 'POST' && dmatch) {
    need('swaps'); need('drafts');
    const swap = await repo.swaps.get(dmatch[1]);
    if (!swap) throw new HttpError(404, 'Troca não encontrada.');
    requireEditor(user, swap.team);
    if (swap.status !== 'pendente_supervisor') throw new HttpError(409, 'Essa troca não está aguardando a supervisão.');
    const b = await readBody(req), now = new Date().toISOString(), team = swap.team;
    if (b.action === 'deny') {
      await repo.swaps.update(swap.id, { status: 'recusada', refusedBy: 'supervisor', decidedBy: user, note: String(b.note ?? '').slice(0, 300), updatedAt: now });
      audit.log({ actor: user, team, month: swap.date.slice(0, 7), action: 'swap.deny', agentEmail: swap.requester, details: swap.id });
      notifySwap({ event: 'recusada_supervisao', swap });
      return send(res, 200, { ok: true });
    }
    if (b.action !== 'consolidate') throw new HttpError(422, 'Ação inválida.');
    const ctx = await swapContext(team, swapDates(swap));
    const errs = validateSwap(swap, ctx, swap.id);
    if (errs.length) {
      await repo.swaps.update(swap.id, { status: 'invalidada', note: errs[0], updatedAt: now });
      audit.log({ actor: user, team, month: swap.date.slice(0, 7), action: 'swap.invalidate', agentEmail: swap.requester, details: `${swap.id}: ${errs[0]}` });
      throw new HttpError(409, `Essa troca não vale mais: ${errs[0]}`);
    }
    const ops = swapOps(swap, ctx.shiftsOn), nameOf = (email) => agentsOf(team).find((a) => a.email === email)?.name ?? email;
    for (const op of ops) { // o rascunho não pode ter mexido nesses dias nem estar sendo confirmado
      const month = op.date.slice(0, 7), day = Number(op.date.slice(8, 10));
      locks.assertFree(dkey(team, month));
      if (store.get(team, month)?.items.has(`${op.email}|${day}`)) throw new HttpError(409, `O rascunho de ${month} já tem alteração de ${nameOf(op.email)} no dia ${day}. Confirme ou descarte antes de consolidar a troca.`);
    }
    for (const op of ops) { // sem await entre as gravações: entram todas ou nenhuma
      const month = op.date.slice(0, 7), day = Number(op.date.slice(8, 10)), published = ctx.shiftsOn(op.email, op.date);
      store.saveDay({ team, month, email: op.email, day, after: op.after, published, user, version: store.get(team, month)?.version ?? 0 });
      presence.markEdit(user, team, month);
      audit.log({ actor: user, team, month, action: 'draft.save', agentEmail: op.email, day, before: published, after: op.after, details: `troca ${swap.id}` });
    }
    await repo.swaps.update(swap.id, { status: 'consolidada', decidedBy: user, updatedAt: now });
    audit.log({ actor: user, team, month: swap.date.slice(0, 7), action: 'swap.consolidate', agentEmail: swap.requester, details: `${swap.id}: ${ops.length} dia(s) de agente no rascunho` });
    notifySwap({ event: 'consolidada', swap });
    return send(res, 200, { ok: true, months: [...new Set(ops.map((o) => o.date.slice(0, 7)))] });
  }

  // ----- folgas em lote (uma folga por agente, ligadas por loteId) -----
  if (req.method === 'GET' && path === '/api/holidays') {
    const team = teamOf(q.get('team') ?? defaultTeam(user, C.teams, actx())).name;
    const wanted = String((await repo.settings()).holiday_reason_id ?? '').trim();
    const reason = C.reasons.find((r) => r.taskId === wanted) ?? C.reasons.find((r) => /holiday|feriado/i.test(r.taskName));
    return send(res, 200, { holidays: holidaysFor(await repo.holidays.list(), team, m), reasonId: reason?.taskId ?? '' });
  }
  if (req.method === 'POST' && path === '/api/timeoff-lots/preview') {
    const b = await readBody(req);
    const team = teamOf(b.team);
    if (!b.startTime || !b.endTime || b.startTime >= b.endTime) throw new HttpError(422, 'Período inválido (fim deve ser depois do início).');
    return send(res, 200, { agents: await lotPreview(team.name, b.startTime, b.endTime) });
  }
  if (req.method === 'GET' && path === '/api/timeoff-lots') {
    need('timeoffs');
    const team = teamOf(q.get('team') ?? defaultTeam(user, C.teams, actx())).name;
    const mine = new Set(agentsOf(team).map((a) => a.email));
    const first = `${m}-01`, last = `${m}-${dd(daysInMonth(m))}`;
    const lots = (await repo.timeoffs.lots()).filter((l) => l.items.some((i) => mine.has(i.email)) && l.items.some((i) => isoDate(toLocalIso(i.startTime)) <= last && isoDate(toLocalIso(i.endTime)) >= first));
    return send(res, 200, lots.map(lotView).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20));
  }
  if (req.method === 'POST' && path === '/api/timeoff-lots') {
    need('timeoffs');
    const b = await readBody(req);
    const team = teamOf(b.team);
    requireEditor(user, team.name);
    const reason = C.reasons.find((r) => r.taskId === b.reasonId);
    if (!reason) throw new HttpError(422, 'Razão inexistente.');
    if (!b.startTime || !b.endTime || b.startTime >= b.endTime) throw new HttpError(422, 'Período inválido (fim deve ser depois do início).');
    const emails = [...new Set((Array.isArray(b.emails) ? b.emails : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) throw new HttpError(422, 'Selecione ao menos um agente.');
    if (emails.length > LOT_MAX) throw new HttpError(422, `Um lote aceita até ${LOT_MAX} agentes.`);
    const mine = new Set(agentsOf(team.name).map((a) => a.email));
    const outsiders = emails.filter((e) => !mine.has(e));
    if (outsiders.length) throw new HttpError(422, `Agentes que não são do time: ${outsiders.slice(0, 5).join(', ')}${outsiders.length > 5 ? '…' : ''}`);
    const loteId = randomUUID().slice(0, 8), createdAt = new Date().toISOString(), scheduledAt = schedulePending();
    const items = emails.map((email) => ({ id: randomUUID(), email, reasonId: reason.taskId, reasonName: reason.taskName, startTime: b.startTime, endTime: b.endTime, status: 'agendada', origin: 'app', createdAt, scheduledAt, createdBy: user, loteId }));
    await repo.timeoffs.addMany(items);
    for (const t of items) audit.log({ actor: user, team: team.name, month: isoDate(b.startTime).slice(0, 7), action: 'timeoff.create', agentEmail: t.email, after: t, details: `${reason.taskName} (lote ${loteId})` });
    return send(res, 201, { loteId, count: items.length, scheduledAt });
  }
  const lm = path.match(/^\/api\/timeoff-lots\/([\w-]+)$/);
  if (req.method === 'DELETE' && lm) {
    need('timeoffs');
    const lot = (await repo.timeoffs.lots()).find((l) => l.loteId === lm[1]);
    if (!lot) throw new HttpError(404, 'Lote não encontrado.');
    const team = C.agents.find((a) => a.email === lot.items[0].email)?.team;
    requireEditor(user, team);
    const open = lot.items.filter((i) => i.status === 'agendada');
    const cancelled = open.length ? await repo.timeoffs.removeMany(open.map((i) => i.id)) : 0;
    for (const i of open) audit.log({ actor: user, team, month: isoDate(i.startTime).slice(0, 7), action: 'timeoff.delete', agentEmail: i.email, before: i, details: `${i.reasonName} (cancelado com o lote ${lot.loteId})` });
    return send(res, 200, { cancelled, kept: lot.items.filter((i) => i.status === 'enviada' || i.status === 'erro').length });
  }

  const tm = path.match(/^\/api\/timeoffs\/([\w-]+)$/);
  if (tm) {
    need('timeoffs');
    const t = await repo.timeoffs.get(tm[1]);
    if (!t) throw new HttpError(404, 'Folga não encontrada.');
    const team = C.agents.find((a) => a.email === t.email).team;
    requireEditor(user, team);
    if (t.status !== 'agendada') throw new HttpError(409, 'Esta folga já foi enviada ao WFM: use "Cancelar folga" (nega a folga no WFM).');
    if (req.method === 'DELETE') {
      await repo.timeoffs.remove(t.id);
      audit.log({ actor: user, team, month: isoDate(t.startTime).slice(0, 7), action: 'timeoff.delete', agentEmail: t.email, before: t, details: t.reasonName });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
      const b = await readBody(req);
      const err = validateTimeoff({ ...t, ...b });
      if (err) throw new HttpError(422, err);
      const before = { ...t };
      const reason = C.reasons.find((r) => r.taskId === (b.reasonId ?? t.reasonId));
      Object.assign(t, await repo.timeoffs.update(t.id, { reasonId: reason.taskId, reasonName: reason.taskName, startTime: b.startTime, endTime: b.endTime, scheduledAt: schedulePending() }));
      audit.log({ actor: user, team, month: isoDate(t.startTime).slice(0, 7), action: 'timeoff.update', agentEmail: t.email, before, after: t, details: reason.taskName });
      return send(res, 200, t);
    }
  }

  const dm = path.match(/^\/api\/timeoffs\/([\w-]+)\/decision$/);
  if (req.method === 'POST' && dm) {
    need('timeoffs');
    const t = await repo.timeoffs.get(dm[1]);
    if (!t) throw new HttpError(404, 'Folga não encontrada.');
    const team = C.agents.find((a) => a.email === t.email).team;
    requireEditor(user, team);
    const { action } = await readBody(req);
    const before = { ...t };
    if (action === 'approve') {
      if (t.status !== 'pendente') throw new HttpError(409, 'Só pedidos pendentes podem ser aceitos.');
      const upd = await repo.timeoffs.update(t.id, { status: 'aprovada', decidedBy: user, approvedAt: new Date().toISOString() });
      if (!upd) throw new HttpError(409, 'Este pedido acabou de ser enviado ao WFM e ainda não voltou na extração. Tente de novo em alguns minutos.');
      Object.assign(t, upd);
    } else if (action === 'deny') {
      if (!['pendente', 'aprovada'].includes(t.status)) throw new HttpError(409, 'Só é possível recusar um pedido pendente ou cancelar uma folga aprovada.');
      const upd = await repo.timeoffs.update(t.id, { status: 'negada', decidedBy: user, deniedAt: new Date().toISOString() });
      if (!upd) throw new HttpError(409, 'Este pedido acabou de ser enviado ao WFM e ainda não voltou na extração. Tente de novo em alguns minutos.');
      Object.assign(t, upd);
    } else throw new HttpError(422, 'Ação inválida.');
    audit.log({ actor: user, team, month: isoDate(t.startTime).slice(0, 7), action: action === 'approve' ? 'timeoff.approve' : 'timeoff.deny', agentEmail: t.email, before, after: t, details: `${t.reasonName} (${before.status} → ${t.status})` });
    return send(res, 200, t);
  }

  // ----- exportações (histórico de CSV) -----
  if (req.method === 'GET' && path === '/api/exports') {
    const team = q.get('team') ?? defaultTeam(user, C.teams, actx());
    return send(res, 200, (await repo.exports.list()).filter((e) => e.team === team).map(exportView));
  }
  const em = path.match(/^\/api\/exports\/([\w-]+)\/(csv|verify)$/);
  if (em) {
    const e = await repo.exports.get(em[1]);
    if (!e) throw new HttpError(404, 'Exportação não encontrada.');
    if (req.method === 'GET' && em[2] === 'csv') {
      const csv = await repo.exports.csvOf(e);
      if (!csv) throw new HttpError(404, 'Espelho do CSV indisponível (já removido).');
      audit.log({ actor: user, team: e.team, month: e.month, action: 'export.download', batchId: e.batchId, details: e.name });
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${e.name}"` });
    }
    if (req.method === 'POST' && em[2] === 'verify') { // "Já publiquei": verificação pontual
      need('exports');
      requireEditor(user, e.team);
      if (!['aguardando_verificacao', 'nao_publicada', 'divergente'].includes(e.status)) throw new HttpError(409, 'Esta exportação já foi consolidada ou expirou.');
      if (repo.exports.requestVerification) { // sheets: pedido ao Apps Script, que verifica no WFM e grava o resultado (o app o aplica no próximo tick)
        const pedido = await repo.exports.requestVerification(e.id);
        audit.log({ actor: user, team: e.team, month: e.month, action: 'export.verify', batchId: e.batchId, details: `${e.name} → verificação pedida` });
        return send(res, 200, exportView(pedido));
      }
      // Mock: consolida na hora (em produção o Apps Script compara o WFM com `expected`, ver acima).
      e.attempts = (e.attempts ?? 0) + 1; e.lastCheckAt = new Date().toISOString();
      await repo.consolidate(e); e.note = '';
      audit.log({ actor: user, team: e.team, month: e.month, action: 'export.verify', batchId: e.batchId, details: `${e.name} → ${e.status}` });
      return send(res, 200, exportView(e));
    }
  }

  // ----- admin -----
  if (path.startsWith('/api/admin/')) {
    requireAdmin(user);
    if (req.method === 'GET' && path === '/api/admin/sheets') return send(res, 200, repo.sheetsInfo?.() ?? null);
    if (req.method === 'GET' && path === '/api/admin/portal') {
      const st = await portalState(), vac = String((await repo.settings()).reason_vacation ?? '').trim();
      const staffOf = (e) => hasAccess(e, actx()) || isAdmin(e, actx()) || C.teams.some((t) => roleFor(e, t, actx()) === 'editor');
      return send(res, 200, {
        on: st.on, source: st.source, invalid: !!st.invalid, agents: C.agents.length, staffAgents: C.agents.filter((a) => staffOf(a.email)).length,
        vacation: { configured: !!vac, valid: !vac || C.reasons.some((r) => r.taskId === vac), reasonName: C.reasons.find((r) => r.taskId === vac)?.taskName ?? null },
      });
    }
    if (req.method === 'GET' && path === '/api/admin/presence') return send(res, 200, { intervalSec: PRESENCE_PING_SEC, sessions: presence.users({ all: true }) });
    if (req.method === 'GET' && path === '/api/admin/access') return send(res, 200, ACC.map((a) => ({ ...a, expired: !!a.validUntil && a.validUntil < today() })));
    if (req.method === 'POST' && path === '/api/admin/access') {
      need('access');
      const b = await readBody(req);
      const email = String(b.email ?? '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(422, 'E-mail inválido.');
      if (!['viewer', 'editor', 'admin'].includes(b.role)) throw new HttpError(422, 'Papel inválido.');
      if (b.team !== '*' && !C.teams.some((t) => t.name === b.team)) throw new HttpError(422, 'Time inválido (use um time existente ou *).');
      const row = { id: randomUUID().slice(0, 8), email, team: b.team, role: b.role, validUntil: b.validUntil ?? '', grantedBy: user, note: b.note ?? '' };
      await repo.access.add(row);
      audit.log({ actor: user, team: b.team === '*' ? '' : b.team, action: 'access.grant', agentEmail: '', after: row, details: `${email} → ${b.role} em ${b.team}` });
      return send(res, 201, row);
    }
    const am = path.match(/^\/api\/admin\/access\/([\w-]+)$/);
    if (req.method === 'DELETE' && am) {
      need('access');
      const row = ACC.find((a) => a.id === am[1]);
      if (!row) throw new HttpError(404, 'Acesso não encontrado.');
      if (row.role === 'admin' && row.email === user) throw new HttpError(409, 'Você não pode revogar o próprio acesso de admin.');
      await repo.access.remove(row.id, row);
      audit.log({ actor: user, team: row.team === '*' ? '' : row.team, action: 'access.revoke', before: row, details: `${row.email} (${row.role} em ${row.team})` });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/api/admin/history') {
      return send(res, 200, { months: audit.months(), entries: audit.query({ month: q.get('histMonth') || undefined, actor: q.get('actor') || undefined, team: q.get('team') || undefined, action: q.get('action') || undefined }) });
    }
    if (req.method === 'GET' && path === '/api/admin/stats') {
      const entries = audit.query({ month: q.get('histMonth') || undefined, limit: 100000 });
      const count = (key) => Object.entries(entries.reduce((o, e) => ((o[e[key] || '—'] = (o[e[key] || '—'] ?? 0) + 1), o), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, n }));
      const drafts = [...store.drafts.values()];
      const ex = await repo.exports.list();
      return send(res, 200, {
        totals: {
          actions: entries.length, activeUsers: new Set(entries.map((e) => e.actor)).size, checkouts: (await repo.batches.list()).length,
          openDrafts: drafts.length, staleDrafts: drafts.filter((d) => Date.now() - Date.parse(d.updatedAt) > 24 * 3600 * 1000).length,
          jiraCards: entries.filter((e) => e.action === 'jira.card').length,
        },
        byAction: count('action'), byActor: count('actor'), byTeam: count('team'),
        batches: (await repo.batches.list()).slice(0, 20).map((b) => batchView(b, ex)),
        openDrafts: drafts.map((d) => ({ key: d.key, version: d.version, items: d.items.size, updatedBy: d.updatedBy, updatedAt: d.updatedAt })),
        orphanAgentIds: C.orphanAgentIds,
      });
    }
  }

  if (req.method === 'POST' && path === '/api/dev/reset') {
    if (repo.kind !== 'mock') throw new HttpError(404, 'Rota não encontrada.');
    await repo.reset(); await seed();
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Rota não encontrada.');
}

// ---------- páginas (routes) ----------
// Páginas HTML só são entregues por estas rotas. Os arquivos .html não são acessíveis diretamente.
const redirect = (res, to, code = 302) => { res.writeHead(code, { Location: to }); res.end(); };
const PAGES = [
  { re: /^\/$/, redirect: '/escalas' },
  { re: /^\/escalas\/?$/, file: 'index.html' },
  { re: /^\/escalas\/[^/]+\/\d{4}-(0[1-9]|1[0-2])\/?$/, file: 'index.html' }, // /escalas/:time/:YYYY-MM (deep link)
  { re: /^\/folgas\/?$/, file: 'folgas.html' },
  { re: /^\/folgas\/[^/]+\/\d{4}-(0[1-9]|1[0-2])\/?$/, file: 'folgas.html' }, // /folgas/:time/:YYYY-MM
  { re: /^\/trocas\/?$/, file: 'trocas.html' },
  { re: /^\/trocas\/[^/]+\/\d{4}-(0[1-9]|1[0-2])\/?$/, file: 'trocas.html' }, // /trocas/:time/:YYYY-MM
  { re: /^\/minha-escala\/?$/, file: 'agente.html' },
  { re: /^\/minha-escala\/\d{4}-(0[1-9]|1[0-2])\/?$/, file: 'agente.html' }, // /minha-escala/:YYYY-MM
  { re: /^\/exportacoes\/?$/, file: 'exportacoes.html' },
  { re: /^\/exportacoes\/[^/]+\/?$/, file: 'exportacoes.html' }, // /exportacoes/:time
  { re: /^\/admin\/?$/, redirect: '/admin/estatisticas' },
  { re: /^\/admin\/(estatisticas|historico|acessos)\/?$/, file: 'admin.html' },
];
const LEGACY = { '/index.html': '/escalas', '/admin.html': '/admin' };
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.otf': 'font/otf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const NOT_FOUND_HTML = '<!doctype html><meta charset="utf-8"><title>Não encontrado</title><body style="font:16px system-ui;padding:40px"><h1>Página não encontrada</h1><p><a href="/escalas">Ir para as escalas</a></p>';

async function serveFile(res, file, type) {
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch { send(res, 404, 'Not found'); }
}
async function route(res, pathname) {
  if (LEGACY[pathname]) return redirect(res, LEGACY[pathname], 301);
  const page = PAGES.find((p) => p.re.test(pathname));
  if (page?.redirect) return redirect(res, page.redirect);
  if (page) return serveFile(res, join(ROOT, 'public', page.file), 'text/html; charset=utf-8');
  // assets (js/css/svg) de public/ e shared/
  const ext = extname(pathname);
  if (MIME[ext]) {
    const file = normalize(join(ROOT, pathname.startsWith('/shared/') ? pathname : `/public${pathname}`));
    if (file.startsWith(ROOT) && /[\\/](public|shared)[\\/]/.test(file)) return serveFile(res, file, MIME[ext]);
  }
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(NOT_FOUND_HTML);
}

// Dados de exemplo para o admin não abrir vazio.
async function seed() {
  if (repo.kind !== 'mock') return;
  const { AGENTS } = await import('./mockData.js');
  const batches = repo.batches, exportsLog = repo.exports;
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const m = nowMonth();
  audit.log({ ts: ago(300), actor: 'sup.beta@example.com', team: 'sup.beta@example.com', month: m, action: 'draft.save', agentEmail: AGENTS.find((a) => a.team === 'sup.beta@example.com').email, day: 4 });
  audit.log({ ts: ago(290), actor: 'sup.beta@example.com', team: 'sup.beta@example.com', month: m, action: 'checkout', batchId: 'seed0001', details: 'edited' });
  audit.log({ ts: ago(200), actor: 'admin@example.com', action: 'access.grant', details: 'sup.gama@example.com → editor em sup.alfa@example.com' });
  batches.push({ batchId: 'seed0001', team: 'sup.beta@example.com', month: m, createdBy: 'sup.beta@example.com', createdAt: Date.now() - 290 * 60_000, items: 1, emails: [], files: 1, csvRows: 5, removals: [], jira: null });
  const hdr = 'agentName,agentEmail,taskType,taskId,taskName,timeOffType,startTime,endTime\r\n';
  exportsLog.unshift(
    { id: 'seedexp2', batchId: 'seed0002', team: 'sup.alfa@example.com', month: m, name: `escala_sup.alfa_${m}_10-12.csv`, window: { from: `${m}-10`, to: `${m}-12` }, agents: [AGENTS[0].email], rows: 15, expected: {}, csv: hdr, csvHash: 'seedhash01', status: 'aguardando_verificacao', createdAt: Date.now() - 30 * 60_000, createdBy: 'sup.alfa@example.com', attempts: 0 },
    { id: 'seedexp4', batchId: 'seed0004', team: 'sup.alfa@example.com', month: m, name: `escala_sup.alfa_${m}_05-08.csv`, window: { from: `${m}-05`, to: `${m}-08` }, agents: [AGENTS[0].email, AGENTS[3].email], rows: 40, expected: {}, csv: hdr, csvHash: 'seedhash03', status: 'divergente', createdAt: Date.now() - 2 * 3600_000, createdBy: 'sup.alfa@example.com', attempts: 2, lastCheckAt: new Date(Date.now() - 20 * 60_000).toISOString(), note: 'O publicado não bate com o CSV nem existe como rascunho (3 dia(s) diferentes).',
      diffTotal: 3, diffs: [
        { email: AGENTS[0].email, dia: 5, esperado: [{ a: '[BR] Chat', s: '09:00', e: '13:00' }, { a: 'Lunch Time', s: '13:00', e: '14:00' }, { a: '[BR] Chat', s: '14:00', e: '18:00' }], publicado: [] },
        { email: AGENTS[0].email, dia: 6, esperado: [{ a: '[BR] Chat', s: '09:00', e: '13:00' }, { a: 'Lunch Time', s: '13:00', e: '14:00' }, { a: '[BR] Chat', s: '14:00', e: '18:00' }], publicado: [{ a: '[BR] Chat', s: '08:00', e: '12:00' }, { a: 'Lunch Time', s: '12:00', e: '13:00' }, { a: '[BR] Chat', s: '13:00', e: '17:00' }] },
        { email: AGENTS[3].email, dia: 8, esperado: [], publicado: [{ a: '[BR] E-mail', s: '10:00', e: '16:20' }, { a: 'Snack Break', s: '14:00', e: '14:45' }] },
      ] },
    { id: 'seedexp3', batchId: 'seed0003', team: 'sup.beta@example.com', month: m, name: `escala_sup.beta_${m}_20-22.csv`, window: { from: `${m}-20`, to: `${m}-22` }, agents: [AGENTS[6].email], rows: 15, expected: {}, csv: hdr, csvHash: 'seedhash02', status: 'nao_publicada', createdAt: Date.now() - 5 * 3600_000, createdBy: 'sup.beta@example.com', attempts: 1, lastCheckAt: new Date(Date.now() - 4 * 3600_000).toISOString(), note: 'Os turnos aparecem como rascunho (published 0): falta publicar.' },
  );
  exportsLog.push({ id: 'seedexp1', batchId: 'seed0001', team: 'sup.beta@example.com', month: m, name: 'escala_sup.beta_seed.csv', window: { from: `${m}-04`, to: `${m}-04` }, agents: [], rows: 5, expected: {}, csvHash: 'seedhash00', status: 'consolidada', createdAt: Date.now() - 290 * 60_000, createdBy: 'sup.beta@example.com' });
}
await seed();

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await route(res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (!e.status) console.error(e);
    const msg = e.code === 'sheets_unavailable' ? 'O Google Sheets está limitando as consultas agora (cota). Aguarde alguns segundos e tente de novo.' : String(e.message ?? e);
    send(res, e.status ?? 500, { error: msg, violations: e.violations, code: e.code });
  }
}).listen(PORT, () => console.log(`WFM Escalas (${repo.kind}) em http://localhost:${PORT} · modo de entrada: aba Config (access_mode) ou ACCESS_MODE=${ENV_ACCESS_MODE}`));

// Encerramento: grava o que estiver pendente (rascunhos/histórico) antes de sair.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await repo.flush?.(); } finally { process.exit(0); } });
