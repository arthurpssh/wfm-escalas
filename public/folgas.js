import { icon, withIcon } from '/icons.js';
import { $, esc, api, getJson, toast, setupMockLogin, fmtTs, fmtDT, TF_LABEL, decideTimeoff, renderNav, rememberView, recallView, fmtHM, startPresence, renderPresence } from '/common.js';
import { localMonth } from '/shared/rules.js';
import { openTimeoffLot } from '/timeoffLot.js';

const ORIGIN = { app: 'app', agent: 'agente', wfm: 'WFM' };
const S = { me: null, team: null, month: null, timeoffs: [], agents: [], role: 'viewer', filter: '', status: '', meta: null, holidays: [], holidayReason: '', lots: [] };
const canEdit = () => S.role === 'editor';
const agentName = (email) => S.agents.find((a) => a.email === email)?.name ?? email;

// ---------- rota: /folgas/:time/:YYYY-MM ----------
function parseRoute() {
  const m = location.pathname.match(/^\/folgas\/([^/]+)\/(\d{4}-(?:0[1-9]|1[0-2]))\/?$/);
  return m ? { team: decodeURIComponent(m[1]), month: m[2] } : {};
}
const routeUrl = () => `/folgas/${encodeURIComponent(S.team).replace(/%40/g, '@')}/${S.month}`;
function syncUrl(push) {
  rememberView(S.team, S.month);
  if (location.pathname !== routeUrl()) history[push ? 'pushState' : 'replaceState'](null, '', routeUrl());
}

async function start(useRoute) {
  S.me = await getJson('/api/me');
  S.meta ??= await getJson('/api/meta');
  renderNav('folgas', S.me);
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
  const q = `team=${encodeURIComponent(S.team)}&month=${S.month}`;
  const [sch, tos, hol, lots] = await Promise.all([getJson(`/api/schedule?${q}`), getJson(`/api/timeoffs?${q}`), getJson(`/api/holidays?${q}`), getJson(`/api/timeoff-lots?${q}`)]);
  S.agents = sch.agents; S.role = sch.role; S.timeoffs = tos; S.holidays = hol.holidays; S.holidayReason = hol.reasonId; S.lots = lots;
  $('#roleBanner').classList.toggle('hidden', canEdit());
  $('#roleBanner').textContent = `Você tem acesso apenas de visualização às folgas de ${S.team}.`;
  render();
}

const matches = (t) => !S.filter || `${t.email} ${agentName(t.email)}`.toLowerCase().includes(S.filter.toLowerCase());

const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
function renderHolidays() {
  const edit = canEdit();
  $('#holidayHint').classList.toggle('hidden', !edit || !S.holidays.length);
  $('#holidays').innerHTML = S.holidays.length ? S.holidays.map((h) => edit
    ? `<button class="chip-h" data-hday="${h.date}" data-hname="${esc(h.name)}" title="Criar folgas em lote para este feriado"><b>${dm(h.date)}</b> ${esc(h.name)}${h.type === 'facultativo' ? ' <small>(facultativo)</small>' : ''}</button>`
    : `<span class="chip-h static"><b>${dm(h.date)}</b> ${esc(h.name)}</span>`).join('') : '<small>Nenhum feriado neste mês.</small>';
}

// dia inteiro mostra só as datas; senão, data e hora
const LOT_PERIOD = (l) => {
  if (!(l.startTime.slice(11, 16) === '00:00' && l.endTime.slice(11, 19) === '23:59:59')) return `${fmtDT(l.startTime)} → ${fmtDT(l.endTime)}`;
  const a = fmtDT(l.startTime).slice(0, 5), b = fmtDT(l.endTime).slice(0, 5);
  return a === b ? `${a} (dia inteiro)` : `${a} → ${b} (dias inteiros)`;
};
function renderLots() {
  const edit = canEdit();
  $('#lotCard').classList.toggle('hidden', !S.lots.length);
  $('#lots').innerHTML = S.lots.length ? `<table class="plain"><tr><th>Criado</th><th>Razão</th><th>Período</th><th>Agentes</th><th>Situação</th><th></th></tr>${S.lots.map((l) => `<tr>
    <td>${fmtTs(l.createdAt)}<br><small>${esc(l.createdBy)}</small></td><td>${esc(l.reasonName)}</td><td>${LOT_PERIOD(l)}</td>
    <td title="${esc(l.agents.join(', '))}">${l.total}</td>
    <td>${[l.enviada ? `<span class="badge tf-aprovada">${l.enviada} enviada${l.enviada > 1 ? 's' : ''}</span>` : '', l.agendada ? `<span class="badge tf-agendada">${l.agendada} agendada${l.agendada > 1 ? 's' : ''}</span>` : '', l.erro ? `<span class="badge tf-erro">${l.erro} com erro</span>` : '', l.cancelada ? `<span class="badge tf-negada">${l.cancelada} cancelada${l.cancelada > 1 ? 's' : ''}</span>` : ''].filter(Boolean).join(' ')}
      ${l.agendada && l.nextSendAt ? `<br><small>próximo envio a partir de ${fmtHM(l.nextSendAt)}</small>` : ''}${l.errors.length ? `<br><small title="${esc(l.errors.map((e) => `${e.email}: ${e.note}`).join('\n'))}">${esc(l.errors[0].email)}: ${esc((l.errors[0].note || '').slice(0, 90))}${l.errors.length > 1 || l.erro > 1 ? '…' : ''}</small>` : ''}</td>
    <td>${edit && l.agendada ? `<button class="icon-btn" data-lot="${l.loteId}" title="Cancela o que ainda não foi enviado ao WFM">${withIcon('x', 'Cancelar o que falta', 16)}</button>` : ''}</td></tr>`).join('')}</table>` : '';
}

function openLot(prefill = {}) {
  openTimeoffLot({ team: S.team, month: S.month, agents: S.agents, reasons: S.meta.timeoffReasons, graceMinutes: S.meta.graceMinutes, prefill, onDone: load });
}

function render() {
  const edit = canEdit();
  $('#addLot').classList.toggle('hidden', !edit);
  renderHolidays(); renderLots();
  const reqs = S.timeoffs.filter((t) => t.status === 'pendente' && matches(t)).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  $('#reqCount').textContent = reqs.length;
  $('#requests').innerHTML = reqs.length ? `<table class="plain"><tr><th>Agente</th><th>Razão</th><th>Período</th><th>Solicitada em</th><th></th></tr>${reqs.map((t) => `<tr>
    <td>${esc(agentName(t.email))}<br><small>${esc(t.email)}</small></td><td>${esc(t.reasonName)}</td><td>${fmtDT(t.startTime)} → ${fmtDT(t.endTime)}</td><td>${t.createdAt ? fmtTs(t.createdAt) : '—'}</td>
    <td>${edit ? `<button class="primary icon-btn" data-act="approve" data-id="${t.id}">${withIcon('check', 'Aceitar', 16)}</button> <button class="icon-btn" data-act="deny" data-id="${t.id}">${withIcon('x', 'Recusar', 16)}</button>` : ''}</td></tr>`).join('')}</table>` : '<small>Nenhuma solicitação pendente.</small>';

  const rest = S.timeoffs.filter((t) => t.status !== 'pendente' && matches(t) && (!S.status || t.status === S.status)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  $('#list').innerHTML = rest.length ? `<table class="plain"><tr><th>Agente</th><th>Razão</th><th>Período</th><th>Status</th><th>Origem</th><th>Por</th><th></th></tr>${rest.map((t) => `<tr class="${t.status === 'negada' ? 'expired' : ''}">
    <td>${esc(agentName(t.email))}<br><small>${esc(t.email)}</small></td><td>${esc(t.reasonName)}</td><td>${fmtDT(t.startTime)} → ${fmtDT(t.endTime)}</td>
    <td><span class="badge tf-${t.status}">${TF_LABEL[t.status] ?? t.status}</span>${t.status === 'agendada' ? `<br><small>envio ${fmtHM(t.scheduledAt)}</small>` : t.status === 'erro' && t.note ? `<br><small title="${esc(t.note)}">${esc(t.note.length > 160 ? t.note.slice(0, 160) + '…' : t.note)}</small>` : ''}</td>
    <td>${ORIGIN[t.origin] ?? '—'}</td><td><small>${esc(t.decidedBy ?? t.createdBy ?? '')}</small></td>
    <td>${!edit ? '' : t.status === 'agendada' ? `<button class="icon-btn" data-act="delete" data-id="${t.id}">${withIcon('trash', 'Excluir', 16)}</button>` : t.status === 'aprovada' ? `<button class="icon-btn" data-act="deny" data-id="${t.id}">${withIcon('ban', 'Cancelar folga', 16)}</button>` : ''}</td></tr>`).join('')}</table>` : '<small>Nenhuma folga neste filtro.</small>';
}

async function act(id, action) {
  const t = S.timeoffs.find((x) => x.id === id);
  const msg = { approve: 'Aceitar este pedido de folga?', delete: 'Excluir esta folga agendada? Ela ainda não foi enviada ao WFM.' }[action]
    ?? (t.status === 'aprovada' ? 'Cancelar esta folga? Ela será negada no WFM (não dá para excluir).' : 'Recusar este pedido de folga?');
  if (!confirm(msg)) return;
  try {
    if (action === 'delete') await api(`/api/timeoffs/${id}`, { method: 'DELETE' });
    else await decideTimeoff(id, action);
    toast({ approve: 'Pedido aceito.', delete: 'Folga excluída.', deny: t.status === 'aprovada' ? 'Folga cancelada (negada).' : 'Pedido recusado.' }[action]);
  } catch (e) { toast(e.message, true); }
  await load();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (b) return act(b.dataset.id, b.dataset.act);
  const h = e.target.closest('[data-hday]');
  if (h) return openLot({ reasonId: S.holidayReason, fullDay: true, from: h.dataset.hday, to: h.dataset.hday, title: `${dm(h.dataset.hday)} · ${h.dataset.hname}`, preselect: 'suggested' });
  const l = e.target.closest('[data-lot]');
  if (l) {
    if (!confirm('Cancelar as folgas deste lote que ainda não foram enviadas ao WFM? As já enviadas continuam valendo (cancele-as uma a uma, na lista de folgas).')) return;
    try { const r = await (await api(`/api/timeoff-lots/${l.dataset.lot}`, { method: 'DELETE' })).json(); toast(`${r.cancelled} folga(s) cancelada(s)${r.kept ? `; ${r.kept} já enviada(s) continuam valendo` : ''}.`); } catch (er) { toast(er.message, true); }
    await load();
  }
});
$('#addLot').onclick = () => openLot();
$('#filter').oninput = (e) => { S.filter = e.target.value; render(); };
$('#statusFilter').onchange = (e) => { S.status = e.target.value; render(); };
$('#teamSelect').onchange = async (e) => { S.team = e.target.value; syncUrl(true); await load(); };
const shift = (d) => { const [y, m] = S.month.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
const setMonth = async (m) => { if (!m) return; S.month = m; $('#monthInput').value = m; syncUrl(true); await load(); };
$('#monthInput').onchange = (e) => setMonth(e.target.value);
$('#prevMonth').onclick = () => setMonth(shift(-1));
$('#nextMonth').onclick = () => setMonth(shift(1));
window.addEventListener('popstate', async () => { const r = parseRoute(); if (r.team) S.team = r.team; if (r.month) S.month = r.month; $('#teamSelect').value = S.team; $('#monthInput').value = S.month; await load(); });

(async () => {
  try { await setupMockLogin($('#mockUser'), () => start(false)); await start(true); presence = startPresence({ page: 'folgas', getCtx: () => ({ team: S.team, month: S.month }), onUpdate: (l) => renderPresence(l, { chipsEl: $('#presence') }) }); setInterval(() => load().catch(() => {}), 20000); }
  catch (e) { toast(e.message, true); }
})();
