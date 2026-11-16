// Implementação do repositório sobre a planilha de escalas (Fase 2: SOMENTE LEITURA).
// Lê as abas pelo cabeçalho (ordem das colunas não importa). Escritas (rascunho, exportação, folga, acesso) ficam para a Fase 3:
// até lá `readOnly: true` e o servidor recusa as rotas de escrita.
// Premissas sobre o índice (confirmar na planilha real): Teams.agents_ids separado por vírgula/;/espaço; Users tem id,email,name + colunas de escala;
// Activities tem taskType,taskId,taskName; razões de folga na aba `TimeOffReasons` (taskId,taskName).
import { createDraftStore } from '../core/drafts.js';
import { createSheetFileStore } from './fileStore.js';
import { mergeTimeoffView } from './timeoffView.js';
import { randomUUID } from 'node:crypto';
import { createAudit } from '../core/audit.js';
import { EXPECTED_INLINE_MAX, createPersister, loadBatches, loadDrafts, loadExports, loadGenConfig, loadPedidos, persistentDraftStore, rowToHistory } from './persist.js';
import { resolveAgentDefinition } from '../core/scales.js';
import { minToHHMM, toLocalIso, verifyPending } from '../../shared/rules.js';

const str = (v) => (v == null ? '' : String(v).trim());
/** Matriz (linha 0 = cabeçalho) → objetos. Linhas totalmente vazias são ignoradas. */
export function rowsToObjects(matrix) {
  const [head = [], ...rows] = matrix;
  const keys = head.map(str);
  return rows.filter((r) => r.some((c) => str(c) !== '')).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}
/** Células de horário podem vir como fração do dia (0.375 = 09:00) quando a coluna é do tipo hora. */
export const hhmmCell = (v) => (typeof v === 'number' && v >= 0 && v < 1 ? minToHHMM(Math.round(v * 1440)) : str(v));
const splitIds = (v) => str(v).split(/[,;\s]+/).filter(Boolean);

/** Abas do índice → catálogo (mesmo formato do mock). */
export function buildCatalog({ teams, users, activities, scales, reasons }) {
  const scalesRows = rowsToObjects(scales).map((s) => ({ id: str(s.id), diasSemana: str(s.diasSemana), entrada: hhmmCell(s.entrada), almoco: hhmmCell(s.almoco), snack: hhmmCell(s.snack), duracaoSnack: s.duracaoSnack, saida: hhmmCell(s.saida) }));
  const byId = new Map(scalesRows.map((s) => [s.id, s]));
  const userRows = rowsToObjects(users).map((u) => ({
    id: str(u.id), email: str(u.email).toLowerCase(), name: str(u.name), escalaPadraoId: str(u.escalaPadraoId), diasSemana: str(u.diasSemana),
    entrada: hhmmCell(u.entrada), almoco: hhmmCell(u.almoco), snack: hhmmCell(u.snack), duracaoSnack: u.duracaoSnack, saida: hhmmCell(u.saida),
  }));
  const teamRows = rowsToObjects(teams).map((t, i) => ({
    id: `team-${i}`, name: str(t.name).toLowerCase(), coordinator: str(t['Coordenação'] ?? t.coordenacao).toLowerCase(), defaultTaskId: str(t.defaultTaskId), agentIds: splitIds(t.agents_ids),
  })).filter((t) => t.name);
  const orphanAgentIds = [];
  const agents = teamRows.flatMap((t) => t.agentIds.flatMap((id) => {
    const u = userRows.find((x) => x.id === id);
    if (!u || !u.email) { orphanAgentIds.push(id); return []; }
    const r = resolveAgentDefinition(u, byId);
    return [{ id, email: u.email, name: u.name, team: t.name, scaleId: r.scaleId, def: r.def }];
  }));
  const acts = rowsToObjects(activities).map((a) => ({ taskType: str(a.taskType), taskId: str(a.taskId), taskName: str(a.taskName) })).filter((a) => a.taskId);
  const lunch = acts.find((a) => a.taskName === 'Lunch Time');
  const snack = acts.find((a) => a.taskName === 'Snack Break');
  return {
    activities: acts, reasons: rowsToObjects(reasons).map((r) => ({ taskId: str(r.taskId), taskName: str(r.taskName) })).filter((r) => r.taskId),
    standardScales: scalesRows, teams: teamRows, agents, orphanAgentIds, ctx: { lunch, snack, tasks: new Map(acts.map((a) => [a.taskId, a])) }, logins: [],
  };
}

/** Aba `Escala YYYY-MM` → { [email]: { [dia]: Shift[] } }. Célula inválida é ignorada (e contada em `bad`). */
export function parseMonthSheet(matrix) {
  const cells = {};
  let bad = 0;
  for (const row of matrix.slice(1)) {
    const email = str(row[0]).toLowerCase();
    if (!email) continue;
    const days = (cells[email] = {});
    for (let d = 1; d < row.length; d++) {
      const raw = str(row[d]);
      if (!raw) continue;
      try { const s = JSON.parse(raw); if (Array.isArray(s) && s.length) days[d] = s; } catch { bad++; }
    }
  }
  return { cells, bad };
}

const TIMEOFF_STATUS = { pending: 'agendada', approved: 'aprovada' }; // aceita os nomes antigos do template
export function parseTimeoffs(matrix) {
  return rowsToObjects(matrix).map((t) => ({
    id: str(t.id), email: str(t.agentEmail).toLowerCase(), reasonId: str(t.reasonId), reasonName: str(t.reasonName), startTime: str(t.startTime), endTime: str(t.endTime),
    status: TIMEOFF_STATUS[str(t.status)] ?? str(t.status), createdAt: str(t.createdAt), scheduledAt: str(t.scheduledAt), externalId: str(t.externalId), createdBy: str(t.createdBy),
    origin: !str(t.createdBy) ? 'wfm' : str(t.createdBy).toLowerCase() === str(t.agentEmail).toLowerCase() ? 'agent' : 'app', // createdBy vazio = veio do WFM; = agente: pedido dele
  })).filter((t) => t.id && t.email);
}

/** Data de uma célula: texto AAAA-MM-DD ou, se o Sheets a converteu, número de série (dias desde 30/12/1899). */
const dateCell = (v) => (typeof v === 'number' ? new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10) : str(v));

/** O id é o número real da linha na planilha (r2 = 2ª linha), para a revogação achar a mesma linha. */
export function parseAccess(matrix) {
  const [head = [], ...rows] = matrix;
  const keys = head.map(str);
  const out = [];
  rows.forEach((r, i) => {
    const a = Object.fromEntries(keys.map((k, j) => [k, r[j] ?? '']));
    const email = str(a.email).toLowerCase();
    if (!email) return;
    out.push({ id: `r${i + 2}`, email, team: str(a['team (nome do time ou *)'] ?? a.team).toLowerCase(), role: str(a.role), validUntil: dateCell(a.validUntil), grantedBy: str(a.grantedBy), note: str(a.note) });
  });
  return out;
}

export function createSheetsRepo({ gateway, cacheSec = 60, now = () => Date.now(), debounceMs = 1500 }) {
  const cache = new Map(); // chave -> { at, value }
  const cached = async (key, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheSec * 1000) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    return value;
  };
  const notYet = async () => { const e = new Error('Escrita ainda não disponível com DATA_SOURCE=sheets (Fase 3).'); e.status = 503; throw e; };
  const writeOnly = { list: async () => [], get: async () => null, add: notYet, update: notYet, remove: notYet };

  // Escrita (SHEETS_WRITE=1): rascunhos, configuração do gerador e histórico ficam na planilha (ver persist.js).
  const writable = !!gateway.writable;
  const baseStore = createDraftStore(), baseAudit = createAudit();
  const state = { drafts: baseStore.drafts, genConfig: new Map(), batches: [], exports: [], pedidos: [] };
  // Arquivos grandes (CSV): no Drive se DRIVE_FOLDER_ID estiver definido (pasta numa Unidade compartilhada); senão, na aba `Arquivos`.
  const sheetFiles = writable ? createSheetFileStore({ gateway }) : null;
  const files = {
    save: ({ name, content, mime, kind }) => (gateway.driveEnabled ? gateway.uploadFile({ name, content, mime }) : sheetFiles.save({ name, content, kind })),
    load: (id) => (String(id).startsWith('sheet:') ? sheetFiles.load(id) : gateway.downloadFile(id)),
  };
  const persister = writable ? createPersister({ gateway, state, debounceMs }) : null;
  const drafts = writable ? persistentDraftStore(baseStore, persister) : baseStore;
  const audit = writable ? { ...baseAudit, log(e) { const entry = baseAudit.log(e); persister.logAudit(entry); return entry; } } : baseAudit;
  let lastVerifRead = 0;
  /** Resultados do envio de folgas (aba FolgasEnvios, do Apps Script) → pedidos. Idempotente: só atua em pedidos ainda "agendada"/"cancelada". */
  const applyEnvios = async () => {
    const rows = (await gateway.readTab('FolgasEnvios')).slice(1).filter((r) => r[1]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    let changed = false;
    for (const r of rows) {
      const p = state.pedidos.find((x) => x.id === String(r[1]));
      if (!p || !['agendada', 'cancelada'].includes(p.status)) continue;
      const res = String(r[2]), ext = String(r[3] ?? ''), detail = String(r[4] ?? '');
      if (p.status === 'cancelada') {
        if (!['enviada', 'duplicada'].includes(res)) continue; // cancelada e nada foi enviado: segue cancelada
        Object.assign(p, { status: res, externalId: ext, note: 'Foi enviada ao WFM antes do cancelamento: negue a folga na lista.' });
      } else Object.assign(p, { status: res, externalId: ext || p.externalId, note: detail });
      if (res === 'erro') audit.log({ actor: 'apps-script', action: 'timeoff.erro_envio', agentEmail: p.agentEmail, month: String(p.startTime).slice(0, 7), details: `${p.tipo}: ${detail}` }); // auditável no histórico
      changed = true;
    }
    if (changed) { cache.delete('timeoffs'); persister.markPedidos(); }
  };
  const need = (cond, msg) => { if (!cond) { const e = new Error(msg); e.status = 503; throw e; } };
  const upd = (list, id, patch) => { const x = list.find((e) => e.id === id); if (!x) return null; Object.assign(x, patch); return x; };
  // Exportações: o CSV vai para o Drive ou para a aba `Arquivos` (grande demais para uma célula); só a referência fica em Exportacoes.
  const exportsApi = writable ? {
    list: async () => state.exports,
    get: async (id) => state.exports.find((e) => e.id === id) ?? null,
    /** Guarda os CSVs (e o "esperado" quando grande) e só depois registra; se guardar falhar, nada é registrado. */
    addMany: async (list) => {
      const prepared = [];
      for (const e of list) {
        const fileId = await files.save({ name: e.name, content: e.csv, mime: 'text/csv', kind: 'csv' });
        const expectedJson = JSON.stringify(e.expected ?? {});
        const expectedCell = expectedJson.length > EXPECTED_INLINE_MAX ? `file:${await files.save({ name: `${e.name}.expected.json`, content: expectedJson, mime: 'application/json', kind: 'expected' })}` : expectedJson;
        prepared.push({ ...e, csv: undefined, fileId, expectedCell });
      }
      state.exports.unshift(...prepared);
      persister.markExports();
      await persister.flushStrict();
      return prepared;
    },
    add: async (e) => (await exportsApi.addMany([e]))[0],
    update: async (id, patch) => { const x = upd(state.exports, id, patch); if (x) persister.markExports(); return x; },
    /** "Já publiquei": marca o pedido; o Apps Script verifica no WFM e grava o resultado em `Verificacoes` (ver Verify.js). */
    requestVerification: async (id) => {
      const e = state.exports.find((x) => x.id === id);
      if (!e) return null;
      if (verifyPending(e, now())) { // já há um pedido esperando o Apps Script: não regrava o horário nem duplica o pedido
        const err = new Error(`Já há uma verificação pedida às ${toLocalIso(e.verifyRequestedAt).slice(11, 16)}. Aguarde o resultado.`);
        err.status = 409; throw err;
      }
      e.verifyRequestedAt = new Date(now()).toISOString(); // mesmo relógio da trava acima
      persister.markExports();
      await persister.flushStrict();
      return e;
    },
    csvOf: async (e) => { if (e.csv) return e.csv; need(!!e.fileId, 'Espelho do CSV indisponível.'); return files.load(e.fileId); },
  } : { ...writeOnly, addMany: notYet, csvOf: async () => null };
  const batchesApi = writable ? {
    list: async () => state.batches,
    add: async (b) => { state.batches.unshift(b); persister.markBatches(); await persister.flushStrict(); return b; },
  } : { list: async () => [], add: notYet };
  // Folgas: o app só grava PEDIDOS (FolgasPedidos); o Apps Script envia ao WFM e a extração devolve o resultado em TimeOffs.
  const wfmTimeoffs = () => cached('timeoffs', async () => parseTimeoffs(await gateway.readTab('TimeOffs')));
  const savePedidos = async () => { persister.markPedidos(); await persister.flushStrict(); };
  const merged = async () => mergeTimeoffView(await wfmTimeoffs(), state.pedidos, now());
  const timeoffsApi = writable ? {
    list: merged,
    get: async (id) => (await merged()).find((t) => t.id === id) ?? null,
    /** Nova folga (status "agendada"): vira um pedido "criar", enviado quando a carência de cancelamento acabar. */
    add: async (t) => {
      state.pedidos.unshift({ id: t.id, tipo: 'criar', agentEmail: t.email, reasonId: t.reasonId, reasonName: t.reasonName, startTime: t.startTime, endTime: t.endTime, targetExternalId: '', status: 'agendada', createdAt: t.createdAt ?? new Date().toISOString(), scheduledAt: t.scheduledAt, createdBy: t.createdBy ?? '', externalId: '', note: '' });
      await savePedidos();
      return t;
    },
    update: async (id, patch) => {
      const p = state.pedidos.find((x) => x.id === id && x.tipo === 'criar' && x.status === 'agendada');
      if (p) { // edição de folga ainda dentro da carência
        for (const k of ['reasonId', 'reasonName', 'startTime', 'endTime', 'scheduledAt']) if (patch[k] !== undefined) p[k] = patch[k];
        await savePedidos();
        return (await merged()).find((t) => t.id === id) ?? null;
      }
      const row = (await wfmTimeoffs()).find((r) => r.id === id);
      if (!row || !['aprovada', 'negada'].includes(patch.status)) return null;
      const at = new Date().toISOString(); // aceitar/recusar/cancelar: pedido "aprovar"/"negar", sem carência
      state.pedidos.unshift({ id: randomUUID(), tipo: patch.status === 'aprovada' ? 'aprovar' : 'negar', agentEmail: row.email, reasonId: row.reasonId, reasonName: row.reasonName, startTime: row.startTime, endTime: row.endTime, targetExternalId: id, status: 'agendada', createdAt: at, scheduledAt: at, createdBy: patch.decidedBy ?? '', externalId: '', note: '' });
      await savePedidos();
      return (await merged()).find((t) => t.id === id) ?? null;
    },
    /** Cancela uma folga ainda dentro da carência (o pedido fica no histórico como "cancelada"). */
    remove: async (id) => {
      const p = state.pedidos.find((x) => x.id === id && x.tipo === 'criar' && x.status === 'agendada');
      if (p) { p.status = 'cancelada'; await savePedidos(); }
    },
  } : { ...writeOnly, list: wfmTimeoffs, get: async (id) => (await wfmTimeoffs()).find((t) => t.id === id) ?? null };

  // Acessos: edição na planilha continua valendo (leitura com cache de 60 s); o app inclui por append e revoga relendo a aba.
  const ACCESS_HEAD = ['email', 'team (nome do time ou *)', 'role', 'validUntil', 'grantedBy', 'grantedAt', 'note'];
  const accessApi = writable ? {
    list: () => cached('access', async () => parseAccess(await gateway.readTab('Acessos'))),
    add: async (row) => {
      await gateway.ensureTab('Acessos', ACCESS_HEAD);
      await gateway.appendRows('Acessos', [[row.email, row.team, row.role, row.validUntil ?? '', row.grantedBy ?? '', new Date().toISOString(), row.note ?? '']]);
      cache.delete('access');
      return row;
    },
    /** Remove a linha (id = rN). Confere e-mail/time/papel na linha atual: se alguém mexeu na aba, recusa em vez de apagar outra. */
    remove: async (id, expected) => {
      const m = await gateway.readTab('Acessos');
      const r = m[Number(String(id).slice(1)) - 1];
      const same = r && expected && str(r[0]).toLowerCase() === expected.email && (str(r[1]).toLowerCase() || '') === expected.team && str(r[2]) === expected.role;
      if (!same) { const e = new Error('A aba Acessos mudou desde que a lista foi carregada. Recarregue e tente de novo.'); e.status = 409; throw e; }
      await gateway.replaceTab('Acessos', m.filter((_, i) => i !== Number(String(id).slice(1)) - 1));
      cache.delete('access');
    },
  } : { ...writeOnly, list: () => cached('access', async () => parseAccess(await gateway.readTab('Acessos'))) };

  const genConfig = writable
    ? { get: async (team) => state.genConfig.get(team) ?? null, set: async (team, cfg) => { state.genConfig.set(team, { ...cfg, updatedAt: new Date().toISOString() }); persister.markGenConfig(); } }
    : { get: async () => null, set: notYet };

  return {
    kind: 'sheets', readOnly: !writable,
    // O que já pode gravar com DATA_SOURCE=sheets. Cada etapa da Fase 3 liga mais uma capacidade.
    capabilities: { drafts: writable, generator: writable, audit: writable, checkout: writable, timeoffs: writable, access: writable, exports: writable },
    drafts, audit, persister,
    /** Carrega do Sheets o que o app grava (rascunhos, gerador, histórico). Chamar uma vez ao iniciar. */
    async init() {
      if (!writable) return { writable: false };
      const [dr, it, gen, lotes, exps, peds] = await Promise.all(['Rascunhos', 'RascunhoItens', 'GeradorConfig', 'Lotes', 'Exportacoes', 'FolgasPedidos'].map((n) => gateway.readTab(n)));
      const d = loadDrafts(baseStore, dr, it);
      const g = loadGenConfig(state.genConfig, gen);
      const tabs = (await gateway.listTabs()).filter((n) => /^Histórico \d{4}-\d{2}$/.test(n));
      const entries = [];
      for (const t of tabs) for (const r of (await gateway.readTab(t)).slice(1)) if (r[0]) entries.push(rowToHistory(r));
      baseAudit.load(entries);
      state.batches = loadBatches(lotes);
      state.exports = loadExports(exps);
      state.pedidos = loadPedidos(peds);
      // "esperado" das exportações em aberto: inline ou no Drive (as já consolidadas não precisam dele)
      let expectedFailed = 0;
      for (const e of state.exports) {
        if (!['aguardando_verificacao', 'nao_publicada', 'divergente'].includes(e.status)) continue;
        try { e.expected = JSON.parse(e.expectedCell.startsWith('file:') ? await files.load(e.expectedCell.slice(5)) : e.expectedCell || '{}'); } catch { e.expected = {}; expectedFailed++; }
      }
      return { writable: true, drafts: d.drafts, badItems: d.bad, genConfigTeams: g, historyEntries: entries.length, batches: state.batches.length, exports: state.exports.length, pedidos: state.pedidos.length, expectedFailed };
    },
    /** Grava o que estiver pendente (encerramento do processo). */
    flush: async () => { await persister?.flush(); },
    /** Aba Config (key/value) como objeto; chaves em minúsculas. Cache de 60 s: alternar na planilha vale em até 1 minuto. */
    settings: () => cached('config', async () => Object.fromEntries(rowsToObjects(await gateway.readTab('Config')).map((r) => [str(r.key).toLowerCase(), str(r.value)]).filter(([k]) => k))),
    catalog: () => cached('catalog', async () => {
      const [teams, users, activities, scales, reasons] = await Promise.all(['Teams', 'Users', 'Activities', 'EscalasPadrao', 'TimeOffReasons'].map((n) => gateway.readTab(n)));
      if (users.length < 2) throw new Error('Aba Users vazia: a extração/IMPORTRANGE falhou. Mantendo o último catálogo.'); // o cache expirado não é usado como fallback aqui; falha explícita
      return buildCatalog({ teams, users, activities, scales, reasons });
    }),
    cells: (month) => cached(`cells:${month}`, async () => parseMonthSheet(await gateway.readTab(`Escala ${month}`)).cells),
    applyExpected: notYet,
    consolidate: notYet,
    timeoffs: timeoffsApi,
    access: accessApi,
    batches: batchesApi,
    exports: exportsApi,
    genConfig,
    /** Aplica os resultados que o Apps Script gravou em `Verificacoes` (no máximo a cada 15 s). Idempotente: pela data da última checagem. */
    tick: async () => {
      if (!writable || now() - lastVerifRead < 15_000) return;
      lastVerifRead = now();
      await applyEnvios();
      const rows = (await gateway.readTab('Verificacoes')).slice(1).filter((r) => r[1]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
      let changed = false;
      for (const r of rows) {
        const e = state.exports.find((x) => x.id === String(r[1]));
        const ts = String(r[0]);
        if (!e || !['aguardando_verificacao', 'nao_publicada', 'divergente'].includes(e.status) || ts <= (e.lastCheckAt ?? '')) continue;
        const res = String(r[2]), detail = String(r[3] ?? '');
        e.attempts = (e.attempts ?? 0) + 1; e.lastCheckAt = ts;
        if (res === 'consolidada') {
          const del = new Date(ts); del.setMonth(del.getMonth() + 2);
          Object.assign(e, { status: 'consolidada', consolidatedAt: ts, deleteAfter: del.toISOString().slice(0, 10), note: '', expected: {}, diffs: null, diffTotal: null });
          cache.delete(`cells:${e.month}`); // o Apps Script já atualizou a aba do mês: relê sem esperar o cache
        } else if (res === 'nao_publicada') Object.assign(e, { status: 'nao_publicada', note: detail || 'Os turnos aparecem como rascunho (published 0): falta publicar.', diffs: null, diffTotal: null });
        else if (res === 'divergente') {
          let d = null;
          try { d = r[4] ? JSON.parse(String(r[4])) : null; } catch { /* sem diferenças detalhadas */ }
          Object.assign(e, { status: 'divergente', note: detail, diffs: Array.isArray(d?.items) ? d.items : null, diffTotal: d?.total ?? null });
        } else if (res === 'expirada') Object.assign(e, { status: 'expirada', note: detail, diffs: null, diffTotal: null });
        audit.log({ actor: 'apps-script', team: e.team, month: e.month, action: 'export.verify', batchId: e.batchId, details: `${e.name} → ${e.status}` });
        changed = true;
      }
      if (changed) persister.markExports();
    },
    reset: notYet,
  };
}
