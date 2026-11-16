// Trava por rascunho (time|mês), em memória: o app roda com UMA instância (ver values.yml), então basta.
// O checkout confere a versão do rascunho, grava arquivos e lote na planilha (centenas de ms) e só então fecha o rascunho.
// Sem trava, dois checkouts quase simultâneos do mesmo rascunho passam pela conferência de versão e geram duas exportações iguais.
export function createDraftLocks({ now = Date.now, recentMs = 5 * 60_000 } = {}) {
  const active = new Map(); // chave -> { user, action, since }
  const recent = new Map(); // chave -> { user, at } (último checkout concluído, para explicar o pedido "atrasado")
  const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });

  const assertFree = (key) => {
    const l = active.get(key);
    if (l) throw conflict(`${l.user} está ${l.action} este rascunho agora. Aguarde terminar e recarregue a página.`);
  };
  return {
    /** Lança 409 se alguém está confirmando este rascunho. Chamar logo antes de qualquer alteração dele. */
    assertFree,
    /** Executa fn com o rascunho travado; a trava sai sempre, inclusive se fn falhar. */
    async run(key, user, action, fn) {
      assertFree(key);
      active.set(key, { user, action, since: now() });
      try { return await fn(); } finally { active.delete(key); }
    },
    markDone(key, user) { recent.set(key, { user, at: now() }); },
    /** Checkout concluído há pouco (para dizer "já foi confirmado por X" em vez de "sem alterações"). */
    recent(key) { const r = recent.get(key); return r && now() - r.at < recentMs ? r : null; },
    isLocked: (key) => active.has(key),
  };
}
