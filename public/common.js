// Utilitários compartilhados pelas páginas (app e admin).
// Identidade: no mock vem do seletor "entrar como..." (localStorage) e é enviada no cabeçalho x-auth-request-email.
// Em produção o cabeçalho de identidade é injetado pelo sistema que hospeda o app; este arquivo deixa de definir o usuário.

import { toLocalIso } from '/shared/rules.js';

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const KEY = 'wfm.mockUser';
export const getMockUser = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setMockUser = (e) => { try { localStorage.setItem(KEY, e); } catch { /* ignore */ } };

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
  if (!logins.length) { selectEl.closest('.mock-login')?.remove(); return getMockUser(); }
  if (!logins.some((l) => l.email === getMockUser())) setMockUser(logins[0].email);
  selectEl.innerHTML = logins.map((l) => `<option value="${esc(l.email)}" ${l.email === getMockUser() ? 'selected' : ''}>${esc(l.label)}</option>`).join('');
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
