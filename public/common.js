// Utilitários compartilhados pelas páginas (app e admin).
// Identidade: no mock vem do seletor "entrar como..." (localStorage) e é enviada no cabeçalho x-auth-request-email.
// Em produção o cabeçalho de identidade é injetado pelo sistema que hospeda o app; este arquivo deixa de definir o usuário.

import { toLocalIso } from '/shared/rules.js';
import { icon } from '/icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const KEY = 'wfm.mockUser';
// Simular outra pessoa SÓ NO MOCK: abrir a página com ?as=e-mail. Vale só para aquela aba (sessionStorage), então duas abas podem ser
// duas pessoas ao mesmo tempo (o "entrar como" normal fica no localStorage, compartilhado entre as abas).
// Nunca vale fora do mock: sem usuários de mock (dados reais/produção) o parâmetro é descartado e o ingress é quem diz quem você é.
const AS_KEY = 'wfm.as';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
try { const q = new URLSearchParams(location.search).get('as'); if (q && EMAIL_RE.test(q.trim())) sessionStorage.setItem(AS_KEY, q.trim().toLowerCase()); } catch { /* sem armazenamento */ }
const tabAs = () => { try { return sessionStorage.getItem(AS_KEY) || ''; } catch { return ''; } };
let mockMode = false; // só vira true quando o servidor confirma que há usuários de mock
const sticky = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
let devAs = false; // DEV_IMPERSONATE no servidor: dados reais, só no computador do desenvolvedor
export const getMockUser = () => devAs ? tabAs() : (mockMode && tabAs()) || sticky();
export const setMockUser = (e) => {
  if (mockMode && tabAs()) { try { sessionStorage.setItem(AS_KEY, e); } catch { /* ignore */ } return; } // aba simulando: não mexe nas outras abas
  try { localStorage.setItem(KEY, e); } catch { /* ignore */ }
};

export async function api(url, opts = {}) {
  const headers = { 'x-auth-request-email': getMockUser() };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method: opts.method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 && j.code === 'no_access') showNoAccess(j.error);
    const e = new Error(j.error ?? r.statusText); e.status = r.status; e.violations = j.violations; throw e;
  }
  return r;
}
/** Modo restrito: quem não está em Acessos vê só este aviso (no lugar de uma tela vazia). */
function showNoAccess(msg) {
  document.body.innerHTML = `<main style="max-width:560px;margin:15vh auto;padding:0 24px;font-family:var(--font, system-ui), sans-serif"><h1 style="font-size:28px;margin:0 0 12px">Acesso não liberado</h1><p style="font-size:18px;line-height:1.5;margin:0">${esc(msg)}</p></main>`;
}
export const getJson = async (u) => (await api(u)).json();

export function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast hidden'), 4000);
}

/** Preenche o seletor "entrar como..." (só mock) e garante um usuário escolhido. Retorna o e-mail ativo. */
export async function setupMockLogin(selectEl, onChange) {
  const logins = await getJson('/api/mock/users');
  if (!logins.length) {
    devAs = !!(await getJson('/api/dev/impersonate').catch(() => ({}))).enabled && !!tabAs();
    if (devAs) { const bar = document.createElement('div'); bar.className = 'banner'; bar.style.cssText = 'position:sticky;top:0;z-index:50;text-align:center'; bar.textContent = `Simulando ${tabAs()} com dados reais (DEV_IMPERSONATE). Gravações ficam no nome dessa pessoa.`; document.body.prepend(bar); }
    if (!devAs) try { sessionStorage.removeItem(AS_KEY); } catch { /* ok */ }
    mockMode = false;
    selectEl.closest('.mock-login')?.remove(); return getMockUser();
  }
  mockMode = true;
  const as = tabAs();
  const list = as && !logins.some((l) => l.email === as) ? [...logins, { email: as, label: `${as} (?as=)` }] : logins; // e-mail fora da lista de mock: simula alguém sem acesso especial
  const mockLabel = selectEl.closest('.mock-login'); if (mockLabel) mockLabel.title = 'Somente no mock. Para simular outra pessoa ao mesmo tempo, abra outra aba com ?as=e-mail na URL.';
  if (!list.some((l) => l.email === getMockUser())) setMockUser(list[0].email);
  selectEl.innerHTML = list.map((l) => `<option value="${esc(l.email)}" ${l.email === getMockUser() ? 'selected' : ''}>${esc(l.label)}</option>`).join('');
  selectEl.onchange = () => { setMockUser(selectEl.value); onChange(); };
  return getMockUser();
}

export const dayLabel = (date) => new Date(date + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
// Datas e horas no fuso do app (-03:00), não em UTC: createdAt, lastCheckAt etc. chegam do servidor como ...Z.
export const fmtTs = (iso) => { const l = toLocalIso(iso); return `${l.slice(8, 10)}/${l.slice(5, 7)} ${l.slice(11, 16)}`; };
export const fmtHM = (iso) => toLocalIso(iso).slice(11, 16);

// ---- estados de folga (app): agendada -> aprovada | pendente (pedido do agente no WFM) | negada ----
export const TF_LABEL = { agendada: 'agendada', pendente: 'pedido do agente', aprovada: 'aprovada', negada: 'negada', erro: 'erro no envio' };
export const TF_ACTIVE = new Set(['agendada', 'aprovada']); // contam na cobertura; pendente e negada não contam
export const decideTimeoff = async (id, action) => (await api(`/api/timeoffs/${id}/decision`, { method: 'POST', body: { action } })).json();
export const fmtDT = fmtTs;

// ---- time e mês lembrados entre páginas ----
export const rememberView = (team, month) => { try { if (team) sessionStorage.setItem('wfm.team', team); if (month) sessionStorage.setItem('wfm.month', month); } catch { /* ignore */ } };
export const recallView = () => { try { return { team: sessionStorage.getItem('wfm.team'), month: sessionStorage.getItem('wfm.month') }; } catch { return {}; } };

/** Navegação entre as páginas. active: 'escalas' | 'folgas' | 'exportacoes' | 'admin' */
export function renderNav(active, me) {
  const nav = $('#nav'); if (!nav) return;
  const { team, month } = recallView();
  const enc = (t) => encodeURIComponent(t).replace(/%40/g, '@');
  const links = [
    ['escalas', 'Escala', team && month ? `/escalas/${enc(team)}/${month}` : '/escalas'],
    ['folgas', 'Folgas', team && month ? `/folgas/${enc(team)}/${month}` : '/folgas'],
    ['exportacoes', 'Exportações', team ? `/exportacoes/${enc(team)}` : '/exportacoes'],
  ];
  if (me?.isAdmin) links.push(['admin', 'Admin', '/admin']);
  nav.innerHTML = links.map(([k, label, href]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('');
}

// ---------- presença: quem está com o app aberto ----------
const PAGE_LABEL = { escalas: 'na escala', folgas: 'em Folgas', exportacoes: 'em Exportações', admin: 'no Admin' };
const minAgo = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
const initials = (name) => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

/**
 * Pinga o servidor a cada ~20 s (o intervalo vem na resposta) e entrega a lista de quem está no mesmo time e mês.
 * Aba oculta: avisa "inativa" e para de pingar; ao voltar, pinga na hora. Ao sair da página, avisa que saiu (o servidor também expira sozinho).
 * getCtx() devolve { team, month }; touch() pinga já se o contexto mudou (troca de time ou mês).
 */
export function startPresence({ page, getCtx, onUpdate }) {
  let sid = null, timer = null, every = 20000, lastKey = '';
  try { sid = sessionStorage.getItem('wfm.sid'); } catch { /* sem armazenamento */ }
  if (!sid) { sid = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 64); try { sessionStorage.setItem('wfm.sid', sid); } catch { /* ok */ } }
  const send = async (extra = {}) => {
    const c = getCtx() ?? {};
    lastKey = JSON.stringify(c);
    try {
      const r = await fetch('/api/presence', { method: 'POST', keepalive: !!extra.leave, headers: { 'content-type': 'application/json', 'x-auth-request-email': getMockUser() }, body: JSON.stringify({ sid, page, team: c.team, month: c.month, visible: !document.hidden, ...extra }) });
      if (!r.ok) return;
      const j = await r.json();
      if (j.intervalSec) every = j.intervalSec * 1000;
      if (!extra.leave) onUpdate?.(j.online ?? []);
    } catch { /* sem rede: tenta no próximo ciclo */ }
  };
  // aba oculta continua pingando (a cada >= 60 s) para não sumir da lista de quem está com o app aberto
  const loop = () => { clearTimeout(timer); timer = setTimeout(async () => { await send(); loop(); }, document.hidden ? Math.max(every, 60000) : every); };
  document.addEventListener('visibilitychange', () => { send().then(loop); });
  window.addEventListener('pagehide', () => send({ leave: true }));
  send().then(loop);
  return { touch: () => { if (JSON.stringify(getCtx() ?? {}) !== lastKey) send(); } };
}

/** Desenha as pessoas online (chips com iniciais) e, se houver, o aviso de que alguém está editando. */
export function renderPresence(list, { chipsEl, noteEl } = {}) {
  if (chipsEl) {
    chipsEl.classList.toggle('hidden', !list.length);
    chipsEl.innerHTML = list.length ? `<span class="pres-label">Online aqui:</span>${list.map((u) => `<span class="pres${u.active ? '' : ' idle'}${u.editing ? ' editing' : ''}" title="${esc(u.name)} (${esc(u.email)}) · ${PAGE_LABEL[u.page] ?? u.page} · ${u.active ? 'ativo' : 'aba em segundo plano'} · online há ${minAgo(u.since) < 1 ? 'menos de 1 min' : minAgo(u.since) + ' min'}${u.editing ? ' · editando agora' : ''}">${esc(initials(u.name))}${u.editing ? `<i class="pres-ed">${icon('pencil', 9)}</i>` : ''}</span>`).join('')}` : '';
  }
  if (noteEl) {
    const ed = list.filter((u) => u.editing);
    noteEl.classList.toggle('hidden', !ed.length);
    noteEl.innerHTML = ed.length ? `${icon('pencil', 16)} <b>${ed.map((u) => esc(u.name)).join(', ')}</b> ${ed.length > 1 ? 'estão editando' : 'está editando'} esta escala (última alteração há ${Math.max(1, Math.round(Math.min(...ed.map((u) => u.editAgoSec ?? 0)) / 60))} min). Evite confirmar ao mesmo tempo: pode duplicar a exportação.` : '';
  }
}
