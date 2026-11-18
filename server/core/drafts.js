// Rascunho por time+mês. Em produção: abas Rascunhos / RascunhoItens da planilha.
// Cada item = um par agente+dia, com o "antes" (publicado quando foi tocado pela 1ª vez) e o "depois".

export class ConflictError extends Error {
  constructor(msg = 'O rascunho foi alterado por outra pessoa. Recarregue e tente novamente.') { super(msg); this.status = 409; }
}

export const draftKey = (team, month) => `${team}|${month}`;
const sig = (shifts) => JSON.stringify((shifts ?? []).map((s) => [s.taskType, s.taskId, s.startTime, s.endTime]));
export const sameShifts = (a, b) => sig(a) === sig(b);
const itemKey = (email, day) => `${email}|${day}`;

export function createDraftStore() {
  const drafts = new Map();

  const checkVersion = (key, version) => {
    const cur = drafts.get(key)?.version ?? 0;
    if (Number(version ?? 0) !== cur) throw new ConflictError();
  };

  return {
    drafts,
    get: (team, month) => drafts.get(draftKey(team, month)) ?? null,

    /** Grava o "depois" de um dia. `published` = shifts publicados do dia. Retorna o rascunho (ou null se ficou vazio). */
    saveDay({ team, month, email, day, after, published, user, version, now = new Date().toISOString() }) {
      const key = draftKey(team, month);
      checkVersion(key, version);
      let d = drafts.get(key);
      if (!d) { d = { key, team, month, version: 0, status: 'open', openedBy: user, openedAt: now, updatedBy: user, updatedAt: now, items: new Map() }; drafts.set(key, d); }
      const ik = itemKey(email, day);
      const before = d.items.get(ik)?.before ?? published ?? [];
      if (sameShifts(after, before)) d.items.delete(ik); // voltou ao publicado: não é mais alteração
      else d.items.set(ik, { email, day, kind: !before.length ? 'created' : !after.length ? 'removed' : 'edited', before, after, updatedBy: user, updatedAt: now });
      d.version += 1; d.updatedBy = user; d.updatedAt = now;
      if (!d.items.size) { drafts.delete(key); return null; }
      return d;
    },

    /**
     * Grava o "depois" de VÁRIOS dias do mesmo agente de uma vez (a mesma configuração aplicada em um intervalo): uma só checagem e uma só
     * subida de versão. `entries`: [{ day, after, published }]. Dia que volta a ser igual ao publicado deixa de ser alteração.
     */
    saveDays({ team, month, email, entries, user, version, now = new Date().toISOString() }) {
      const key = draftKey(team, month);
      checkVersion(key, version);
      let d = drafts.get(key);
      if (!d) { d = { key, team, month, version: 0, status: 'open', openedBy: user, openedAt: now, updatedBy: user, updatedAt: now, items: new Map() }; drafts.set(key, d); }
      for (const { day, after, published } of entries) {
        const ik = itemKey(email, day);
        const before = d.items.get(ik)?.before ?? published ?? [];
        if (sameShifts(after, before)) d.items.delete(ik);
        else d.items.set(ik, { email, day, kind: !before.length ? 'created' : !after.length ? 'removed' : 'edited', before, after, updatedBy: user, updatedAt: now });
      }
      d.version += 1; d.updatedBy = user; d.updatedAt = now;
      if (!d.items.size) { drafts.delete(key); return null; }
      return d;
    },

    /**
     * Substitui, de uma vez, as definições de vários agentes no mês: apaga os itens anteriores desses agentes no rascunho
     * e grava só o que difere do publicado. `entries`: [{ email, day, after, published }] cobrindo TODOS os dias do mês
     * dos agentes envolvidos (dia sem turno = after []). Uma única subida de versão.
     */
    replaceAgents({ team, month, emails, entries, user, version, now = new Date().toISOString() }) {
      const key = draftKey(team, month);
      checkVersion(key, version);
      let d = drafts.get(key);
      if (!d) { d = { key, team, month, version: 0, status: 'open', openedBy: user, openedAt: now, updatedBy: user, updatedAt: now, items: new Map() }; drafts.set(key, d); }
      const involved = new Set(emails);
      for (const [k, it] of [...d.items]) if (involved.has(it.email)) d.items.delete(k);
      for (const { email, day, after, published } of entries) {
        const before = published ?? [];
        if (sameShifts(after, before)) continue;
        d.items.set(itemKey(email, day), { email, day, kind: !before.length ? 'created' : !after.length ? 'removed' : 'edited', before, after, updatedBy: user, updatedAt: now });
      }
      d.version += 1; d.updatedBy = user; d.updatedAt = now;
      if (!d.items.size) { drafts.delete(key); return null; }
      return d;
    },

    discardItem({ team, month, email, day, user, version, now = new Date().toISOString() }) {
      const key = draftKey(team, month);
      checkVersion(key, version);
      const d = drafts.get(key);
      const item = d?.items.get(itemKey(email, day));
      if (!item) return d ?? null;
      d.items.delete(itemKey(email, day));
      d.version += 1; d.updatedBy = user; d.updatedAt = now;
      if (!d.items.size) { drafts.delete(key); return null; }
      return d;
    },

    discard({ team, month, version }) {
      const key = draftKey(team, month);
      checkVersion(key, version);
      const d = drafts.get(key);
      drafts.delete(key);
      return d ?? null;
    },

    close(team, month) { drafts.delete(draftKey(team, month)); },
    reset() { drafts.clear(); },
  };
}

/** Escala efetiva = publicada + "depois" dos itens do rascunho. */
export function effectiveCells(publishedCells, draft, emails) {
  const out = {};
  for (const e of emails) out[e] = { ...(publishedCells[e] ?? {}) };
  for (const it of draft?.items.values() ?? []) {
    if (!out[it.email]) continue;
    if (it.after.length) out[it.email][it.day] = it.after; else delete out[it.email][it.day];
  }
  return out;
}

export const draftView = (d) => d && {
  key: d.key, version: d.version, openedBy: d.openedBy, openedAt: d.openedAt, updatedBy: d.updatedBy, updatedAt: d.updatedAt,
  items: [...d.items.values()],
};

/** Itens cujo dia publicado mudou desde que entraram no rascunho (ex.: alguém mexeu direto no Tymeshift). */
export function staleItems(draft, publishedCells) {
  return [...(draft?.items.values() ?? [])].filter((it) => !sameShifts(it.before, publishedCells[it.email]?.[it.day] ?? []));
}
