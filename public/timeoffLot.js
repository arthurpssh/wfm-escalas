// Modal "Adicionar folga" em lote: uma razão e um período para vários agentes (uma folga por agente, ligadas por um loteId).
// A prévia (/api/timeoff-lots/preview) diz, por agente, se tem escala no período, se a escala padrão cai nele e quais folgas já se sobrepõem.
import { icon, withIcon } from '/icons.js';
import { esc, api, getJson, toast } from '/common.js';
import { TZ } from '/shared/rules.js';

/**
 * @param {object} p
 * @param {string} p.team  @param {string} p.month  @param {Array} p.agents [{ email, name }]  @param {Array} p.reasons [{ taskId, taskName }]
 * @param {number} p.graceMinutes carência (minutos) antes do envio ao WFM
 * @param {object} [p.prefill] { reasonId, fullDay, from, to, title, preselect: 'suggested' }  (from/to = 'YYYY-MM-DD')
 * @param {Function} [p.onDone] chamado depois de criar o lote
 */
export function openTimeoffLot({ team, month, agents, reasons, graceMinutes = 2, prefill = {}, onDone }) {
  const root = document.getElementById('modal');
  const first = prefill.from ?? `${month}-01`;
  const st = {
    reasonId: prefill.reasonId ?? '', fullDay: prefill.fullDay ?? true, from: first, to: prefill.to ?? first,
    start: `${first}T09:00`, end: `${prefill.to ?? first}T18:00`, q: '', sel: new Set(), info: new Map(), busy: false, preselect: prefill.preselect === 'suggested',
  };
  let seq = 0, timer = null;

  const period = () => st.fullDay
    ? { startTime: `${st.from}T00:00:00${TZ}`, endTime: `${st.to}T23:59:59${TZ}`, ok: !!st.from && !!st.to && st.from <= st.to }
    : { startTime: `${st.start}:00${TZ}`, endTime: `${st.end}:00${TZ}`, ok: !!st.start && !!st.end && st.start < st.end };
  const suggested = (a) => { const i = st.info.get(a.email); return !!i && i.conflicts.length === 0 && (i.stdWorks === true || (i.stdWorks === null && i.hasShift)); };
  const visible = () => agents.filter((a) => !st.q || `${a.name} ${a.email}`.toLowerCase().includes(st.q.toLowerCase()));

  async function refresh() {
    const p = period(), mine = ++seq;
    if (!p.ok) { st.info = new Map(); renderList(); return; }
    try {
      const r = await (await api('/api/timeoff-lots/preview', { method: 'POST', body: { team, startTime: p.startTime, endTime: p.endTime } })).json();
      if (mine !== seq) return; // chegou uma resposta mais nova
      st.info = new Map(r.agents.map((a) => [a.email, a]));
      if (st.preselect) { st.preselect = false; st.sel = new Set(agents.filter(suggested).map((a) => a.email)); }
    } catch (e) { if (mine === seq) { st.info = new Map(); toast(e.message, true); } }
    renderList();
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };

  function tags(a) {
    const i = st.info.get(a.email);
    if (!i) return '';
    const out = [];
    if (!i.hasShift) out.push('<span class="tag">sem escala no período</span>');
    if (i.stdWorks === false) out.push('<span class="tag">escala padrão não inclui</span>');
    if (i.conflicts.length) out.push(`<span class="tag warn" title="${esc(i.conflicts.map((c) => `${c.reasonName} (${c.status})`).join('; '))}">já tem folga: ${esc(i.conflicts[0].reasonName)}${i.conflicts.length > 1 ? ` +${i.conflicts.length - 1}` : ''}</span>`);
    return out.join('');
  }

  function renderList() {
    const el = root.querySelector('#lList'); if (!el) return;
    const list = visible();
    el.innerHTML = list.length ? list.map((a) => `<label class="lot-agent"><input type="checkbox" data-e="${esc(a.email)}" ${st.sel.has(a.email) ? 'checked' : ''}>
      <span class="who"><b>${esc(a.name)}</b><small>${esc(a.email)}</small></span><span class="tags">${tags(a)}</span></label>`).join('') : '<div class="gen-empty">Nenhum agente encontrado.</div>';
    el.querySelectorAll('[data-e]').forEach((c) => (c.onchange = () => { c.checked ? st.sel.add(c.dataset.e) : st.sel.delete(c.dataset.e); renderFoot(); }));
    renderFoot();
  }

  function renderFoot() {
    const n = st.sel.size, conflicted = [...st.sel].filter((e) => st.info.get(e)?.conflicts.length).length;
    const noShift = [...st.sel].filter((e) => st.info.has(e) && !st.info.get(e).hasShift).length;
    root.querySelector('#lCount').textContent = `${n} de ${agents.length} selecionado(s)`;
    root.querySelector('#lWarn').innerHTML = [
      conflicted ? `<div class="note">${conflicted} selecionado(s) já têm folga que se sobrepõe a este período: a nova será criada por cima (o WFM mantém as duas).</div>` : '',
      noShift ? `<div class="note">${noShift} selecionado(s) não têm escala no período.</div>` : '',
    ].join('');
    const ok = root.querySelector('#lOk');
    ok.disabled = st.busy || !n || !st.reasonId || !period().ok;
    ok.innerHTML = withIcon('check', n ? `Criar ${n} folga${n > 1 ? 's' : ''}` : 'Criar folgas', 16);
  }

  function draw() {
    const p = prefill.title ? `<p class="hint" style="margin:-8px 0 12px">${esc(prefill.title)}</p>` : '';
    root.innerHTML = `<div class="modal-card lot"><h2>Adicionar folga em lote · ${esc(team)}</h2>${p}
      <div class="row"><label>Razão</label><select id="lReason"><option value="">Selecione…</option>${reasons.map((r) => `<option value="${esc(r.taskId)}" ${r.taskId === st.reasonId ? 'selected' : ''}>${esc(r.taskName)}</option>`).join('')}</select></div>
      <div class="row"><label>Duração</label><label style="color:var(--text)"><input type="checkbox" id="lFull" ${st.fullDay ? 'checked' : ''}> Dia inteiro</label></div>
      ${st.fullDay
        ? `<div class="row"><label>Dias</label><div class="lot-dates"><input type="date" id="lFrom" value="${st.from}"> <span>até</span> <input type="date" id="lTo" value="${st.to}"></div></div>`
        : `<div class="row"><label>Início</label><input type="datetime-local" step="60" id="lStart" value="${st.start}"></div><div class="row"><label>Fim</label><input type="datetime-local" step="60" id="lEnd" value="${st.end}"></div>`}
      <h3 class="sec">Agentes</h3>
      <div class="lot-tools"><input type="search" id="lQ" placeholder="Buscar agente…" value="${esc(st.q)}">
        <button type="button" id="lSug" title="Sem folga no período e com escala (a escala padrão manda quando existe)">Sugeridos</button>
        <button type="button" id="lAll">Marcar visíveis</button><button type="button" id="lNone">Limpar</button><span id="lCount" class="hint"></span></div>
      <div id="lList" class="lot-list"></div>
      <div id="lWarn"></div>
      <div class="note">Cada agente recebe uma folga própria. Elas ficam <b>agendadas por ${graceMinutes} min</b> (dá para cancelar o lote) e só depois seguem para o WFM, em ordem; um lote grande pode levar alguns ciclos de envio.</div>
      <div class="actions"><span class="spacer"></span><button type="button" id="lCancel">Cancelar</button><button type="button" id="lOk" class="primary"></button></div></div>`;
    root.classList.remove('hidden');
    const $ = (s) => root.querySelector(s);
    $('#lReason').onchange = (e) => { st.reasonId = e.target.value; renderFoot(); };
    $('#lFull').onchange = (e) => { st.fullDay = e.target.checked; draw(); refresh(); };
    for (const [id, key] of [['#lFrom', 'from'], ['#lTo', 'to'], ['#lStart', 'start'], ['#lEnd', 'end']]) {
      const el = $(id); if (el) el.onchange = () => { st[key] = el.value; if (key === 'from' && st.to < st.from) { st.to = st.from; const t = $('#lTo'); if (t) t.value = st.to; } renderFoot(); later(); };
    }
    $('#lQ').oninput = (e) => { st.q = e.target.value; renderList(); };
    $('#lSug').onclick = () => { st.sel = new Set(agents.filter(suggested).map((a) => a.email)); renderList(); };
    $('#lAll').onclick = () => { visible().forEach((a) => st.sel.add(a.email)); renderList(); };
    $('#lNone').onclick = () => { st.sel.clear(); renderList(); };
    $('#lCancel').onclick = close;
    $('#lOk').onclick = submit;
    renderList();
  }

  function close() { clearTimeout(timer); seq++; root.classList.add('hidden'); root.innerHTML = ''; }

  async function submit() {
    const p = period();
    if (!p.ok || !st.reasonId || !st.sel.size) return;
    st.busy = true; renderFoot();
    try {
      const r = await (await api('/api/timeoff-lots', { method: 'POST', body: { team, reasonId: st.reasonId, startTime: p.startTime, endTime: p.endTime, emails: [...st.sel] } })).json();
      close();
      toast(`${r.count} folga(s) agendada(s). Dá para cancelar o lote por ${graceMinutes} min.`);
      await onDone?.(r);
    } catch (e) { st.busy = false; renderFoot(); toast(e.message, true); }
  }

  draw();
  refresh();
}
