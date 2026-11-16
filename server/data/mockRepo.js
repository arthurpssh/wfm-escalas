// Implementação MOCK do repositório de dados (tudo em memória). Contrato: ver server/data/repo.js.
// Também simula o que, em produção, é feito pelo Apps Script (envio de folgas agendadas, consolidação de exportações) em `tick()`.
import { ACCESS_SEED, ACTIVITIES, AGENTS, CTX, MOCK_LOGINS, ORPHAN_AGENT_IDS, STANDARD_SCALES, TEAMS, TIMEOFF_REASONS, generateMonth, generateTimeoffs } from '../mockData.js';
import { createDraftStore } from '../core/drafts.js';
import { createAudit } from '../core/audit.js';

export function createMockRepo({ consolidateAfterSec = 0 } = {}) {
  const months = new Map(); // 'YYYY-MM' -> cells (publicado)
  const seeded = new Set();
  let timeoffs = [];
  let access = structuredClone(ACCESS_SEED);
  const batches = [];
  const exportsLog = [];
  const genConfig = new Map();
  const drafts = createDraftStore();
  const audit = createAudit();

  const catalog = { activities: ACTIVITIES, reasons: TIMEOFF_REASONS, standardScales: STANDARD_SCALES, teams: TEAMS, agents: AGENTS, orphanAgentIds: ORPHAN_AGENT_IDS, ctx: CTX, logins: MOCK_LOGINS };

  const cellsOf = (m) => {
    if (!months.has(m)) months.set(m, generateMonth(m));
    if (!seeded.has(m)) { seeded.add(m); timeoffs.push(...generateTimeoffs(m)); }
    return months.get(m);
  };
  const upd = (list, id, patch) => { const x = list.find((e) => e.id === id); if (!x) return null; Object.assign(x, patch); return x; };

  const repo = {
    kind: 'mock',
    drafts, audit,
    catalog: async () => catalog,
    settings: async () => ({}), // aba Config (só sheets); no mock vale o ambiente
    cells: async (m) => cellsOf(m),
    /** Mock do Apps Script: o publicado passa a refletir o esperado de uma exportação. */
    applyExpected: async (m, expected) => {
      const cells = cellsOf(m);
      for (const [email, days] of Object.entries(expected)) {
        cells[email] ??= {};
        for (const [d, shifts] of Object.entries(days)) { if (shifts.length) cells[email][d] = shifts; else delete cells[email][d]; }
      }
    },

    timeoffs: {
      list: async (m) => { cellsOf(m); return timeoffs; },
      get: async (id) => timeoffs.find((t) => t.id === id) ?? null,
      add: async (t) => { timeoffs.push(t); return t; },
      update: async (id, patch) => upd(timeoffs, id, patch),
      remove: async (id) => { timeoffs = timeoffs.filter((t) => t.id !== id); },
    },
    access: {
      list: async () => access,
      add: async (row) => { access.push(row); return row; },
      remove: async (id) => { access = access.filter((a) => a.id !== id); },
    },
    batches: { list: async () => batches, add: async (b) => { batches.unshift(b); return b; }, push: (b) => batches.push(b) },
    exports: {
      list: async () => exportsLog,
      get: async (id) => exportsLog.find((e) => e.id === id) ?? null,
      add: async (e) => { exportsLog.unshift(e); return e; },
      addMany: async (list) => { exportsLog.unshift(...list); return list; },
      csvOf: async (e) => e.csv ?? null,
      update: async (id, patch) => upd(exportsLog, id, patch),
      push: (e) => exportsLog.push(e),
      unshift: (...e) => exportsLog.unshift(...e),
    },
    genConfig: { get: async (team) => genConfig.get(team) ?? null, set: async (team, cfg) => { genConfig.set(team, cfg); } },

    /** Simula o Apps Script: envia folgas agendadas ao WFM e consolida exportações sem verificação manual. */
    tick: async () => {
      const now = Date.now();
      for (const t of timeoffs) if (t.status === 'agendada' && Date.parse(t.scheduledAt) <= now) { t.status = 'aprovada'; t.approvedAt = new Date().toISOString(); }
      if (!consolidateAfterSec) return;
      for (const e of exportsLog) {
        if (e.status !== 'aguardando_verificacao' || now - e.createdAt < consolidateAfterSec * 1000) continue;
        await repo.consolidate(e);
      }
    },
    /** Consolida uma exportação: publicado = esperado; espelho do Drive marcado para exclusão em 2 meses. */
    consolidate: async (e) => {
      await repo.applyExpected(e.month, e.expected);
      const del = new Date(); del.setMonth(del.getMonth() + 2);
      Object.assign(e, { status: 'consolidada', consolidatedAt: new Date().toISOString(), deleteAfter: del.toISOString().slice(0, 10) });
    },
    reset: async () => {
      months.clear(); seeded.clear(); timeoffs = []; batches.length = 0; exportsLog.length = 0; genConfig.clear();
      drafts.reset(); audit.reset(); access = structuredClone(ACCESS_SEED);
    },
  };
  return repo;
}
