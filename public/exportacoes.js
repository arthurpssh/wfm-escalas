import { withIcon } from '/icons.js';
import { $, esc, api, getJson, toast, setupMockLogin, fmtTs, renderNav, rememberView, recallView, startPresence, renderPresence } from '/common.js';

const ST = {
  aguardando_verificacao: 'aguardando publicação', nao_publicada: 'importada, não publicada', divergente: 'divergente',
  consolidada: 'consolidada', expirada: 'expirada',
};
const OPEN = ['aguardando_verificacao', 'nao_publicada', 'divergente'];
const S = { me: null, meta: null, team: null, role: 'viewer', items: [], status: '' };

// ---------- rota: /exportacoes/:time ----------
const parseRoute = () => { const m = location.pathname.match(/^\/exportacoes\/([^/]+)\/?$/); return m ? decodeURIComponent(m[1]) : null; };
const routeUrl = () => `/exportacoes/${encodeURIComponent(S.team).replace(/%40/g, '@')}`;
function syncUrl(push) {
  rememberView(S.team, null);
  if (location.pathname !== routeUrl()) history[push ? 'pushState' : 'replaceState'](null, '', routeUrl());
}

async function start(useRoute) {
  S.me = await getJson('/api/me');
  renderNav('exportacoes', S.me);
  const wanted = (useRoute ? parseRoute() : null) ?? recallView().team;
  S.team = S.me.teams.some((t) => t.name === wanted) ? wanted : S.me.defaultTeam;
  $('#teamSelect').innerHTML = S.me.teams.map((t) => `<option value="${esc(t.name)}" ${t.name === S.team ? 'selected' : ''}>${esc(t.name)} · ${t.role === 'editor' ? 'edição' : 'leitura'}</option>`).join('');
  S.role = S.me.teams.find((t) => t.name === S.team)?.role ?? 'viewer';
  syncUrl(false);
  await load();
}

let presence = null;
async function load() {
  presence?.touch();
  S.items = await getJson(`/api/exports?team=${encodeURIComponent(S.team)}`);
  S.role = S.me.teams.find((t) => t.name === S.team)?.role ?? 'viewer';
  $('#roleBanner').classList.toggle('hidden', S.role === 'editor');
  $('#roleBanner').textContent = `Você tem acesso apenas de visualização às exportações de ${S.team}.`;
  render();
}

const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
function render() {
  const edit = S.role === 'editor';
  const list = S.items.filter((e) => !S.status || (S.status === 'open' ? OPEN.includes(e.status) : e.status === S.status));
  $('#list').innerHTML = list.length ? `<table class="plain"><tr><th>Arquivo</th><th>Janela</th><th>Agentes</th><th>Linhas</th><th>Gerado</th><th>Status</th><th>Verificações</th><th></th></tr>${list.map((e) => `<tr>
    <td><b>${esc(e.name)}</b><br><small>lote ${esc(e.batchId)} · ${e.month}</small></td>
    <td>${dm(e.window.from)} → ${dm(e.window.to)}</td><td title="${esc(e.agentList.join(', '))}">${e.agents}</td><td>${e.rows}</td>
    <td>${fmtTs(e.createdAt)}<br><small>${esc(e.createdBy)}</small></td>
    <td><span class="badge ex-${e.status}">${ST[e.status] ?? e.status}</span>${e.verifyPending ? `<br><small>⏳ verificação pedida às ${fmtTs(e.verifyRequestedAt).slice(6)}</small>` : e.verifyStale ? `<br><small>⚠ verificação pedida às ${fmtTs(e.verifyRequestedAt).slice(6)} sem resposta: confira se o Apps Script está ativo</small>` : ''}${shortNote(e) ? `<br><small>${esc(shortNote(e))}</small>` : ''}${e.deleteAfter ? `<br><small>espelho apagado em ${e.deleteAfter}</small>` : ''}</td>
    <td>${e.attempts}${e.lastCheckAt ? `<br><small>última: ${fmtTs(e.lastCheckAt)}</small>` : ''}</td>
    <td class="nowrap"><button class="icon-btn" data-dl="${e.id}" data-name="${esc(e.name)}">${withIcon('download', 'Baixar', 16)}</button>${e.diffs?.length ? `<br><button class="icon-btn" data-diff="${e.id}" title="Ver as diferenças entre o CSV e o que está publicado" style="margin-top:6px">${withIcon('search', 'Diferenças', 16)}</button>` : ''}
      ${edit && OPEN.includes(e.status) ? `<br>${e.verifyPending ? `<button class="icon-btn" disabled title="Já há uma verificação pedida: aguarde o resultado" style="margin-top:6px">${withIcon('clock', 'Verificando…', 16)}</button>` : `<button class="primary icon-btn" data-verify="${e.id}" style="margin-top:6px">${withIcon('check', 'Já publiquei', 16)}</button>`}` : ''}</td></tr>`).join('')}</table>` : '<small>Nenhuma exportação neste filtro.</small>';
}

async function download(id, name) {
  try {
    const blob = await (await api(`/api/exports/${id}/csv`)).blob();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    a.click(); URL.revokeObjectURL(a.href);
  } catch (e) { toast(e.message, true); }
}

// Notas antigas traziam o JSON das diferenças no texto: mostra só a frase (os detalhes ficam no botão da lupa).
const shortNote = (e) => String(e.note ?? '').split(' Diferenças: [')[0];

// ---------- modal das diferenças ----------
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
// mesmas cores das barras do painel do dia (atividade, almoço, snack)
const COLORS = { work: '#FF4000', lunch: '#00BFFF', snack: '#A475FF' };
const barColor = (name) => (/lunch|almo/i.test(name) ? COLORS.lunch : /snack/i.test(name) ? COLORS.snack : COLORS.work);
function blocksHtml(blocks, lo, hi) {
  if (!blocks.length) return '<div class="df-empty">sem turno</div>';
  const span = Math.max(60, hi - lo);
  const bar = blocks.map((b) => `<i style="left:${((mins(b.s) - lo) / span) * 100}%;width:${Math.max(1, ((mins(b.e) - mins(b.s)) / span) * 100)}%;background:${barColor(b.a)}" title="${esc(b.a)} ${b.s}–${b.e}"></i>`).join('');
  return `<div class="df-bar">${bar}</div><div class="df-list">${blocks.map((b) => `<span><b>${b.s}–${b.e}</b> ${esc(b.a)}</span>`).join('')}</div>`;
}
function diffRowHtml(month, r) {
  const all = [...r.esperado, ...r.publicado];
  const lo = Math.floor(Math.min(...all.map((b) => mins(b.s)), 1440) / 60) * 60, hi = Math.ceil(Math.max(...all.map((b) => mins(b.e)), 0) / 60) * 60;
  const d = new Date(`${month}-${String(r.dia).padStart(2, '0')}T12:00`);
  return `<div class="df-row"><div class="df-day"><b>${String(r.dia).padStart(2, '0')}/${month.slice(5)}</b><small>${DOW[d.getDay()]}</small></div>
    <div><small class="df-lbl">Esperado (CSV)</small>${blocksHtml(r.esperado, lo, hi)}</div>
    <div><small class="df-lbl">Publicado no WFM</small>${blocksHtml(r.publicado, lo, hi)}</div></div>`;
}
function openDiffs(e) {
  const items = e.diffs ?? [], by = new Map();
  for (const r of items) { if (!by.has(r.email)) by.set(r.email, []); by.get(r.email).push(r); }
  let modal = document.getElementById('modal');
  if (!modal) { document.body.insertAdjacentHTML('beforeend', '<div id="modal" class="modal hidden"></div>'); modal = document.getElementById('modal'); }
  const total = e.diffTotal ?? items.length;
  modal.innerHTML = `<div class="modal-card diff"><header class="df-head"><h2>Diferenças · ${esc(e.name)}</h2><button id="dfClose">${withIcon('x', 'Fechar', 16)}</button></header>
    <p class="meta"><b>${total}</b> dia(s) diferem entre o CSV e o que está publicado no WFM${items.length < total ? ` (mostrando os primeiros ${items.length})` : ''}. Confira se o arquivo importado é o desta exportação e se foi publicado por inteiro.</p>
    <div class="tl-legend"><span><i style="background:${COLORS.work}"></i>Atividade</span><span><i style="background:${COLORS.lunch}"></i>Almoço</span><span><i style="background:${COLORS.snack}"></i>Snack</span></div>
    ${[...by.entries()].map(([email, rows]) => `<section class="df-agent"><h3>${esc(email)} <small>${rows.length} dia(s)</small></h3>${rows.map((r) => diffRowHtml(e.month, r)).join('')}</section>`).join('')}</div>`;
  modal.classList.remove('hidden');
  const close = () => { modal.classList.add('hidden'); modal.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.onclick = (ev) => { if (ev.target === modal) close(); };
  document.getElementById('dfClose').onclick = close;
}


async function verify(id) {
  try {
    const r = await (await api(`/api/exports/${id}/verify`, { method: 'POST' })).json();
    if (r.verifyPending) toast('Verificação pedida. O sistema confere o WFM em alguns minutos e o status muda sozinho.');
    else toast('Verificado: o publicado reflete o CSV. Exportação consolidada.');
  } catch (e) { toast(e.message, true); }
  await load();
}

document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-dl]'); if (d) return download(d.dataset.dl, d.dataset.name);
  const df = e.target.closest('[data-diff]'); if (df) { const it = S.items.find((x) => x.id === df.dataset.diff); if (it) openDiffs(it); return; }
  const v = e.target.closest('[data-verify]'); if (v) { v.disabled = true; verify(v.dataset.verify); }
});
$('#statusFilter').onchange = (e) => { S.status = e.target.value; render(); };
$('#teamSelect').onchange = async (e) => { S.team = e.target.value; syncUrl(true); await load(); };
window.addEventListener('popstate', async () => { const t = parseRoute(); if (t) S.team = t; $('#teamSelect').value = S.team; await load(); });

(async () => {
  try {
    S.meta = await getJson('/api/meta');
    await setupMockLogin($('#mockUser'), () => start(false));
    await start(true);
    presence = startPresence({ page: 'exportacoes', getCtx: () => ({ team: S.team, month: '' }), onUpdate: (l) => renderPresence(l, { chipsEl: $('#presence') }) });
    setInterval(() => load().catch(() => {}), 20000);
  } catch (e) { toast(e.message, true); }
})();
