// Presença: quem está com o app aberto agora. Só em memória (o app roda com UMA instância): nada vai para a planilha nem para o histórico.
// O navegador "pinga" a cada ~20 s; quem não pingou em `ttlMs` (60 s) sai da lista. A identidade é sempre a do cabeçalho do ingress.
export const displayName = (email) => String(email).split('@')[0].split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ') || String(email);

export function createPresence({ now = Date.now, ttlMs = 60_000, editMs = 180_000 } = {}) {
  const sessions = new Map(); // sid -> { sid, email, page, team, month, visible, first, last }
  const edits = new Map(); // `${email}|${team}|${month}` -> instante da última alteração no rascunho

  const sweep = () => {
    const t = now();
    // aba em segundo plano pinga mais devagar (o navegador limita os temporizadores a ~1 por minuto): tolera 3x mais
    for (const [sid, s] of sessions) if (t - s.last > (s.visible ? ttlMs : ttlMs * 3)) sessions.delete(sid);
    for (const [k, at] of edits) if (t - at > editMs) edits.delete(k);
  };
  const lastEdit = (email, team, month) => edits.get(`${email}|${team}|${month}`) ?? null;

  return {
    /** Registra/renova uma aba. O mesmo `sid` com outro e-mail recomeça (o sid vem do navegador: não é confiável). */
    ping({ sid, email, page, team = '', month = '', visible = true }) {
      if (!sid || !email) return;
      const t = now(), prev = sessions.get(sid);
      const s = prev && prev.email === email ? prev : { sid, email, first: t };
      Object.assign(s, { page, team, month, visible: !!visible, last: t });
      sessions.set(sid, s);
    },
    leave(sid, email) { const s = sessions.get(sid); if (s && s.email === email) sessions.delete(sid); },
    /** Chamado quando a pessoa altera o rascunho (salvar dia, gerador, descartar, checkout). */
    markEdit(email, team, month) { edits.set(`${email}|${team}|${month}`, now()); },

    /**
     * Uma linha por pessoa. Com `team`/`month`: só quem está naquele time e mês (mês vazio de um dos lados não exclui),
     * sem `excludeEmail`. Com `all`: todos, e `editing` vira a lista de rascunhos que a pessoa alterou há pouco.
     */
    users({ team = '', month = '', excludeEmail = '', all = false } = {}) {
      sweep();
      const t = now(), by = new Map();
      for (const s of sessions.values()) {
        if (!all) {
          if (!team || s.team !== team || (month && s.month && s.month !== month)) continue;
          if (s.email === excludeEmail) continue;
        }
        if (!by.has(s.email)) by.set(s.email, []);
        by.get(s.email).push(s);
      }
      const out = [];
      for (const [email, list] of by) {
        const cur = list.reduce((a, b) => (b.last > a.last ? b : a));
        const u = {
          email, name: displayName(email), page: cur.page, team: cur.team, month: cur.month,
          since: new Date(Math.min(...list.map((s) => s.first))).toISOString(), lastSeen: new Date(cur.last).toISOString(),
          active: list.some((s) => s.visible), tabs: list.length,
        };
        if (all) u.editing = [...edits].filter(([k, at]) => k.startsWith(`${email}|`) && t - at <= editMs).map(([k, at]) => ({ team: k.split('|')[1], month: k.split('|')[2], agoSec: Math.round((t - at) / 1000) }));
        else { const at = lastEdit(email, team, cur.month || month); u.editing = at != null && t - at <= editMs; u.editAgoSec = u.editing ? Math.round((t - at) / 1000) : null; }
        out.push(u);
      }
      return out.sort((a, b) => (b.editing ? 1 : 0) - (a.editing ? 1 : 0) || a.name.localeCompare(b.name, 'pt-BR'));
    },
  };
}
