// Trocas de dia extra entre agentes (visão da supervisão): o que já passou pelo aceite do colega espera a decisão aqui.
// Consolidar = as mudanças entram no RASCUNHO da escala (a exportação e o CSV seguem o fluxo de sempre); recusar encerra a troca.
import { withIcon } from '/icons.js';
import { $, esc, api, getJson, toast, setupMockLogin, fmtTs, renderNav, rememberView, recallView, startPresence, renderPresence } from '/common.js';
import { localMonth } from '/shared/rules.js';

const S = { me: null, team: null, month: null, list: [] };
const canEdit = () => S.me?.teams.find((t) => t.name === S.team)?.role === 'editor';
const BADGE = { pendente_agente: 'tf-pendente', pendente_supervisor: 'tf-pendente', consolidada: 'tf-aprovada', recusada: 'tf-negada', cancelada: 'tf-negada', expirada: 'tf-negada', invalidada: 'tf-negada' };
const dayShort = (d) => new Date(`${d}T12:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

// ---------- rota: /trocas/:time/:YYYY-MM ----------
function parseRoute() {
  const m = location.pathname.match(/^\/trocas\/([^/]+)\/(\d{4}-(?:0[1-9]|1[0-2]))\/?$/);
  return m ? { team: decodeURIComponent(m[1]), month: m[2] } : {};
}
const routeUrl = () => `/trocas/${encodeURIComponent(S.team).replace(/%40/g, '@')}/${S.month}`;
function syncUrl(push) {
  rememberView(S.team, S.month);
  if (location.pathname !== routeUrl()) history[push ? 'pushState' : 'replaceState'](null, '', routeUrl());
}

async function start(useRoute) {
  S.me = await getJson('/api/me');
  renderNav('trocas', S.me);
  const r = useRoute ? parseRoute() : {};
  const mem = recallView();
  const wanted = r.team ?? mem.team;
  S.team = S.me.teams.some((t) => t.name === wanted) ? wanted : S.me.defaultTeam;
  S.month = r.month ?? mem.month ?? localMonth();
  $('#teamSelect').innerHTML = S.me.teams.map((t) => `<option value="${esc(t.name)}" ${t.name === S.team ? 'selected' : ''}>${esc(t.name)} · ${t.role === 'editor' ? 'edição' : 'leitura'} (${t.agentCount})</option>`).join('');
  $('#monthInput').value = S.month;
  syncUrl(false);
  await load();
}

let presence = null;
async function load() {
  presence?.touch();
  S.list = await getJson(`/api/swaps?team=${encodeURIComponent(S.team)}&month=${S.month}`);
  $('#roleBanner').classList.toggle('hidden', canEdit());
  $('#roleBanner').textContent = `Você tem acesso apenas de visualização às trocas de ${S.team}.`;
  render();
}

const what = (s) => `<b>${esc(s.requesterName)}</b> assume o dia <b>${dayShort(s.date)}</b> de <b>${esc(s.ownerName)}</b>${s.offerDate ? `<br><small>e <b>${esc(s.ownerName)}</b> assume o dia <b>${dayShort(s.offerDate)}</b> de ${esc(s.requesterName)}</small>` : '<br><small>sem dia em troca</small>'}`;

function render() {
  const edit = canEdit();
  const pend = S.list.filter((s) => s.status === 'pendente_supervisor'), rest = S.list.filter((s) => s.status !== 'pendente_supervisor');
  $('#pendCount').textContent = pend.length;
  $('#pending').innerHTML = pend.length ? `<table class="plain"><tr><th>Troca</th><th>Pedida em</th><th>Atenção</th><th></th></tr>${pend.map((s) => `<tr>
    <td>${what(s)}</td><td>${fmtTs(s.createdAt)}</td>
    <td>${s.problems.length ? `<div class="errors-inline">Não vale mais: ${esc(s.problems[0])}</div>` : ''}${s.warnings.length ? `<ul class="warns-inline">${s.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : (s.problems.length ? '' : '<small>sem avisos</small>')}</td>
    <td>${edit ? `<button class="primary icon-btn" data-act="consolidate" data-id="${s.id}" ${s.problems.length ? 'disabled' : ''}>${withIcon('check', 'Consolidar', 16)}</button> <button class="icon-btn" data-act="deny" data-id="${s.id}">${withIcon('x', 'Recusar', 16)}</button>` : ''}</td></tr>`).join('')}</table>` : '<small>Nenhuma troca aguardando a supervisão.</small>';

  $('#rest').innerHTML = rest.length ? `<table class="plain"><tr><th>Troca</th><th>Situação</th><th>Pedida em</th></tr>${rest.map((s) => `<tr class="${['recusada', 'cancelada', 'expirada', 'invalidada'].includes(s.status) ? 'expired' : ''}">
    <td>${what(s)}</td>
    <td><span class="badge ${BADGE[s.status] ?? 'tf-agendada'}">${esc(s.statusLabel)}</span>${s.refusedBy ? `<br><small>recusada ${s.refusedBy === 'agente' ? 'pelo colega' : 'pela supervisão'}</small>` : ''}${s.decidedBy ? `<br><small>${esc(s.decidedBy)}</small>` : ''}${s.note ? `<br><small>${esc(s.note)}</small>` : ''}</td>
    <td>${fmtTs(s.createdAt)}</td></tr>`).join('')}</table>` : '<small>Nenhuma outra troca neste mês.</small>';
}

async function act(id, action) {
  const s = S.list.find((x) => x.id === id);
  let note = '';
  if (action === 'deny') { note = prompt('Motivo da recusa (opcional, o colega e quem pediu poderão ver):', '') ?? null; if (note === null) return; }
  else if (!confirm(`Consolidar a troca? ${s.requesterName} passa a ter o dia ${dayShort(s.date)} no rascunho${s.offerDate ? ` e ${s.ownerName} o dia ${dayShort(s.offerDate)}` : ''}. Depois é só revisar e confirmar na Escala.`)) return;
  try {
    const r = await (await api(`/api/swaps/${id}/decision`, { method: 'POST', body: { action, note } })).json();
    if (action === 'consolidate') {
      const months = r.months ?? [S.month];
      $('#info').innerHTML = `Troca consolidada: as mudanças entraram no rascunho de ${months.map((m) => `<a href="/escalas/${encodeURIComponent(S.team).replace(/%40/g, '@')}/${m}">${m}</a>`).join(' e ')}. Revise e confirme na Escala.`;
      $('#info').classList.remove('hidden');
      toast('Troca consolidada: veja o rascunho na Escala.');
    } else toast('Troca recusada.');
  } catch (e) { toast(e.message, true); }
  await load();
}

document.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) act(b.dataset.id, b.dataset.act); });
$('#teamSelect').onchange = async (e) => { S.team = e.target.value; $('#info').classList.add('hidden'); syncUrl(true); await load(); };
const shift = (d) => { const [y, m] = S.month.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
const setMonth = async (m) => { if (!m) return; S.month = m; $('#monthInput').value = m; $('#info').classList.add('hidden'); syncUrl(true); await load(); };
$('#monthInput').onchange = (e) => setMonth(e.target.value);
$('#prevMonth').onclick = () => setMonth(shift(-1));
$('#nextMonth').onclick = () => setMonth(shift(1));
window.addEventListener('popstate', async () => { const r = parseRoute(); if (r.team) S.team = r.team; if (r.month) S.month = r.month; $('#teamSelect').value = S.team; $('#monthInput').value = S.month; await load(); });

(async () => {
  try {
    await setupMockLogin($('#mockUser'), () => start(false)); await start(true);
    presence = startPresence({ page: 'trocas', getCtx: () => ({ team: S.team, month: S.month }), onUpdate: (l) => renderPresence(l, { chipsEl: $('#presence') }) });
    setInterval(() => load().catch(() => {}), 20000);
  } catch (e) { toast(e.message, true); }
})();
