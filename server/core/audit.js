// Histórico (log só de inclusão), uma "aba" por mês: Histórico YYYY-MM.
export const ACTIONS = ['draft.save', 'draft.generate', 'draft.discard', 'draft.item.discard', 'checkout', 'timeoff.create', 'timeoff.request', 'timeoff.request.cancel', 'swap.request', 'swap.respond', 'swap.cancel', 'swap.consolidate', 'swap.deny', 'swap.invalidate', 'timeoff.update', 'timeoff.delete', 'timeoff.approve', 'timeoff.deny', 'timeoff.erro_envio', 'export.verify', 'export.download', 'access.grant', 'access.revoke', 'jira.card'];

export function createAudit() {
  const byMonth = new Map(); // 'YYYY-MM' -> entries[]
  return {
    log(e) {
      const ts = e.ts ?? new Date().toISOString();
      const month = ts.slice(0, 7);
      const entry = { ts, actor: e.actor, team: e.team ?? '', month: e.month ?? '', action: e.action, agentEmail: e.agentEmail ?? '', day: e.day ?? '', before: e.before ?? null, after: e.after ?? null, batchId: e.batchId ?? '', details: e.details ?? '' };
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(entry);
      return entry;
    },
    /** Filtra por aba(s) de mês de registro (ts) e demais campos. Mais recentes primeiro. */
    query({ month, actor, team, action, limit = 300 } = {}) {
      const pool = month ? byMonth.get(month) ?? [] : [...byMonth.values()].flat();
      return pool.filter((e) => (!actor || e.actor === actor) && (!team || e.team === team) && (!action || e.action === action)).slice().reverse().slice(0, limit);
    },
    /** Carrega entradas já gravadas (início do app com a planilha); não gera nova gravação. */
    load(entries) {
      for (const e of entries) { const m = String(e.ts).slice(0, 7); if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m).push(e); }
      for (const list of byMonth.values()) list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    },
    months: () => [...byMonth.keys()].sort().reverse(),
    reset: () => byMonth.clear(),
  };
}
