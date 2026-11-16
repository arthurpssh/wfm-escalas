import {
  applyEdit, configToShifts, coverage, defaultConfig, dateOf, hhmmToMin, isLong, minToHHMM, minutesOnDay,
  shiftsToConfig, timeoffTouchesDay, timeoffMarks, localDate, validateConfig, LUNCH_MIN, TZ,
} from '/shared/rules.js';
import { icon, withIcon } from '/icons.js';
import { openGenerator } from '/generator.js';
import { $, esc, api, getJson, toast, setupMockLogin, dayLabel, fmtTs, fmtDT, TF_ACTIVE, TF_LABEL, decideTimeoff, renderNav, rememberView, fmtHM, startPresence, renderPresence } from '/common.js';

const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const COL_W = 64;
const KIND = { created: 'criado', edited: 'editado', removed: 'removido' };

const S = {
  meta: null, me: null, team: null, month: null, data: null, timeoffs: [], filter: '',
  sel: null, cfg: null, baseCfg: null, irregular: false, panelVersion: 0, tf: null,
};
let ctx;
const canEdit = () => S.data?.role === 'editor';
const itemOf = (email, day) => S.data.draft?.items.find((i) => i.email === email && i.day === day);
const tfsOf = (email) => S.timeoffs.filter((t) => t.email === email);
const activeTfsOf = (email) => tfsOf(email).filter((t) => TF_ACTIVE.has(t.status)); // pedidos pendentes e negadas não contam na cobertura
const shiftsOf = (email, day) => S.data.cells[email]?.[day] ?? [];
const sumShifts = (s) => (s?.length ? `${s[0].startTime.slice(11, 16)}–${s.at(-1).endTime.slice(11, 16)}` : '—');

// ---------- carga ----------
async function init() {
  S.meta = await getJson('/api/meta');
  ctx = { lunch: S.meta.lunch, snack: S.meta.snack, tasks: new Map(S.meta.workTasks.concat(S.meta.lunch, S.meta.snack).map((a) => [a.taskId, a])) };
  S.month = parseRoute().month ?? S.meta.defaultMonth; $('#monthInput').value = S.month;
  await setupMockLogin($('#mockUser'), () => { closePanelForce(); start(false); });
  await start(true);
  presence = startPresence({ page: 'escalas', getCtx: () => ({ team: S.team, month: S.month }), onUpdate: (l) => renderPresence(l, { chipsEl: $('#presence'), noteEl: $('#presenceNote') }) });
  setInterval(softRefresh, 15000);
  window.addEventListener('popstate', onPopState);
}

// ---------- routes: /escalas/:time/:YYYY-MM ----------
function parseRoute() {
  const m = location.pathname.match(/^\/escalas\/([^/]+)\/(\d{4}-(?:0[1-9]|1[0-2]))\/?$/);
  return m ? { team: decodeURIComponent(m[1]), month: m[2] } : {};
}
const routeUrl = () => `/escalas/${encodeURIComponent(S.team).replace(/%40/g, '@')}/${S.month}`;
function syncUrl(push) {
  rememberView(S.team, S.month);
  if (location.pathname === routeUrl()) return;
  history[push ? 'pushState' : 'replaceState'](null, '', routeUrl());
}
async function onPopState() {
  const r = parseRoute();
  if (!hasUnsaved() || confirm('Descartar alterações não salvas?')) {
    closePanelForce();
    if (r.month) S.month = r.month;
    if (r.team && S.me.teams.some((t) => t.name === r.team)) S.team = r.team;
    $('#monthInput').value = S.month; $('#teamSelect').value = S.team;
    await load();
  } else syncUrl(true);
}
async function start(useRoute) {
  try {
    S.me = await getJson('/api/me');
  } catch (e) { return toast(e.message, true); }
  renderNav('escalas', S.me);
  const wanted = useRoute ? parseRoute().team : null;
  S.team = S.me.teams.some((t) => t.name === wanted) ? wanted : S.me.defaultTeam;
  syncUrl(false);
  $('#teamSelect').innerHTML = S.me.teams.map((t) => `<option value="${esc(t.name)}" ${t.name === S.team ? 'selected' : ''}>${esc(t.name)} · ${t.role === 'editor' ? 'edição' : 'leitura'} (${t.agentCount})</option>`).join('');
  await load();
}
let presence = null; // presença: avisa na hora quando troca de time ou mês
async function load() {
  presence?.touch();
  const q = `month=${S.month}&team=${encodeURIComponent(S.team)}`;
  [S.data, S.timeoffs] = await Promise.all([getJson(`/api/schedule?${q}`), getJson(`/api/timeoffs?${q}`)]);
  renderAll();
  renderJobs();
}
function renderAll() { renderBanner(); renderDraftBar(); renderTable(); $('#genBtn').classList.toggle('hidden', !canEdit()); }
async function softRefresh() {
  if (S.tf || $('#modal').innerHTML) return;
  try {
    const q = `month=${S.month}&team=${encodeURIComponent(S.team)}`;
    [S.data, S.timeoffs] = await Promise.all([getJson(`/api/schedule?${q}`), getJson(`/api/timeoffs?${q}`)]);
    renderAll(); if (S.sel && !hasUnsaved()) { reopenSel(); }
  } catch { /* ignora falhas transitórias */ }
}

// ---------- faixas de status ----------
function renderBanner() {
  const b = $('#roleBanner');
  const show = !canEdit();
  b.classList.toggle('hidden', !show);
  if (show) b.textContent = `Você tem acesso apenas de visualização à escala de ${S.team}. Edição: o supervisor, a coordenação ou quem estiver na aba Acessos.`;
}
function renderDraftBar() {
  const bar = $('#draftBar'), d = S.data.draft;
  if (!d) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  const mine = canEdit();
  bar.innerHTML = `<span><b>Rascunho</b> · ${d.items.length} alteração(ões) · última edição de ${esc(d.updatedBy)} às ${fmtTs(d.updatedAt)}${mine ? '' : ' (somente leitura)'}</span><span class="spacer"></span>`
    + (mine ? `<button id="discardDraft">Descartar rascunho</button><button id="reviewBtn" class="primary">Revisar e confirmar</button>` : '');
  if (mine) { $('#discardDraft').onclick = discardDraft; $('#reviewBtn').onclick = openReview; }
}

// ---------- marcas de folga na grade ----------
// Uma cor para todas (amarelo); o que muda é o formato do ícone e o texto ao passar o mouse.
const TF_MARK = {
  decisao: { ic: 'inbox', txt: 'Pedido de folga aguardando decisão', one: 'aguardando decisão', many: 'aguardando decisão' },
  agendada: { ic: 'clock', txt: 'Folga agendada, ainda não enviada ao WFM', one: 'agendada', many: 'agendadas' },
  erro: { ic: 'alert', txt: 'Erro no envio da folga ao WFM', one: 'com erro de envio', many: 'com erro de envio' },
};
function tfMarksHtml(mk) {
  if (!mk) return '';
  const chips = Object.keys(TF_MARK).filter((k) => mk[k]).map((k) => {
    const list = mk[k], title = `${TF_MARK[k].txt}: ${list.map((t) => t.reasonName).join(', ')}`;
    return `<span class="tfm tfm-${k}" title="${esc(title)}">${icon(TF_MARK[k].ic, 11)}${list.length > 1 ? `<b>${list.length}</b>` : ''}</span>`;
  }).join('');
  return chips ? `<span class="marks">${chips}</span>` : '';
}
/** Contador no topo: quantas folgas (não dias) deste mês estão pendentes, agendadas ou com erro. */
function renderTfSummary(agents, marks) {
  const mine = new Set(agents.map((a) => a.email)), seen = { decisao: new Set(), agendada: new Set(), erro: new Set() };
  for (const [email, days] of marks) if (mine.has(email)) for (const m of Object.values(days)) for (const k of Object.keys(seen)) (m[k] ?? []).forEach((t) => seen[k].add(t.id));
  const parts = Object.keys(seen).filter((k) => seen[k].size).map((k) => `<span class="tfm tfm-${k}">${icon(TF_MARK[k].ic, 11)}</span> <b>${seen[k].size}</b> ${seen[k].size === 1 ? TF_MARK[k].one : TF_MARK[k].many}`);
  const el = $('#tfSummary');
  el.classList.toggle('hidden', !parts.length);
  el.innerHTML = parts.join(' · ');
  $('#tfLegend').innerHTML = Object.keys(TF_MARK).map((k) => `<span class="lg-item"><span class="tfm tfm-${k}">${icon(TF_MARK[k].ic, 11)}</span>${TF_MARK[k].txt.replace('Pedido de folga ', 'Pedido ').replace('Folga agendada, ainda não enviada ao WFM', 'Folga agendada').replace('Erro no envio da folga ao WFM', 'Erro de envio')}</span>`).join('') + '<span class="lg-item"><span class="off">folga</span>Folga aprovada (dia sem turno)</span>';
}

// ---------- tabela ----------
function renderTable() {
  const { agents, daysInMonth: n } = S.data;
  const f = S.filter.toLowerCase();
  const marks = timeoffMarks(S.timeoffs, S.month, n);
  const hasPending = (email) => Object.values(marks.get(email) ?? {}).some((m) => m.decisao || m.agendada || m.erro);
  renderTfSummary(agents, marks);
  const list = agents.filter((a) => (!f || `${a.email} ${a.name}`.toLowerCase().includes(f)) && (!S.onlyPend || hasPending(a.email)));
  const today = localDate();
  const head = Array.from({ length: n }, (_, i) => {
    const d = i + 1, dt = new Date(+S.month.slice(0, 4), +S.month.slice(5) - 1, d), we = [0, 6].includes(dt.getDay());
    return `<th class="${we ? 'weekend' : ''} ${dateOf(S.month, d) === today ? 'today' : ''}">${String(d).padStart(2, '0')}<small>${WD[dt.getDay()]}</small></th>`;
  }).join('');
  const rows = list.map((a) => {
    const tos = activeTfsOf(a.email);
    const cells = Array.from({ length: n }, (_, i) => {
      const d = i + 1, shifts = shiftsOf(a.email, d), it = itemOf(a.email, d);
      const sel = S.sel?.email === a.email && S.sel.day === d ? ' sel' : '';
      const attrs = `data-e="${esc(a.email)}" data-d="${d}"`;
      const mk = marks.get(a.email)?.[d];
      const marksHtml = tfMarksHtml(mk);
      const pub = S.data.pending?.[a.email]?.includes(d) ? `<span class="pub" title="Aguardando importação/publicação no Tymeshift">${icon('upload', 14)}</span>` : '';
      const off = mk?.aprovada ? `<span class="off" title="Folga aprovada: ${esc(mk.aprovada.map((t) => t.reasonName).join(', '))}">folga</span>` : '';
      if (!shifts.length) return `<td class="cell${sel}${it ? ' removed' : ''}" ${attrs}${it ? ' title="Remoção no rascunho"' : ''}>${marksHtml}${it ? icon('x', 18) : off}${pub}</td>`;
      const cls = { none: 'ok', partial: 'partial', full: 'full' }[coverage(shifts, dateOf(S.month, d), tos)];
      return `<td class="cell ${cls}${sel}" ${attrs} title="${esc(a.name)} — ${d}/${S.month.slice(5)}">${shifts[0].startTime.slice(11, 16)}<br>${shifts.at(-1).endTime.slice(11, 16)}${marksHtml}${it ? `<i class="dot" title="Alteração no rascunho (${KIND[it.kind]})"></i>` : ''}${pub}</td>`;
    }).join('');
    return `<tr><td class="agent"><b title="${esc(a.email)}">${esc(a.email)}</b><small>${esc(a.name)}</small></td>${cells}</tr>`;
  }).join('');
  const wrap = $('#tableWrap'), sl = wrap.scrollLeft, st = wrap.scrollTop;
  wrap.innerHTML = `<table><thead><tr><th class="agent">Agente</th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  wrap.scrollLeft = sl; wrap.scrollTop = st;
}
function pageWeek(dir) {
  const w = $('#tableWrap');
  const first = Math.round(w.scrollLeft / COL_W);
  const target = dir < 0 ? Math.max(0, first - 7) : Math.min(S.data.daysInMonth - 1, first + 7);
  w.scrollTo({ left: target * COL_W, behavior: 'smooth' });
}

// ---------- painel do dia ----------
function deriveCfg(email, day) {
  const { config, irregular } = shiftsToConfig(shiftsOf(email, day), ctx);
  S.cfg = config ? { ...config } : null; S.baseCfg = config ? { ...config } : null; S.irregular = irregular;
}
function openDay(email, day) {
  if (S.sel && hasUnsaved() && !confirm('Descartar alterações não salvas do dia atual?')) return;
  S.sel = { email, day }; S.tf = null; S.panelVersion = S.data.draft?.version ?? 0;
  deriveCfg(email, day);
  document.body.classList.add('panel-open');
  renderTable(); renderPanel();
}
function reopenSel() { const { email, day } = S.sel; S.sel = null; openDay(email, day); }
function closePanelForce() { S.sel = null; S.tf = null; S.cfg = S.baseCfg = null; document.body.classList.remove('panel-open'); $('#panel').classList.add('hidden'); }
function closePanel() {
  if (hasUnsaved() && !confirm('Descartar alterações não salvas?')) return;
  closePanelForce(); renderTable();
}
const hasUnsaved = () => S.sel && JSON.stringify(S.cfg) !== JSON.stringify(S.baseCfg);
const timeInput = (name, v, dis) => `<input type="time" step="60" data-f="${name}" value="${minToHHMM(v)}" ${dis ? 'disabled' : ''}>`;

function renderPanel() {
  const p = $('#panel'); p.classList.remove('hidden');
  const { email, day } = S.sel;
  const agent = S.data.agents.find((a) => a.email === email);
  const date = dateOf(S.month, day);
  const dayAll = tfsOf(email).filter((t) => timeoffTouchesDay(t, date));
  const dayTfs = dayAll.filter((t) => TF_ACTIVE.has(t.status));
  const cov = coverage(shiftsOf(email, day), date, dayTfs);
  const edit = canEdit();
  const locked = !edit || cov === 'full';
  const it = itemOf(email, day);
  const c = S.cfg;
  const long = c && c.entry != null && c.exit != null && isLong(c.entry, c.exit);
  const errors = c ? validateConfig(c) : [];

  let html = `<header><div><h2>${esc(agent.name)}</h2><small>${esc(email)}<br>${dayLabel(date)}</small></div><button id="closeBtn">${withIcon('x', 'Fechar')}</button></header>`;
  if (S.data.pending?.[email]?.includes(day)) html += `<div class="note">${icon('upload', 16)} Este dia está em um CSV já gerado e aguarda importação e <b>publicação</b> no Tymeshift (e a verificação do sistema).</div>`;
  if (it) html += `<div class="note draft">No rascunho: dia <b>${KIND[it.kind]}</b> (publicado: ${sumShifts(it.before)} → ${sumShifts(it.after)}) por ${esc(it.updatedBy)}.${it.kind === 'removed' ? ' Ao confirmar, um card único será aberto no Jira.' : ''}</div>`;
  if (!c) {
    html += `<p>${it?.kind === 'removed' ? 'Dia marcado para remoção.' : 'Agente não escalado neste dia.'}</p>`;
    html += `<div class="actions">${edit ? `<button id="scaleBtn" class="primary">Escalar agente</button>` : ''}${it && edit ? `<button id="revertItem">Reverter alteração do dia</button>` : ''}</div>`;
  } else {
    html += `<h3 class="sec">Escala do dia</h3>`;
    if (S.irregular) html += `<div class="note">Este dia tem atividades fora do padrão entrada/almoço/snack/saída. Ao salvar, será reescrito neste padrão.</div>`;
    if (edit && cov === 'full') html += `<div class="note">Há folga total neste dia: a escala está bloqueada para edição.</div>`;
    else if (edit && cov === 'partial') html += `<div class="note">Há folga parcial neste dia; a escala continua editável.</div>`;
    html += `<div class="row"><label>Fluxo</label><select data-f="taskId" ${locked ? 'disabled' : ''}>${['workstream', 'multitask', 'generalTask'].map((t) => `<optgroup label="${t}">${S.meta.workTasks.filter((a) => a.taskType === t).map((a) => `<option value="${a.taskId}" ${a.taskId === c.taskId ? 'selected' : ''}>${esc(a.taskName)}</option>`).join('')}</optgroup>`).join('')}</select></div>
      <div class="row"><label>Entrada</label>${timeInput('entry', c.entry, locked)}</div>
      <div class="row"><label>Almoço (início)</label>${timeInput('lunch', long ? c.lunch : null, locked || !long)}</div>
      <div class="row"><label>Snack (início)</label>${timeInput('snack', c.snack, locked)}</div>
      <div class="row"><label>Snack (duração)</label><div><input type="number" min="1" step="1" style="width:90px" data-f="snackDur" value="${c.snackDur ?? ''}" ${locked ? 'disabled' : ''}> min</div></div>
      <div class="row"><label>Saída</label>${timeInput('exit', c.exit, locked)}</div>`;
    if (errors.length) html += `<ul class="errors">${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    html += timelineHtml(c, dayTfs, date, errors.length === 0);
    if (edit) html += `<div class="actions"><button id="saveDay" class="primary" ${locked || errors.length || !hasUnsaved() ? 'disabled' : ''}>Salvar no rascunho</button>
      <button id="resetDay" ${hasUnsaved() ? '' : 'disabled'}>Descartar edição</button>
      <button id="removeDay" ${locked ? 'disabled' : ''}>Remover escala do dia</button>
      ${it ? `<button id="revertItem">Reverter alteração do dia</button>` : ''}</div>`;
  }
  html += `<h3 class="sec">Folgas</h3>`;
  if (edit) html += `<div class="actions"><button id="addTf" ${S.tf && S.tf.id == null ? 'disabled' : ''}>${withIcon('plus', 'Adicionar folga')}</button></div>`;
  if (S.tf && S.tf.id == null) html += tfFormHtml(S.tf, 'Rascunho');
  for (const t of dayAll) html += S.tf?.id === t.id ? tfFormHtml(S.tf, 'Agendada') : tfItemHtml(t, edit);
  if (!dayAll.length && !S.tf) html += `<p class="meta" style="color:var(--muted)">Nenhuma folga afeta este dia.</p>`;
  p.innerHTML = html;
  bindPanel();
}

function timelineHtml(c, tfs, date, valid) {
  if (!valid || c.entry == null || c.exit == null) return '';
  const span = c.exit - c.entry, pos = (m) => ((m - c.entry) / span) * 100;
  const seg = (a, b, cls, title) => `<div class="seg ${cls}" style="left:${pos(a)}%;width:${pos(b) - pos(a)}%" title="${esc(title)} ${minToHHMM(a)}–${minToHHMM(b)}"></div>`;
  const work = ctx.tasks.get(c.taskId)?.taskName ?? 'Fluxo';
  const parts = [];
  let cur = c.entry;
  if (c.lunch != null) { parts.push(seg(cur, c.lunch, 'work', work), seg(c.lunch, c.lunch + LUNCH_MIN, 'lunch', 'Almoço')); cur = c.lunch + LUNCH_MIN; }
  parts.push(seg(cur, c.snack, 'work', work), seg(c.snack, c.snack + c.snackDur, 'snack', 'Snack'), seg(c.snack + c.snackDur, c.exit, 'work', work));
  let ticks = '';
  for (let h = Math.ceil(c.entry / 60); h * 60 <= c.exit; h++) ticks += `<div class="tick" style="left:${pos(h * 60)}%"><span>${String(h).padStart(2, '0')}</span></div>`;
  const flags = [c.lunch != null && [c.lunch, 'almoço', 'var(--blue)'], [c.snack, 'snack', 'var(--magenta)']].filter(Boolean)
    .map(([m, l, col]) => `<div class="flag" style="left:${pos(m)}%;color:${col}">${l} ${minToHHMM(m)}</div>`).join('');
  const toSegs = tfs.map((t) => [Math.max(c.entry, minutesOnDay(t.startTime, date)), Math.min(c.exit, minutesOnDay(t.endTime, date)), t])
    .filter(([a, b]) => b > a)
    .map(([a, b, t]) => seg(a, b, t.endTime.slice(11, 19) === '23:59:59' && minutesOnDay(t.startTime, date) <= c.entry ? 'to-full' : 'to-partial', t.reasonName)).join('');
  return `<div class="timeline"><div class="ruler">${ticks}${flags}</div><div class="bar">${parts.join('')}</div>${toSegs ? `<div class="bar to">${toSegs}</div>` : ''}
    <div class="tl-legend"><span><i style="background:#FF4000"></i>${esc(work)}</span><span><i style="background:#00BFFF"></i>Almoço</span><span><i style="background:#A475FF"></i>Snack</span></div></div>`;
}

function tfItemHtml(t, edit) {
  const when = t.status === 'agendada' ? `Envio ao WFM às ${fmtHM(t.scheduledAt)} (dá tempo de cancelar)` : '';
  const btns = !edit ? '' : t.status === 'agendada'
    ? `<button class="icon-btn" data-edit="${t.id}" title="Editar" aria-label="Editar">${icon('pencil', 16)}</button><button class="icon-btn" data-del="${t.id}" title="Excluir" aria-label="Excluir">${icon('trash', 16)}</button>`
    : t.status === 'aprovada' ? `<button class="icon-btn" data-decide="deny" data-id="${t.id}" title="Nega a folga no WFM">${withIcon('ban', 'Cancelar folga', 16)}</button>`
    : t.status === 'pendente' ? `<button class="icon-btn primary" data-decide="approve" data-id="${t.id}">${withIcon('check', 'Aceitar', 16)}</button><button class="icon-btn" data-decide="deny" data-id="${t.id}">${withIcon('x', 'Recusar', 16)}</button>` : '';
  return `<div class="tf${t.status === 'negada' ? ' denied' : ''}"><div class="head"><b>${esc(t.reasonName)}</b><span class="badge tf-${t.status}">${TF_LABEL[t.status] ?? t.status}</span></div>${t.status === 'erro' && t.note ? `<div class="note" style="margin:8px 0"><b>Motivo do erro:</b> ${esc(t.note)}</div>` : ''}
    <div class="meta">${fmtDT(t.startTime)} → ${fmtDT(t.endTime)}${t.createdBy ? ` · por ${esc(t.createdBy)}` : ''}</div>${t.status === 'pendente' ? '<div class="meta">Não conta na cobertura até ser aceito.</div>' : ''}${when ? `<div class="meta">${when}</div>` : ''}
    ${btns ? `<div class="actions">${btns}</div>` : ''}</div>`;
}
function tfFormHtml(f, label) {
  return `<div class="tf"><div class="head"><b>${f.id ? 'Editar folga' : 'Nova folga'}</b><span class="badge ${f.id ? 'pending' : 'draft'}">${label.toLowerCase()}</span></div>
   <form id="tfForm"><div class="row"><label>Razão</label><select name="reasonId"><option value="">Selecione…</option>${S.meta.timeoffReasons.map((r) => `<option value="${r.taskId}" ${r.taskId === f.reasonId ? 'selected' : ''}>${esc(r.taskName)}</option>`).join('')}</select></div>
   <div class="row"><label>Duração</label><label style="color:var(--text)"><input type="checkbox" name="fullDay" ${f.fullDay ? 'checked' : ''}> Dia inteiro</label></div>
   <div class="row"><label>Início</label><input type="datetime-local" step="60" name="start" value="${f.start}" ${f.fullDay ? 'disabled' : ''}></div>
   <div class="row"><label>Fim</label><input type="datetime-local" step="60" name="end" value="${f.end}" ${f.fullDay ? 'disabled' : ''}></div>
   <div class="actions"><button type="submit" class="icon-btn primary" title="Salvar">${withIcon('check', 'Salvar', 16)}</button><button type="button" id="tfCancel" class="icon-btn" title="Cancelar">${withIcon('x', 'Cancelar', 16)}</button></div></form></div>`;
}

/** Executa uma operação no rascunho; em conflito (409) recarrega e avisa. */
async function draftOp(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) {
    toast(e.status === 409 ? 'O rascunho mudou (outra pessoa editou). Dados recarregados; refaça a alteração.' : e.message, true);
    if (e.status !== 409) return false;
  }
  await load(); if (S.sel) { reopenSel(); } return true;
}

function bindPanel() {
  const p = $('#panel');
  $('#closeBtn').onclick = closePanel;
  const { email, day } = S.sel, date = dateOf(S.month, day);
  const put = (shifts) => api('/api/draft/day', { method: 'PUT', body: { team: S.team, month: S.month, email, day, shifts, version: S.panelVersion } });
  $('#scaleBtn')?.addEventListener('click', () => { S.cfg = defaultConfig(S.meta.workTasks[0].taskId); S.baseCfg = null; S.irregular = false; renderPanel(); });
  p.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('change', () => {
    const f = el.dataset.f;
    const v = f === 'taskId' ? el.value : f === 'snackDur' ? Number(el.value) : hhmmToMin(el.value);
    if (v == null || Number.isNaN(v)) return renderPanel();
    S.cfg = applyEdit(S.cfg, f, v); renderPanel();
  }));
  $('#resetDay')?.addEventListener('click', () => { S.cfg = S.baseCfg ? { ...S.baseCfg } : null; renderPanel(); });
  $('#saveDay')?.addEventListener('click', () => draftOp(() => put(configToShifts(S.cfg, date, ctx)), 'Dia salvo no rascunho.'));
  $('#removeDay')?.addEventListener('click', () => {
    if (!confirm('Marcar a escala deste dia para remoção? Um card será aberto no Jira só quando você confirmar o rascunho.')) return;
    draftOp(() => put([]), 'Remoção adicionada ao rascunho.');
  });
  $('#revertItem')?.addEventListener('click', () => draftOp(() => api(`/api/draft/item?team=${encodeURIComponent(S.team)}&month=${S.month}&email=${encodeURIComponent(email)}&day=${day}&version=${S.panelVersion}`, { method: 'DELETE' }), 'Alteração revertida.'));

  $('#addTf')?.addEventListener('click', () => { S.tf = { id: null, reasonId: '', start: `${date}T09:00`, end: `${date}T18:00`, fullDay: false }; renderPanel(); });
  p.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => {
    const t = S.timeoffs.find((x) => x.id === b.dataset.edit);
    S.tf = { id: t.id, reasonId: t.reasonId, start: t.startTime.slice(0, 16), end: t.endTime.slice(0, 16), fullDay: t.startTime.slice(11, 16) === '00:00' && t.endTime.slice(11, 19) === '23:59:59' }; renderPanel();
  }));
  p.querySelectorAll('[data-decide]').forEach((b) => (b.onclick = async () => {
    const deny = b.dataset.decide === 'deny';
    const t = S.timeoffs.find((x) => x.id === b.dataset.id);
    const msg = !deny ? 'Aceitar este pedido de folga?' : t.status === 'aprovada' ? 'Cancelar esta folga? Ela será negada no WFM (não dá para excluir).' : 'Recusar este pedido de folga?';
    if (!confirm(msg)) return;
    try { await decideTimeoff(b.dataset.id, b.dataset.decide); toast(!deny ? 'Pedido aceito.' : t.status === 'aprovada' ? 'Folga cancelada (negada).' : 'Pedido recusado.'); } catch (e) { toast(e.message, true); }
    await load(); renderPanel();
  }));
  p.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Excluir esta folga pendente? Ela ainda não foi enviada ao WFM.')) return;
    try { await api(`/api/timeoffs/${b.dataset.del}`, { method: 'DELETE' }); toast('Folga excluída.'); } catch (e) { toast(e.message, true); }
    await load(); renderPanel();
  }));
  const form = $('#tfForm');
  if (form) {
    form.fullDay.onchange = () => {
      S.tf = { ...S.tf, reasonId: form.reasonId.value, fullDay: form.fullDay.checked };
      if (S.tf.fullDay) { S.tf.start = `${date}T00:00`; S.tf.end = `${date}T23:59`; }
      renderPanel();
    };
    $('#tfCancel').onclick = () => { S.tf = null; renderPanel(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const reasonId = form.reasonId.value, start = form.start.value || S.tf.start, end = form.end.value || S.tf.end;
      if (!reasonId) return toast('Selecione a razão.', true);
      if (start >= end) return toast('O fim deve ser depois do início.', true);
      const body = { email, reasonId, startTime: `${start}:00${TZ}`, endTime: S.tf.fullDay ? `${end.slice(0, 10)}T23:59:59${TZ}` : `${end}:00${TZ}` };
      try {
        await api(S.tf.id ? `/api/timeoffs/${S.tf.id}` : '/api/timeoffs', { method: S.tf.id ? 'PUT' : 'POST', body });
        S.tf = null; toast(`Folga salva como pendente (janela de ${S.meta.graceMinutes} min para cancelar).`);
        await load(); renderPanel();
      } catch (err) { toast(err.message, true); }
    };
  }
}

// ---------- rascunho: descartar / revisar / checkout ----------
async function discardDraft() {
  if (!confirm('Descartar TODAS as alterações do rascunho deste time e mês?')) return;
  await draftOp(() => api(`/api/draft?team=${encodeURIComponent(S.team)}&month=${S.month}&version=${S.data.draft.version}`, { method: 'DELETE' }), 'Rascunho descartado.');
}

async function openReview() {
  const rv = await getJson(`/api/draft/review?team=${encodeURIComponent(S.team)}&month=${S.month}`);
  const m = $('#modal');
  const blocked = rv.stale.length || !rv.health.ok || rv.errors.length || !rv.items.length;
  const rows = rv.items.map((i) => `<tr><td>${esc(i.agentName ?? i.email)}<br><small>${esc(i.email)}</small></td><td>${String(i.day).padStart(2, '0')}/${S.month.slice(5)}</td><td><span class="badge ${i.kind}">${KIND[i.kind]}</span></td><td>${sumShifts(i.before)}</td><td>${sumShifts(i.after)}</td><td><small>${esc(i.updatedBy)}</small></td></tr>`).join('');
  const files = rv.files.map((f, n) => `<li><b>${n + 1}. ${esc(f.name)}</b> — ${f.window.from.slice(8)}/${S.month.slice(5)} a ${f.window.to.slice(8)}/${S.month.slice(5)} (${f.days} dia(s)), ${f.agents} agente(s), ${f.rows} linha(s)${f.reemitted ? `, ${f.reemitted} dia(s) de agente reemitidos sem alteração` : ''}</li>`).join('');
  m.innerHTML = `<div class="modal-card"><h2>Revisar e confirmar · ${esc(S.team)} · ${S.month}</h2>
    <table class="review"><thead><tr><th>Agente</th><th>Dia</th><th>Tipo</th><th>Publicado</th><th>Rascunho</th><th>Por</th></tr></thead><tbody>${rows}</tbody></table>
    <ul class="sumlist">
      <li>Health check: <b>${rv.health.ok ? `${icon('check', 16)} OK` : `${icon('x', 16)} ${rv.health.violations.length} violação(ões)`}</b></li>
      <li>Arquivos CSV a gerar: <b>${rv.files.length}</b></li>
    </ul>
    ${files ? `<ol class="files">${files}</ol>` : ''}
    <div class="note">Cada arquivo traz, para os agentes alterados, <b>todos os dias da janela</b> (o import do Tymeshift substitui o intervalo inteiro). Importe na ordem e <b>publique em seguida</b>: enquanto não publicar, o publicado desses agentes fica vazio na janela.</div>
    ${rv.unexpressible.length ? `<div class="note">${rv.unexpressible.length} remoção(ões) não cabem no CSV (o agente ficaria sem nenhum turno na janela): serão enviadas num <b>card único no Jira</b> (simulado por enquanto).</div>` : ''}
    ${rv.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('')}
    ${rv.stale.length ? `<div class="note">Estes dias mudaram no WFM depois de entrarem no rascunho: ${rv.stale.map((s) => `${esc(s.email)} dia ${s.day}`).join('; ')}. Reverta-os para continuar.</div>` : ''}
    ${rv.errors.length ? `<div class="note"><b>Pré-voo reprovado:</b><br>${rv.errors.map(esc).join('<br>')}</div>` : ''}
    <div class="actions"><span class="spacer"></span>
      <button id="rvCancel">Voltar</button><button id="rvOk" class="primary" ${blocked ? 'disabled' : ''}>Confirmar e baixar ${rv.files.length > 1 ? rv.files.length + ' CSVs' : 'CSV'}</button></div></div>`;
  m.classList.remove('hidden');
  $('#rvCancel').onclick = closeModal;
  $('#rvOk').onclick = async () => {
    $('#rvOk').disabled = true;
    try {
      const r = await (await api('/api/draft/checkout', { method: 'POST', body: { team: S.team, month: S.month, version: rv.version } })).json();
      for (const [n, f] of r.files.entries()) {
        await new Promise((ok) => setTimeout(ok, n * 400)); // downloads em sequência (o navegador bloqueia rajadas)
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([f.csv], { type: 'text/csv' })), download: f.name });
        a.click(); URL.revokeObjectURL(a.href);
      }
      toast(`Checkout concluído (lote ${r.batchId}). ${r.files.length} arquivo(s) baixado(s): importe e publique no Tymeshift.${r.jira ? ` Card ${r.jira.key}${r.jira.dryRun ? ' (simulado)' : ''}${r.jira.error ? ' FALHOU: ' + r.jira.error : ''}.` : ''}`, !!r.jira?.error);
      closeModal(); closePanelForce(); await load();
    } catch (e) {
      toast(e.message + (e.violations?.length ? ` (${e.violations.length})` : ''), true);
      closeModal(); await load();
    }
  };
}
function closeModal() { const m = $('#modal'); m.innerHTML = ''; m.classList.add('hidden'); }

async function renderJobs() {
  const b = await getJson(`/api/batches?team=${encodeURIComponent(S.team)}&month=${S.month}`);
  const ST = { aguardando_verificacao: 'aguardando verificação', consolidada: 'consolidada', nao_publicada: 'importada, não publicada', divergente: 'divergente', expirada: 'expirada' };
  $('#jobs').innerHTML = b.length ? `<h3>Lotes (checkout) — ${esc(S.team)} · ${S.month} · <a href="/exportacoes/${encodeURIComponent(S.team).replace(/%40/g, '@')}">ver histórico de exportações</a></h3>` + b.map((j) => `<div>${fmtTs(j.createdAt)} · ${esc(j.createdBy)} · ${j.items} dia(s)${j.jira ? ` · Jira ${esc(j.jira.key ?? 'falhou')}${j.jira.dryRun ? ' (simulado)' : ''}` : ''}<br>${j.exports.map((e) => `&nbsp;&nbsp;↳ ${esc(e.name)}: <b>${ST[e.status] ?? e.status}</b>`).join('<br>') || '&nbsp;&nbsp;↳ sem arquivos'}</div>`).join('') : '';
}

// ---------- eventos ----------
$('#tableWrap').addEventListener('click', (e) => { const td = e.target.closest('td.cell'); if (td) openDay(td.dataset.e, +td.dataset.d); });
$('#genBtn').onclick = async () => {
  if (S.sel && hasUnsaved() && !confirm('Descartar alterações não salvas do dia atual?')) return;
  closePanelForce(); renderTable();
  try { await openGenerator({ team: S.team, month: S.month, cells: S.data.cells, ctx, getVersion: () => S.data.draft?.version ?? 0, onApplied: async () => { await load(); } }); }
  catch (e) { toast(e.message, true); }
};
$('#weekPrev').onclick = () => pageWeek(-1);
$('#weekNext').onclick = () => pageWeek(1);
$('#filter').oninput = (e) => { S.filter = e.target.value; renderTable(); };
$('#onlyPend').onchange = (e) => { S.onlyPend = e.target.checked; renderTable(); };
const guard = () => !(S.sel && hasUnsaved()) || confirm('Descartar alterações não salvas?');
$('#teamSelect').onchange = async (e) => {
  if (!guard()) { e.target.value = S.team; return; }
  closePanelForce(); S.team = e.target.value; syncUrl(true); await load();
};
async function setMonth(m) {
  if (!m) return;
  if (!guard()) { $('#monthInput').value = S.month; return; }
  closePanelForce(); S.month = m; $('#monthInput').value = m; syncUrl(true); await load();
}
const shiftMonth = (d) => { const [y, m] = S.month.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
$('#monthInput').onchange = (e) => setMonth(e.target.value);
$('#prevMonth').onclick = () => setMonth(shiftMonth(-1));
$('#nextMonth').onclick = () => setMonth(shiftMonth(1));

init().catch((e) => toast(e.message, true));
