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
import { defaultTeam, hasAccess, isAdmin, resolveAccessMode, roleFor } from './core/access.js';
import { daysInMonth, isoDate, localDate, localMonth, planMonth, validateDefinition, verifyPending, verifyStale } from '../shared/rules.js';

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
const MOCK_AUTH = process.env.MOCK_AUTH !== '0'; // seletor "entrar como..." (só mock)

// Em contêiner (APP_NAME vem do Dockerfile): a identidade só pode vir do ingress e os dados têm de ser os reais.
if (process.env.APP_NAME) {
  if (process.env.DEV_USER_EMAIL) throw new Error('DEV_USER_EMAIL não pode existir em produção (qualquer pessoa seria vista como esse usuário): remova do values.yml/secrets.');
  if ((process.env.DATA_SOURCE ?? 'mock').toLowerCase() === 'mock') console.warn('[AVISO] Contêiner com DATA_SOURCE=mock (dados de exemplo). Defina DATA_SOURCE=sheets no values.yml.');
}
const repo = await createRepo(); // DATA_SOURCE=mock (padrão) | sheets — ver server/data/repo.js
const store = repo.drafts;
const audit = repo.audit;
// Catálogo (times, agentes, atividades...) e acessos do request corrente: carregados no início de api().
let C = null, ACC = [];

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
  return timeoffs.filter((t) => emails.has(t.email) && isoDate(t.startTime) <= last && isoDate(t.endTime) >= first);
};

function validateTimeoff(b) {
  if (!C.agents.some((a) => a.email === b.email)) return 'Agente inválido.';
  if (!C.reasons.find((r) => r.taskId === b.reasonId)) return 'Razão inexistente.';
  if (!b.startTime || !b.endTime || b.startTime >= b.endTime) return 'Período inválido (fim deve ser depois do início).';
  return null;
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
  const plan = planExports({ team, month, items, baseCells: base.cells, agents, activities: C.activities, today: today(), gapDays: CSV_GAP_DAYS });
  const unexpressible = plan.unexpressible.map((u) => ({ agent: agents.find((a) => a.email === u.email), date: `${month}-${dd(u.day)}`, previousShifts: u.before }));
  return { draft: d, items, stale, health, plan, unexpressible };
}

async function checkout(user, { team, month, version }) {
  requireEditor(user, team);
  const rv = await buildReview(team, month);
  if (!rv.draft) throw new HttpError(422, 'Não há alterações no rascunho.');
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
  if (req.method === 'GET' && path === '/api/mock/users') return send(res, 200, MOCK_AUTH ? (await repo.catalog()).logins : []);
  await repo.tick(); // mock: simula o Apps Script (envio de folgas, consolidação de exportações)
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
  if ((await accessMode()) === 'restricted' && !hasAccess(user, actx())) {
    throw new HttpError(403, 'Você ainda não tem acesso a este app. Peça a liberação a quem administra a aba Acessos.', { code: 'no_access' });
  }

  if (req.method === 'GET' && path === '/api/me') {
    const teams = C.teams.map((t) => ({ name: t.name, coordinator: t.coordinator, role: roleFor(user, t, actx()), agentCount: agentsOf(t.name).length }));
    return send(res, 200, { email: user, isAdmin: isAdmin(user, actx()), teams, defaultTeam: defaultTeam(user, C.teams, actx()) });
  }

  if (req.method === 'GET' && path === '/api/schedule') {
    const team = teamOf(q.get('team') ?? defaultTeam(user, C.teams, actx()));
    const agents = agentsOf(team.name);
    const d = store.get(team.name, m);
    const base = await baseCellsOf(team.name, m);
    return send(res, 200, {
      month: m, team: team.name, role: roleFor(user, team, actx()), daysInMonth: daysInMonth(m), agents,
      cells: effectiveCells(base.cells, d, agents.map((a) => a.email)), draft: draftView(d), pending: base.pending,
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
    const d = store.saveDay({ team: b.team, month: b.month, email: b.email, day: b.day, after: b.shifts ?? [], published, user, version: b.version });
    audit.log({ actor: user, team: b.team, month: b.month, action: 'draft.save', agentEmail: b.email, day: b.day, before: published, after: b.shifts ?? [] });
    return send(res, 200, { ok: true, draft: draftView(d) });
  }
  if (req.method === 'DELETE' && path === '/api/draft/item') {
    need('drafts');
    const team = q.get('team'); requireEditor(user, team);
    const d = store.discardItem({ team, month: m, email: q.get('email'), day: Number(q.get('day')), user, version: q.get('version') });
    audit.log({ actor: user, team, month: m, action: 'draft.item.discard', agentEmail: q.get('email'), day: Number(q.get('day')) });
    return send(res, 200, { ok: true, draft: draftView(d) });
  }
  if (req.method === 'DELETE' && path === '/api/draft') {
    need('drafts');
    const team = q.get('team'); requireEditor(user, team);
    const d = store.discard({ team, month: m, version: q.get('version') });
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
      errors: rv.plan.errors, warnings: rv.plan.warnings,
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
    const byId = new Map(scales.map((x) => [x.id, x]));
    return send(res, 200, {
      team: team.name, month: m, role: roleFor(user, team, actx()),
      taskId: ov?.taskId ?? team.defaultTaskId, defaultTaskId: team.defaultTaskId,
      tasks: C.activities.filter((a) => a.taskType !== 'generalTask'),
      scales,
      agents: agentsOf(team.name).map((a) => {
        const o = ov?.agents?.[a.email];
        if (!o) return { email: a.email, name: a.name, scaleId: a.scaleId, def: a.def };
        return { email: a.email, name: a.name, scaleId: o.scaleId, def: o.scaleId ? byId.get(o.scaleId) : o.custom };
      }),
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
    const d = store.replaceAgents({ team: b.team, month: b.month, emails: resolved.map((r) => r.email), entries, user, version: b.version });
    // guarda as configurações (mock da aba GeradorConfig): a próxima abertura do gerador já vem com elas
    const prevCfg = await repo.genConfig.get(b.team); // aplicar só a alguns agentes não pode apagar a configuração dos demais
    await repo.genConfig.set(b.team, { taskId: b.taskId, agents: { ...(prevCfg?.agents ?? {}), ...Object.fromEntries(resolved.map((r) => [r.email, { scaleId: r.scaleId, custom: r.scaleId ? null : r.def }])) }, updatedBy: user });
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
      Object.assign(t, await repo.timeoffs.update(t.id, { status: 'aprovada', decidedBy: user, approvedAt: new Date().toISOString() }));
    } else if (action === 'deny') {
      if (!['pendente', 'aprovada'].includes(t.status)) throw new HttpError(409, 'Só é possível recusar um pedido pendente ou cancelar uma folga aprovada.');
      Object.assign(t, await repo.timeoffs.update(t.id, { status: 'negada', decidedBy: user, deniedAt: new Date().toISOString() }));
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
    send(res, e.status ?? 500, { error: String(e.message ?? e), violations: e.violations, code: e.code });
  }
}).listen(PORT, () => console.log(`WFM Escalas (${repo.kind}) em http://localhost:${PORT} · modo de entrada: aba Config (access_mode) ou ACCESS_MODE=${ENV_ACCESS_MODE}`));

// Encerramento: grava o que estiver pendente (rascunhos/histórico) antes de sair.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await repo.flush?.(); } finally { process.exit(0); } });
