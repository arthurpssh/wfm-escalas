// Persistência dos dados do app na planilha (Fase 3, parte 1: rascunhos, configuração do gerador e histórico).
// Modelo: a memória do processo é a fonte durante a execução (instância única) e a planilha é o armazenamento durável:
//   - no início, `loadAll` lê as abas e reconstrói o estado;
//   - a cada mudança, `mark*()` agenda a gravação; várias mudanças seguidas viram UMA gravação por aba (cota do Sheets: ~60 gravações/min por conta);
//   - `flush()` grava já (usado no encerramento e nas operações que não podem esperar).
// Nunca é lida de volta durante a execução: edição manual dessas abas só vale no próximo início do app.
import { exitFromInput, hhmmToMin, minToHHMM } from '../../shared/rules.js';

export const HEAD = {
  drafts: ['draftKey (time|YYYY-MM)', 'team', 'month', 'version', 'status', 'openedBy', 'openedAt', 'updatedBy', 'updatedAt'],
  items: ['draftKey', 'agentEmail', 'day', 'kind', 'before (JSON shifts)', 'after (JSON shifts)', 'updatedBy', 'updatedAt'],
  gen: ['team', 'email (* = time)', 'taskId (workstream/multitask)', 'escalaPadraoId', 'diasSemana', 'entrada', 'almoco', 'snack', 'duracaoSnack', 'saida', 'updatedBy', 'updatedAt'],
  batches: ['batchId', 'team', 'month', 'createdBy', 'createdAt', 'agentEmails (JSON)', 'items', 'files', 'csvRows', 'removals (JSON)', 'jiraKey', 'jiraStatus'],
  exports: ['id', 'batchId', 'team', 'month', 'name', 'windowFrom', 'windowTo', 'agents (JSON emails)', 'rows', 'status', 'createdAt', 'createdBy', 'attempts', 'lastCheckAt', 'consolidatedAt', 'deleteAfter', 'note', 'csvHash', 'fileId', 'expected (JSON)', 'verifyRequestedAt', 'diferencas (JSON)'],
  pedidos: ['id', 'tipo', 'agentEmail', 'reasonId', 'reasonName', 'startTime', 'endTime', 'targetExternalId', 'status', 'createdAt', 'scheduledAt', 'createdBy', 'externalId', 'note', 'loteId'],
  swaps: ['id', 'team', 'requester (e-mail)', 'owner (e-mail)', 'date (dia extra pedido)', 'offerDate (dia oferecido, opcional)', 'status', 'refusedBy', 'createdAt', 'updatedAt', 'decidedBy', 'note'],
  history: ['ts', 'actor', 'team', 'month', 'action', 'agentEmail', 'day', 'before', 'after', 'batchId', 'details'],
};
const CELL_MAX = 45000; // o limite de uma célula do Sheets é 50.000 caracteres
const json = (v) => { const s = JSON.stringify(v ?? null); return s.length > CELL_MAX ? JSON.stringify({ truncado: true, tamanho: s.length }) : s; };
const parse = (s) => { try { return s === '' || s == null ? null : JSON.parse(s); } catch { return null; } };
const str = (v) => (v == null ? '' : String(v).trim());
const hhmm = (v) => (typeof v === 'number' && v >= 0 && v < 1 ? minToHHMM(Math.round(v * 1440)) : str(v));

// ---------- rascunhos ----------
export function draftsToMatrices(drafts) {
  const dr = [HEAD.drafts], it = [HEAD.items];
  for (const d of drafts.values()) {
    dr.push([d.key, d.team, d.month, d.version, d.status, d.openedBy, d.openedAt, d.updatedBy, d.updatedAt]);
    for (const x of d.items.values()) it.push([d.key, x.email, x.day, x.kind, json(x.before), json(x.after), x.updatedBy, x.updatedAt]);
  }
  return { drafts: dr, items: it };
}

/** Reconstrói os rascunhos no store a partir das abas. Linhas inválidas são ignoradas (e contadas). */
export function loadDrafts(store, draftsMatrix, itemsMatrix) {
  let bad = 0;
  for (const r of draftsMatrix.slice(1)) {
    const key = str(r[0]);
    if (!key) continue;
    store.drafts.set(key, { key, team: str(r[1]), month: str(r[2]), version: Number(r[3]) || 0, status: str(r[4]) || 'open', openedBy: str(r[5]), openedAt: str(r[6]), updatedBy: str(r[7]), updatedAt: str(r[8]), items: new Map() });
  }
  for (const r of itemsMatrix.slice(1)) {
    const d = store.drafts.get(str(r[0]));
    const after = parse(r[5]), before = parse(r[4]);
    if (!d) { if (str(r[0])) bad++; continue; }
    if (!Array.isArray(after) || !Array.isArray(before)) { bad++; continue; }
    d.items.set(`${str(r[1])}|${Number(r[2])}`, { email: str(r[1]), day: Number(r[2]), kind: str(r[3]), before, after, updatedBy: str(r[6]), updatedAt: str(r[7]) });
  }
  for (const [k, d] of [...store.drafts]) if (!d.items.size) store.drafts.delete(k); // rascunho sem itens não existe
  return { drafts: store.drafts.size, bad };
}

/** Mesma API do store de rascunhos; cada alteração agenda a gravação. */
export function persistentDraftStore(store, persister) {
  const wrap = (name) => (...a) => { const r = store[name](...a); persister.markDrafts(); return r; };
  return {
    drafts: store.drafts, get: store.get,
    saveDay: wrap('saveDay'), saveDays: wrap('saveDays'), replaceAgents: wrap('replaceAgents'), discardItem: wrap('discardItem'),
    discard: wrap('discard'), close: wrap('close'), reset: wrap('reset'),
  };
}

// ---------- configuração do gerador ----------
export function genConfigToMatrix(map, now = new Date().toISOString()) {
  const rows = [HEAD.gen];
  for (const [team, cfg] of map) {
    const by = cfg.updatedBy ?? '', at = cfg.updatedAt ?? now;
    rows.push([team, '*', cfg.taskId ?? '', '', '', '', '', '', '', '', by, at]); // só o workstream/multitask padrão do time; a escala de cada agente vem da aba Users
  }
  return rows;
}

/** Lê só a linha `*` (workstream padrão do time). Linhas por agente de versões antigas são ignoradas (e somem na próxima gravação da aba). */
export function loadGenConfig(map, matrix) {
  for (const r of matrix.slice(1)) {
    const team = str(r[0]), email = str(r[1]).toLowerCase();
    if (!team || email !== '*') continue;
    map.set(team, { taskId: str(r[2]), updatedBy: str(r[10]), updatedAt: str(r[11]) });
  }
  return map.size;
}

// ---------- histórico ----------
export const historyTab = (ts) => `Histórico ${String(ts).slice(0, 7)}`;
export const historyRow = (e) => [e.ts, e.actor ?? '', e.team ?? '', e.month ?? '', e.action, e.agentEmail ?? '', e.day ?? '', json(e.before), json(e.after), e.batchId ?? '', String(e.details ?? '').slice(0, 2000)];
export const rowToHistory = (r) => ({ ts: str(r[0]), actor: str(r[1]), team: str(r[2]), month: str(r[3]), action: str(r[4]), agentEmail: str(r[5]), day: r[6] === '' ? '' : Number(r[6]) || str(r[6]), before: parse(r[7]), after: parse(r[8]), batchId: str(r[9]), details: str(r[10]) });

// ---------- lotes e exportações ----------
const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
const ms = (s) => (s ? Date.parse(s) : null);
const jiraStatus = (j) => (!j ? 'nao_aplicavel' : j.error ? 'erro' : j.dryRun ? 'simulado' : 'criado');

export const batchesToMatrix = (list) => [HEAD.batches, ...list.map((b) => [b.batchId, b.team, b.month, b.createdBy, iso(b.createdAt), json(b.emails ?? []), b.items ?? 0, b.files ?? 0, b.csvRows ?? 0, json(b.removals ?? []), b.jira?.key ?? '', jiraStatus(b.jira)])];
export function loadBatches(matrix) {
  return matrix.slice(1).filter((r) => str(r[0])).map((r) => {
    const st = str(r[11]);
    return { batchId: str(r[0]), team: str(r[1]), month: str(r[2]), createdBy: str(r[3]), createdAt: ms(str(r[4])), emails: parse(r[5]) ?? [], items: Number(r[6]) || 0, files: Number(r[7]) || 0, csvRows: Number(r[8]) || 0, removals: parse(r[9]) ?? [],
      jira: st === 'nao_aplicavel' || !st ? null : { key: str(r[10]), dryRun: st === 'simulado', error: st === 'erro' ? 'ver histórico' : undefined } };
  });
}

/** Linha de Exportacoes. `expectedCell`: JSON inline ou "file:<fileId>" quando passa do limite de uma célula. */
export const exportToRow = (e) => [e.id, e.batchId, e.team, e.month, e.name, e.window?.from ?? '', e.window?.to ?? '', json(e.agents ?? []), e.rows ?? 0, e.status, iso(e.createdAt), e.createdBy ?? '', e.attempts ?? 0, e.lastCheckAt ?? '', e.consolidatedAt ?? '', e.deleteAfter ?? '', e.note ?? '', e.csvHash ?? '', e.fileId ?? '', e.expectedCell ?? json(e.expected ?? {}), e.verifyRequestedAt ?? '', e.diffs ? json({ total: e.diffTotal ?? e.diffs.length, items: e.diffs }) : ''];
export const exportsToMatrix = (list) => [HEAD.exports, ...list.map(exportToRow)];
/** expected volta como texto bruto em `expectedCell`; quem chama resolve (JSON inline ou arquivo do Drive). */
const diffsOf = (cell) => { const d = parse(cell); return d && Array.isArray(d.items) ? { diffs: d.items, diffTotal: d.total ?? d.items.length } : { diffs: null, diffTotal: null }; };
export function loadExports(matrix) {
  return matrix.slice(1).filter((r) => str(r[0])).map((r) => ({
    id: str(r[0]), batchId: str(r[1]), team: str(r[2]), month: str(r[3]), name: str(r[4]), window: { from: str(r[5]), to: str(r[6]) }, agents: parse(r[7]) ?? [], rows: Number(r[8]) || 0,
    status: str(r[9]), createdAt: ms(str(r[10])), createdBy: str(r[11]), attempts: Number(r[12]) || 0, lastCheckAt: str(r[13]) || null, consolidatedAt: str(r[14]) || null, deleteAfter: str(r[15]) || null,
    note: str(r[16]), csvHash: str(r[17]), fileId: str(r[18]), expectedCell: str(r[19]), verifyRequestedAt: str(r[20]) || null, ...diffsOf(r[21]), expected: {},
  }));
}
export const EXPECTED_INLINE_MAX = CELL_MAX;

// ---------- pedidos de folga (FolgasPedidos; o Apps Script os envia ao WFM) ----------
export const pedidosToMatrix = (list) => [HEAD.pedidos, ...list.map((p) => [p.id, p.tipo, p.agentEmail, p.reasonId ?? '', p.reasonName ?? '', p.startTime ?? '', p.endTime ?? '', p.targetExternalId ?? '', p.status, p.createdAt ?? '', p.scheduledAt ?? '', p.createdBy ?? '', p.externalId ?? '', String(p.note ?? '').slice(0, 2000), p.loteId ?? ''])];
export const loadPedidos = (matrix) => matrix.slice(1).filter((r) => str(r[0])).map((r) => ({
  id: str(r[0]), tipo: str(r[1]), agentEmail: str(r[2]).toLowerCase(), reasonId: str(r[3]), reasonName: str(r[4]), startTime: str(r[5]), endTime: str(r[6]), targetExternalId: str(r[7]),
  status: str(r[8]), createdAt: str(r[9]), scheduledAt: str(r[10]), createdBy: str(r[11]), externalId: str(r[12]), note: str(r[13]), loteId: str(r[14]),
}));

// ---------- trocas de dia extra (aba Trocas; dona: o app) ----------
export const swapsToMatrix = (list) => [HEAD.swaps, ...list.map((s) => [s.id, s.team, s.requester, s.owner, s.date, s.offerDate ?? '', s.status, s.refusedBy ?? '', s.createdAt ?? '', s.updatedAt ?? '', s.decidedBy ?? '', String(s.note ?? '').slice(0, 1000)])];
export const loadSwaps = (matrix) => matrix.slice(1).filter((r) => str(r[0])).map((r) => ({
  id: str(r[0]), team: str(r[1]), requester: str(r[2]).toLowerCase(), owner: str(r[3]).toLowerCase(), date: str(r[4]).slice(0, 10), offerDate: str(r[5]).slice(0, 10),
  status: str(r[6]), refusedBy: str(r[7]), createdAt: str(r[8]), updatedAt: str(r[9]), decidedBy: str(r[10]), note: str(r[11]),
}));

// ---------- gravação agendada ----------
/**
 * state: { drafts (Map), genConfig (Map), batches, exports, pedidos (arrays) } da memória. Falhas de gravação são registradas em `lastError`
 * e reagendadas (o estado em memória continua válido): o próximo flush regrava tudo, então nada se perde enquanto o processo viver.
 */
export function createPersister({ gateway, state, debounceMs = 1500, retryMs = 15000, onError = (e) => console.error('[persist]', e.message), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, queue = [], chain = Promise.resolve();
  let dirty = { drafts: false, gen: false, batches: false, exports: false, pedidos: false, swaps: false };
  const known = new Set();
  const p = { lastError: null };

  async function ensure(name, header) { if (!known.has(name)) { await gateway.ensureTab(name, header); known.add(name); } }

  async function run() {
    const d = dirty, q = queue; dirty = { drafts: false, gen: false, batches: false, exports: false, pedidos: false, swaps: false }; queue = [];
    try {
      if (d.drafts) {
        const m = draftsToMatrices(state.drafts);
        await ensure('Rascunhos', HEAD.drafts); await ensure('RascunhoItens', HEAD.items);
        await gateway.replaceTab('Rascunhos', m.drafts); await gateway.replaceTab('RascunhoItens', m.items);
      }
      if (d.gen) { await ensure('GeradorConfig', HEAD.gen); await gateway.replaceTab('GeradorConfig', genConfigToMatrix(state.genConfig)); }
      if (d.batches) { await ensure('Lotes', HEAD.batches); await gateway.replaceTab('Lotes', batchesToMatrix(state.batches)); }
      if (d.pedidos) { await ensure('FolgasPedidos', HEAD.pedidos); await gateway.replaceTab('FolgasPedidos', pedidosToMatrix(state.pedidos)); }
      if (d.swaps) { await ensure('Trocas', HEAD.swaps); await gateway.replaceTab('Trocas', swapsToMatrix(state.swaps)); }
      if (d.exports) { await ensure('Exportacoes', HEAD.exports); await gateway.replaceTab('Exportacoes', exportsToMatrix(state.exports)); }
      const byTab = new Map();
      for (const e of q) { const t = historyTab(e.ts); if (!byTab.has(t)) byTab.set(t, []); byTab.get(t).push(historyRow(e)); }
      for (const [tab, rows] of byTab) { await ensure(tab, HEAD.history); await gateway.appendRows(tab, rows); }
      p.lastError = null;
    } catch (e) {
      p.lastError = e; onError(e);
      for (const k of Object.keys(dirty)) dirty[k] = dirty[k] || d[k];
      queue = [...q, ...queue]; // tenta de novo no próximo flush
      schedule(retryMs);
    }
  }
  function schedule(ms = debounceMs) { if (timer) return; timer = setTimer(() => { timer = null; p.flush(); }, ms); timer.unref?.(); }

  p.markDrafts = () => { dirty.drafts = true; schedule(); };
  p.markGenConfig = () => { dirty.gen = true; schedule(); };
  p.markBatches = () => { dirty.batches = true; schedule(); };
  p.markExports = () => { dirty.exports = true; schedule(); };
  p.markPedidos = () => { dirty.pedidos = true; schedule(); };
  p.markSwaps = () => { dirty.swaps = true; schedule(); };
  p.logAudit = (entry) => { queue.push(entry); schedule(); };
  /** Grava agora e espera terminar (inclusive o que já estava em andamento). Não lança: veja `lastError`. */
  p.flush = () => { if (timer) { clearTimer(timer); timer = null; } chain = chain.then(run); return chain; };
  /** Como flush, mas lança se não conseguiu gravar (operações que não podem fingir sucesso, como o checkout). */
  p.flushStrict = async () => { await p.flush(); if (p.lastError) throw new Error(`Não foi possível gravar na planilha: ${p.lastError.message}`); };
  p.pending = () => Object.values(dirty).some(Boolean) || queue.length > 0;
  return p;
}
