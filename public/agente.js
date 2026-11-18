// Portal do agente (somente leitura): a escala do próprio time e as próprias folgas.
// Colegas aparecem por nome. A folga de um colega é só "Férias", "Folga total" ou "Folga parcial" (o servidor nem envia o motivo).
import { withIcon } from '/icons.js';
import { $, esc, api, getJson, toast, setupMockLogin, dayLabel, fmtDT, renderNav } from '/common.js';
import { TZ, dateOf, localDate, localMonth } from '/shared/rules.js';

const S = { me: null, month: null, data: null, own: [], swaps: [], filter: '', sel: null, meta: null };
const COL_W = 64;
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const TF = { ferias: 'Férias', total: 'Folga total', parcial: 'Folga parcial' };
const TF_CLASS = { total: 'full', parcial: 'partial', ferias: 'vac' };
const OWN_LABEL = { aprovada: 'aprovada', pendente: 'aguardando decisão', agendada: 'agendada', solicitada: 'enviando (dá para cancelar)', negada: 'recusada', processando: 'em processamento' };
const OWN_BADGE = { aprovada: 'tf-aprovada', pendente: 'tf-pendente', agendada: 'tf-agendada', solicitada: 'tf-agendada', negada: 'tf-negada', processando: 'tf-agendada' };

// ---------- rota: /minha-escala[/YYYY-MM] ----------
const parseMonth = () => location.pathname.match(/^\/minha-escala\/(\d{4}-(?:0[1-9]|1[0-2]))\/?$/)?.[1];
const syncUrl = (push) => { const to = `/minha-escala/${S.month}`; if (location.pathname !== to) history[push ? 'pushState' : 'replaceState'](null, '', to); };

async function load() {
  const [data, own, swaps] = await Promise.all([getJson(`/api/portal/schedule?month=${S.month}`), getJson(`/api/portal/timeoffs?month=${S.month}`), getJson('/api/portal/swaps')]);
  S.data = data; S.own = own; S.swaps = swaps;
  $('#teamLabel').textContent = data.teamLabel;
  render();
  if (S.sel) renderPanel();
}

const hm = (iso) => iso.slice(11, 16);
const endHM = (s) => hm(s.endTime) + (s.endTime.slice(0, 10) > s.startTime.slice(0, 10) ? '<sup>+1</sup>' : '');

function render() {
  const { agents, cells, tf, daysInMonth: n } = S.data;
  const f = S.filter.toLowerCase();
  const list = agents.filter((a) => a.self || !f || a.name.toLowerCase().includes(f));
  const today = localDate();
  const head = Array.from({ length: n }, (_, i) => {
    const d = i + 1, dt = new Date(+S.month.slice(0, 4), +S.month.slice(5) - 1, d), we = [0, 6].includes(dt.getDay());
    return `<th class="${we ? 'weekend' : ''} ${dateOf(S.month, d) === today ? 'today' : ''}">${String(d).padStart(2, '0')}<small>${WD[dt.getDay()]}</small></th>`;
  }).join('');
  const rows = list.map((a) => {
    const body = Array.from({ length: n }, (_, i) => {
      const d = i + 1, shifts = cells[a.id]?.[d] ?? [], label = tf[a.id]?.[d], ex = S.data.extra?.[a.id]?.[d];
      const sel = S.sel?.id === a.id && S.sel.day === d ? ' sel' : '';
      const attrs = `data-a="${esc(a.id)}" data-d="${d}"`;
      if (!shifts.length) return `<td class="cell${label === 'ferias' ? ' vac' : ''}${sel}" ${attrs}>${label === 'ferias' ? '<span class="off">férias</span>' : ''}</td>`;
      const cls = label ? TF_CLASS[label] : ex ? 'extra' : 'ok';
      return `<td class="cell ${cls}${ex ? ' xt' : ''}${sel}" ${attrs} title="${esc(a.name)} — ${d}/${S.month.slice(5)}${label ? ` · ${TF[label]}` : ''}${ex ? ' · dia extra' : ''}">${ex ? '<span class="xtra" title="Dia extra: fora da escala padrão">+</span>' : ''}${hm(shifts[0].startTime)}<br>${endHM(shifts.at(-1))}</td>`;
    }).join('');
    return `<tr class="${a.self ? 'self' : ''}"><td class="agent"><b>${esc(a.name)}</b><small>${a.self ? 'você' : ''}</small></td>${body}</tr>`;
  }).join('');
  const wrap = $('#tableWrap'), sl = wrap.scrollLeft;
  wrap.innerHTML = `<table><thead><tr><th class="agent">Colega</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.scrollLeft = sl;
  wrap.querySelectorAll('td.cell').forEach((c) => (c.onclick = () => openDay(c.dataset.a, Number(c.dataset.d))));

  renderSwaps();
  const mine = S.data.agents.find((a) => a.self);
  $('#own').onclick = (e) => { const b = e.target.closest('[data-cancel]'); if (b) cancelRequest(b.dataset.cancel); };
  $('#own').innerHTML = S.own.length
    ? `<table class="plain"><tr><th>Razão</th><th>Período</th><th>Situação</th><th>Pedida em</th><th></th></tr>${S.own.map((t) => `<tr><td>${esc(t.reasonName)}</td><td>${fmtDT(t.startTime)} → ${fmtDT(t.endTime)}</td><td><span class="badge ${OWN_BADGE[t.status]}">${OWN_LABEL[t.status] ?? t.status}</span></td><td>${t.createdAt ? fmtDT(t.createdAt) : '—'}</td><td>${t.cancelable ? `<button class="icon-btn" data-cancel="${esc(t.id)}" title="Cancela o pedido enquanto a supervisão não decidiu">${withIcon('x', 'Cancelar pedido', 16)}</button>` : ''}</td></tr>`).join('')}</table>`
    : `<small>${mine ? 'Você não tem folgas neste mês.' : ''}</small>`;
}

// ---------- painel do dia ----------
function openDay(id, day) { S.sel = { id, day }; document.body.classList.add('panel-open'); render(); renderPanel(); }
function closePanel() { S.sel = null; document.body.classList.remove('panel-open'); $('#panel').classList.add('hidden'); render(); }

function renderPanel() {
  const { id, day } = S.sel, a = S.data.agents.find((x) => x.id === id), date = dateOf(S.month, day);
  const shifts = S.data.cells[id]?.[day] ?? [], label = S.data.tf[id]?.[day];
  let html = `<header><div><h2>${esc(a.name)}${a.self ? ' <small>(você)</small>' : ''}</h2><small>${dayLabel(date)}</small></div><button id="closeBtn">${withIcon('x', 'Fechar')}</button></header>`;
  html += `<h3 class="sec">Escala do dia</h3>`;
  html += shifts.length
    ? `<table class="plain"><tr><th>Horário</th><th>Atividade</th></tr>${shifts.map((s) => `<tr><td>${hm(s.startTime)}–${endHM(s)}</td><td>${esc(s.taskName)}</td></tr>`).join('')}</table>`
    : '<p class="hint">Sem escala neste dia.</p>';
  if (label) html += `<div class="note">${label === 'ferias' ? 'Férias' : label === 'total' ? 'Folga total: cobre todo o dia de trabalho.' : 'Folga parcial: cobre só uma parte do dia.'}</div>`;
  const isExtra = !!S.data.extra?.[id]?.[day];
  if (isExtra) html += `<div class="note extra">Dia extra: fora da escala padrão ${a.self ? 'da sua escala' : `de ${esc(a.name)}`}.</div>`;
  if (isExtra && !a.self && date > localDate()) html += `<div class="actions"><button id="swapBtn" class="primary">Pedir para assumir este dia</button></div>`;
  if (a.self) {
    const mine = S.own.filter((t) => t.startTime.slice(0, 10) <= date && t.endTime.slice(0, 10) >= date);
    html += `<h3 class="sec">Minhas folgas neste dia</h3>`;
    html += mine.length
      ? mine.map((t) => `<div class="tf"><div class="head"><b>${esc(t.reasonName)}</b><span class="badge ${OWN_BADGE[t.status]}">${OWN_LABEL[t.status] ?? t.status}</span></div><div class="meta">${fmtDT(t.startTime)} → ${fmtDT(t.endTime)}</div></div>`).join('')
      : '<p class="hint">Nenhuma folga neste dia.</p>';
  }
  const p = $('#panel'); p.innerHTML = html; p.classList.remove('hidden');
  $('#closeBtn').onclick = closePanel;
  $('#swapBtn')?.addEventListener('click', () => openSwap(id, day));
}

// ---------- trocas de dia extra ----------
const SW_BADGE = { pendente_agente: 'tf-pendente', pendente_supervisor: 'tf-pendente', consolidada: 'tf-aprovada', recusada: 'tf-negada', cancelada: 'tf-negada', expirada: 'tf-negada', invalidada: 'tf-negada' };
const dayShort = (d) => new Date(`${d}T12:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const swapText = (s) => (s.role === 'solicitante'
  ? `Você pediu o dia <b>${dayShort(s.date)}</b> de <b>${esc(s.otherName)}</b>${s.offerDate ? ` e ofereceu o seu dia <b>${dayShort(s.offerDate)}</b>` : ''}`
  : `<b>${esc(s.otherName)}</b> pediu o seu dia <b>${dayShort(s.date)}</b>${s.offerDate ? ` e oferece o dia <b>${dayShort(s.offerDate)}</b> em troca` : ''}`);

function renderSwaps() {
  const el = $('#swaps'); if (!el) return;
  el.onclick = (e) => { const b = e.target.closest('[data-sw]'); if (b) swapAct(b.dataset.id, b.dataset.sw); };
  const acts = (s) => (s.role === 'dono' && s.status === 'pendente_agente'
    ? `<button class="primary icon-btn" data-sw="accept" data-id="${esc(s.id)}">${withIcon('check', 'Aceitar', 16)}</button> <button class="icon-btn" data-sw="refuse" data-id="${esc(s.id)}">${withIcon('x', 'Recusar', 16)}</button>`
    : s.role === 'solicitante' && ['pendente_agente', 'pendente_supervisor'].includes(s.status) ? `<button class="icon-btn" data-sw="cancel" data-id="${esc(s.id)}">${withIcon('x', 'Cancelar pedido', 16)}</button>` : '');
  el.innerHTML = S.swaps.length
    ? `<table class="plain"><tr><th>Troca</th><th>Situação</th><th></th></tr>${S.swaps.map((s) => `<tr><td>${swapText(s)}</td><td><span class="badge ${SW_BADGE[s.status] ?? 'tf-agendada'}">${esc(s.statusLabel)}</span>${s.refusedBy ? `<br><small>recusada ${s.refusedBy === 'agente' ? 'pelo colega' : 'pela supervisão'}</small>` : ''}${s.note ? `<br><small>${esc(s.note)}</small>` : ''}</td><td>${acts(s)}</td></tr>`).join('')}</table>`
    : '<small>Você não tem trocas em andamento. Para pedir, clique em um dia extra (marcado com +) de um colega.</small>';
}

async function swapAct(id, act) {
  const msg = { accept: 'Aceitar a troca? Você deixa de trabalhar nesse dia (e passa a trabalhar no dia oferecido, se houver). A supervisão ainda decide.', refuse: 'Recusar este pedido de troca?', cancel: 'Cancelar este pedido de troca?' }[act];
  if (!confirm(msg)) return;
  try {
    await api(`/api/portal/swaps/${id}/${act === 'cancel' ? 'cancel' : 'respond'}`, { method: 'POST', body: act === 'cancel' ? undefined : { accept: act === 'accept' } });
    toast({ accept: 'Troca aceita: agora a supervisão decide.', refuse: 'Pedido recusado.', cancel: 'Pedido cancelado.' }[act]);
  } catch (e) { toast(e.message, true); }
  await load();
}

function openSwap(ownerId, day) {
  const root = $('#modal'), owner = S.data.agents.find((a) => a.id === ownerId), date = dateOf(S.month, day), me = S.data.agents.find((a) => a.self), today = localDate();
  const mineDays = Object.keys(S.data.extra?.[me.id] ?? {}).map(Number).filter((d) => dateOf(S.month, d) > today && S.data.cells[me.id]?.[d]?.length);
  const close = () => { root.classList.add('hidden'); root.innerHTML = ''; };
  root.innerHTML = `<div class="modal-card small"><h2>Pedir para assumir o dia</h2>
    <p>Você vai pedir o dia extra <b>${dayShort(date)}</b> de <b>${esc(owner.name)}</b>.</p>
    <div class="row"><label>Oferecer em troca</label><select id="sOffer"><option value="">Não oferecer nada</option>${mineDays.map((d) => `<option value="${dateOf(S.month, d)}">${dayShort(dateOf(S.month, d))}</option>`).join('')}</select></div>
    ${mineDays.length ? '' : '<p class="hint">Você não tem um dia extra futuro neste mês para oferecer.</p>'}
    <div class="note">O pedido vai primeiro para <b>${esc(owner.name)}</b>. Se aceitar, a supervisão decide, e a escala só muda se ela consolidar. Você pode cancelar enquanto ninguém decidiu.</div>
    <div class="actions"><span class="spacer"></span><button type="button" id="sCancel">Voltar</button><button type="button" id="sOk" class="primary">${withIcon('check', 'Enviar pedido', 16)}</button></div></div>`;
  root.classList.remove('hidden');
  $('#sCancel').onclick = close;
  $('#sOk').onclick = async () => {
    $('#sOk').disabled = true;
    try { await api('/api/portal/swaps', { method: 'POST', body: { ownerId, date, offerDate: $('#sOffer').value } }); close(); toast('Pedido enviado ao colega.'); await load(); }
    catch (e) { $('#sOk').disabled = false; toast(e.message, true); }
  };
}

// ---------- pedir folga e cancelar pedido ----------
async function cancelRequest(id) {
  if (!confirm('Cancelar este pedido de folga? A supervisão ainda não decidiu.')) return;
  try { await api(`/api/portal/timeoffs/${id}/cancel`, { method: 'POST' }); toast('Pedido cancelado.'); } catch (e) { toast(e.message, true); }
  await load();
}

function openRequest() {
  const root = $('#modal'), today = localDate();
  const st = { reasonId: '', fullDay: true, from: today, to: today, start: `${today}T09:00`, end: `${today}T18:00`, busy: false };
  const period = () => st.fullDay
    ? { startTime: `${st.from}T00:00:00${TZ}`, endTime: `${st.to}T23:59:59${TZ}`, ok: !!st.from && !!st.to && st.from <= st.to }
    : { startTime: `${st.start}:00${TZ}`, endTime: `${st.end}:00${TZ}`, ok: !!st.start && !!st.end && st.start < st.end };
  const close = () => { root.classList.add('hidden'); root.innerHTML = ''; };
  const draw = () => {
    root.innerHTML = `<div class="modal-card small"><h2>Pedir folga</h2>
      <div class="row"><label>Motivo</label><select id="rReason"><option value="">Selecione…</option>${S.meta.timeoffReasons.map((r) => `<option value="${esc(r.taskId)}" ${r.taskId === st.reasonId ? 'selected' : ''}>${esc(r.taskName)}</option>`).join('')}</select></div>
      <div class="row"><label>Duração</label><label style="color:var(--text)"><input type="checkbox" id="rFull" ${st.fullDay ? 'checked' : ''}> Dia inteiro</label></div>
      ${st.fullDay
        ? `<div class="row"><label>Dias</label><div class="lot-dates"><input type="date" id="rFrom" value="${st.from}"> <span>até</span> <input type="date" id="rTo" value="${st.to}"></div></div>`
        : `<div class="row"><label>Início</label><input type="datetime-local" step="60" id="rStart" value="${st.start}"></div><div class="row"><label>Fim</label><input type="datetime-local" step="60" id="rEnd" value="${st.end}"></div>`}
      <div class="note">O pedido vai para a supervisão decidir e <b>não vale como folga até ser aceito</b>. Você pode cancelá-lo enquanto ninguém decidiu${S.meta.graceMinutes ? ` (nos primeiros ${S.meta.graceMinutes} min ele nem chega a ser enviado)` : ''}.</div>
      <div class="actions"><span class="spacer"></span><button type="button" id="rCancel">Voltar</button><button type="button" id="rOk" class="primary"></button></div></div>`;
    root.classList.remove('hidden');
    const foot = () => { const ok = $('#rOk'); ok.disabled = st.busy || !st.reasonId || !period().ok; ok.innerHTML = withIcon('check', 'Enviar pedido', 16); };
    $('#rReason').onchange = (e) => { st.reasonId = e.target.value; foot(); };
    $('#rFull').onchange = (e) => { st.fullDay = e.target.checked; draw(); };
    for (const [id, key] of [['#rFrom', 'from'], ['#rTo', 'to'], ['#rStart', 'start'], ['#rEnd', 'end']]) {
      const el = $(id); if (el) el.onchange = () => { st[key] = el.value; if (key === 'from' && st.to < st.from) { st.to = st.from; const t = $('#rTo'); if (t) t.value = st.to; } foot(); };
    }
    $('#rCancel').onclick = close;
    $('#rOk').onclick = async () => {
      const p = period(); if (!p.ok || !st.reasonId) return;
      st.busy = true; foot();
      try { await api('/api/portal/timeoffs', { method: 'POST', body: { reasonId: st.reasonId, startTime: p.startTime, endTime: p.endTime } }); close(); toast('Pedido enviado para a supervisão.'); await load(); }
      catch (e) { st.busy = false; foot(); toast(e.message, true); }
    };
    foot();
  };
  draw();
}
$('#askBtn').onclick = openRequest;

// ---------- navegação ----------
const shiftMonth = (d) => { const [y, m] = S.month.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
async function setMonth(m, push = true) { if (!m) return; S.month = m; $('#monthInput').value = m; S.sel = null; document.body.classList.remove('panel-open'); $('#panel').classList.add('hidden'); if (push) syncUrl(true); await load(); }
$('#monthInput').onchange = (e) => setMonth(e.target.value);
$('#prevMonth').onclick = () => setMonth(shiftMonth(-1));
$('#nextMonth').onclick = () => setMonth(shiftMonth(1));
$('#filter').oninput = (e) => { S.filter = e.target.value; render(); };
function pageWeek(dir) {
  const w = $('#tableWrap'), first = Math.round(w.scrollLeft / COL_W);
  w.scrollTo({ left: (dir < 0 ? Math.max(0, first - 7) : Math.min(S.data.daysInMonth - 1, first + 7)) * COL_W, behavior: 'smooth' });
}
$('#weekPrev').onclick = () => pageWeek(-1);
$('#weekNext').onclick = () => pageWeek(1);
window.addEventListener('popstate', () => setMonth(parseMonth() ?? localMonth(), false));

async function start() {
  S.me = await getJson('/api/me');
  S.meta ??= await getJson('/api/meta');
  renderNav('agente', S.me);
  if (!S.me.isAgent) { $('#banner').textContent = 'Você não aparece como agente de nenhum time.'; $('#banner').classList.remove('hidden'); return; }
  if (!S.me.portal) { $('#banner').textContent = 'Prévia (somente admins): o portal do agente ainda não foi liberado para os agentes.'; $('#banner').classList.remove('hidden'); }
  S.month = parseMonth() ?? localMonth();
  $('#monthInput').value = S.month;
  syncUrl(false);
  await load();
  // dia de hoje à vista
  const w = $('#tableWrap'); const t = localDate();
  if (t.startsWith(S.month)) w.scrollLeft = Math.max(0, (Number(t.slice(8)) - 3) * COL_W);
}

(async () => {
  try { await setupMockLogin($('#mockUser'), () => { S.sel = null; start(); }); await start(); }
  catch (e) { toast(e.message, true); }
})();
