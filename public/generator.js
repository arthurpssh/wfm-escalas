// Gerador de escala mensal: agrupa os agentes por escala padrão, permite mover/editar e aplica o mês inteiro no rascunho.
import { icon, withIcon } from '/icons.js';
import { $, esc, api, getJson, toast } from '/common.js';
import {
  applyEdit, checkDefinition, definitionSummary, exitFromInput, exitToInput, hhmmToMin, isLong, minToHHMM, parseWeekdays, planMonth, validateDefinition,
  weekdaysLabel, weekdaysToString, WD_NAMES, WD_SHORT, LUNCH_MIN, localMonth,
} from '/shared/rules.js';

const sig = (shifts) => JSON.stringify((shifts ?? []).map((s) => [s.taskId, s.startTime, s.endTime]));
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * @param {{team:string, month:string, cells:object, ctx:object, getVersion:()=>number, onApplied:()=>Promise<void>}} p
 */
export async function openGenerator({ team, month, cells, ctx, getVersion, onApplied }) {
  const data = await getJson(`/api/generator?team=${encodeURIComponent(team)}&month=${month}`);
  const scales = new Map(data.scales.map((s) => [s.id, s]));
  const G = {
    taskId: data.taskId,
    agents: new Map(data.agents.map((a) => [a.email, { email: a.email, name: a.name, scaleId: a.scaleId ?? null, def: clone(a.def) }])),
    sel: new Set(),
    out: new Set(), // agentes fora desta aplicação (não é lembrado na próxima abertura)
  };
  const snapshot = () => JSON.stringify([G.taskId, [...G.agents.values()].map((a) => [a.email, a.scaleId, a.scaleId ? null : a.def])]);
  const initial = snapshot();
  const agentSig = (a) => JSON.stringify([a.scaleId, a.scaleId ? null : a.def]);
  const initialSigs = new Map([...G.agents.values()].map((a) => [a.email, agentSig(a)]));
  const initialTask = G.taskId;
  const root = $('#modal');
  const sub = $('#modal2');

  const defOf = (a) => (a.scaleId ? scales.get(a.scaleId) : a.def);
  const taskName = (id) => data.tasks.find((t) => t.taskId === id)?.taskName ?? '';
  const timesText = (d) => `Entrada ${minToHHMM(d.entry)} · ${d.lunch != null && isLong(d.entry, d.exit) ? `Almoço ${minToHHMM(d.lunch)} · ` : ''}Snack ${minToHHMM(d.snack)} (${d.snackDur} min) · Saída ${minToHHMM(d.exit)}`;

  /** O que o gerador produziria difere do que está na escala hoje? */
  const included = () => [...G.agents.values()].filter((a) => !G.out.has(a.email));
  const daysWith = (email) => Object.values(cells[email] ?? {}).filter((s) => s?.length).length; // dias que o agente já tem turno neste mês
  function planDiffers() {
    for (const a of included()) {
      const plan = planMonth(defOf(a), month, G.taskId, ctx);
      const days = new Set([...Object.keys(plan), ...Object.keys(cells[a.email] ?? {})]);
      for (const d of days) if (sig(plan[d]) !== sig(cells[a.email]?.[d])) return true;
    }
    return false;
  }
  const hasChanges = () => included().length > 0 && (G.taskId !== initialTask || included().some((a) => agentSig(a) !== initialSigs.get(a.email)) || planDiffers());
  const invalid = () => included().filter((a) => validateDefinition(defOf(a)).length);

  function groups() {
    const by = new Map();
    for (const a of included()) { const k = a.scaleId ?? 'custom'; if (!by.has(k)) by.set(k, []); by.get(k).push(a); }
    const std = [...by.entries()].filter(([k]) => k !== 'custom').sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
    return [['custom', by.get('custom') ?? []], ...std]; // personalizada sempre primeiro; as demais por nº de agentes (decrescente)
  }

  const chips = (weekdays) => { const on = parseWeekdays(weekdays); return `<span class="wds" title="${esc(weekdaysLabel(weekdays))}">${WD_SHORT.map((l, i) => `<i class="wd${on.has(i + 1) ? ' on' : ''}">${l}</i>`).join('')}</span>`; };

  function render() {
    const gs = groups();
    const total = G.agents.size, inc = included().length, outN = total - inc;
    const bad = invalid();
    const jaTem = included().filter((a) => daysWith(a.email) > 0).length;
    const nPast = month < localMonth(Date.now() - 30 * 864e5);
    root.innerHTML = `<div class="modal-card gen">
      <header class="gen-head"><h2>Gerar escala do mês · ${esc(team)} · ${month}</h2>
        <div class="actions" style="margin:0"><button id="gApply" class="primary" ${hasChanges() && !bad.length ? '' : 'disabled'} title="Aplica o mês inteiro dos agentes incluídos no rascunho">${withIcon('check', outN ? `Aplicar a ${inc} de ${total}` : 'Aplicar', 16)}</button><button id="gClose">${withIcon('x', 'Fechar', 16)}</button></div></header>
      <div class="gen-bar">
        <label class="gen-field">Workstream ou multitask padrão
          <select id="gTask">${['workstream', 'multitask'].map((t) => `<optgroup label="${t}">${data.tasks.filter((x) => x.taskType === t).map((x) => `<option value="${x.taskId}" ${x.taskId === G.taskId ? 'selected' : ''}>${esc(x.taskName)}${x.taskId === data.defaultTaskId ? ' (padrão da equipe)' : ''}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <label class="gen-check"><input type="checkbox" id="gAll"> Selecionar todos</label>
        <button id="gMoveSel" ${G.sel.size ? '' : 'disabled'}>Mover selecionados${G.sel.size ? ` (${G.sel.size})` : ''}</button>
        <button id="gOut" ${G.sel.size ? '' : 'disabled'} title="Tira os agentes selecionados desta aplicação: a escala deles não será alterada">Tirar da aplicação${G.sel.size ? ` (${G.sel.size})` : ''}</button>
        <button id="gOutHas" ${jaTem ? '' : 'disabled'} title="Tira da aplicação quem já tem turnos neste mês">Tirar quem já tem escala${jaTem ? ` (${jaTem})` : ''}</button>
        <span class="hint">${outN ? `<b>${inc} de ${total}</b> agente(s) nesta aplicação` : `${total} agente(s)`}. Aplicar substitui o mês inteiro dos agentes incluídos no rascunho; os de fora não são alterados.</span>
      </div>
      ${bad.length ? `<div class="note">Definição inválida para: ${bad.map((a) => esc(a.name)).join(', ')}. Edite ou mova para uma escala padrão.</div>` : ''}
      ${nPast ? '<div class="note">Este mês tem mais de 30 dias: o import do Tymeshift não aceita datas tão antigas, e o checkout vai barrar o arquivo.</div>' : ''}
      <div id="gGroups">${gs.map(([k, list]) => groupHtml(k, list)).join('')}</div>${outHtml()}</div>`;
    root.classList.remove('hidden');
    bind(); syncChecks();
  }

  function groupHtml(k, list) {
    const custom = k === 'custom';
    const sc = custom ? null : scales.get(k);
    const title = custom ? 'Personalizada (sem escala padrão)' : `Escala ${k}`;
    return `<section class="gen-group" data-g="${k}">
      <header><label class="gen-check"><input type="checkbox" data-gsel="${k}" ${list.length ? '' : 'disabled'}> <b>${title}</b></label>
        <span class="badge draft">${list.length} agente${list.length === 1 ? '' : 's'}</span>
        <span class="gen-def">${custom ? 'Cada agente tem os seus dias e horários.' : `${chips(sc.weekdays)} ${esc(timesText(sc))}`}</span></header>
      ${list.length ? list.map((a) => agentHtml(a, custom)).join('') : '<div class="gen-empty">Nenhum agente nesta escala.</div>'}</section>`;
  }

  function agentHtml(a, custom) {
    const d = defOf(a), { erros: errs, avisos: warns } = checkDefinition(d);
    return `<div class="gen-agent${errs.length ? ' bad' : ''}">
      <input type="checkbox" data-asel="${esc(a.email)}" ${G.sel.has(a.email) ? 'checked' : ''} aria-label="Selecionar ${esc(a.name)}">
      <div class="who"><b>${esc(a.name)}</b><small>${esc(a.email)}</small></div>
      ${chips(d.weekdays)}
      <div class="times">${errs.length ? `<span class="err-text">${esc(errs[0])}</span>` : esc(timesText(d))}${!errs.length && warns.length ? ` <span class="warn-text" title="${esc(warns.join(' · '))}">${warns.length} aviso(s)</span>` : ''}${daysWith(a.email) ? ` <span class="gen-has" title="Já tem turnos neste mês (inclui o rascunho): aplicar substitui o mês inteiro">${daysWith(a.email)} dia(s) com escala</span>` : ''}</div>
      <div class="acts">${custom ? `<button class="icon-btn" data-edit="${esc(a.email)}">${withIcon('pencil', 'Editar', 16)}</button>` : ''}<button class="icon-btn" data-move="${esc(a.email)}">Mover</button></div></div>`;
  }

  /** Seção recolhida com quem ficou de fora desta aplicação (não será alterado). */
  function outHtml() {
    const out = [...G.agents.values()].filter((a) => G.out.has(a.email));
    if (!out.length) return '';
    return `<details class="gen-out"><summary><b>Fora desta aplicação (${out.length})</b> <small>a escala deles não será alterada</small></summary>
      ${out.map((a) => `<div class="gen-agent out"><div class="who"><b>${esc(a.name)}</b><small>${esc(a.email)}</small></div><div class="times">${daysWith(a.email) ? `${daysWith(a.email)} dia(s) com escala neste mês` : 'sem escala neste mês'}</div><div class="acts"><button class="icon-btn" data-back="${esc(a.email)}">Voltar</button></div></div>`).join('')}
      <div class="actions" style="justify-content:flex-end"><button id="gBackAll">Voltar todos</button></div></details>`;
  }

  function syncChecks() {
    const all = $('#gAll'); const n = included().length;
    all.checked = G.sel.size === n && n > 0; all.indeterminate = G.sel.size > 0 && G.sel.size < n;
    root.querySelectorAll('[data-gsel]').forEach((c) => {
      const list = included().filter((a) => (a.scaleId ?? 'custom') === c.dataset.gsel);
      const k = list.filter((a) => G.sel.has(a.email)).length;
      c.checked = k > 0 && k === list.length; c.indeterminate = k > 0 && k < list.length;
    });
    $('#gMoveSel').disabled = !G.sel.size;
    $('#gMoveSel').textContent = `Mover selecionados${G.sel.size ? ` (${G.sel.size})` : ''}`;
    $('#gOut').disabled = !G.sel.size;
    $('#gOut').textContent = `Tirar da aplicação${G.sel.size ? ` (${G.sel.size})` : ''}`;
  }

  function bind() {
    $('#gClose').onclick = () => { if (snapshot() === initial || confirm('Descartar as alterações do gerador?')) close(); };
    $('#gTask').onchange = (e) => { G.taskId = e.target.value; render(); };
    $('#gAll').onchange = (e) => { G.sel = e.target.checked ? new Set(included().map((a) => a.email)) : new Set(); render(); };
    root.querySelectorAll('[data-gsel]').forEach((c) => (c.onchange = () => {
      for (const a of included()) if ((a.scaleId ?? 'custom') === c.dataset.gsel) c.checked ? G.sel.add(a.email) : G.sel.delete(a.email);
      render();
    }));
    root.querySelectorAll('[data-asel]').forEach((c) => (c.onchange = () => { c.checked ? G.sel.add(c.dataset.asel) : G.sel.delete(c.dataset.asel); render(); }));
    root.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => openMove([b.dataset.move])));
    root.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEdit(b.dataset.edit)));
    $('#gMoveSel').onclick = () => openMove([...G.sel]);
    $('#gOut').onclick = () => { for (const e of G.sel) G.out.add(e); G.sel = new Set(); render(); };
    $('#gOutHas').onclick = () => { for (const a of included()) if (daysWith(a.email) > 0) { G.out.add(a.email); G.sel.delete(a.email); } render(); };
    root.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => { G.out.delete(b.dataset.back); render(); }));
    const backAll = $('#gBackAll'); if (backAll) backAll.onclick = () => { G.out.clear(); render(); };
    $('#gApply').onclick = apply;
  }

  function close() { sub.innerHTML = ''; sub.classList.add('hidden'); root.innerHTML = ''; root.classList.add('hidden'); }
  const closeSub = () => { sub.innerHTML = ''; sub.classList.add('hidden'); };

  // ---------- mover ----------
  function openMove(emails) {
    let dest = 'custom';
    const names = emails.map((e) => G.agents.get(e).name);
    const draw = () => {
      sub.innerHTML = `<div class="modal-card small"><h2>Mover ${emails.length > 1 ? `${emails.length} agentes` : esc(names[0])}</h2>
        <p class="hint" style="margin:0 0 12px">Escolha a escala de destino.</p>
        <label class="gen-opt"><input type="radio" name="dest" value="custom" ${dest === 'custom' ? 'checked' : ''}><div><b>Personalizada</b><small>Mantém os dias e horários atuais como ponto de partida; depois você pode editar cada agente.</small></div></label>
        ${data.scales.map((s) => `<label class="gen-opt"><input type="radio" name="dest" value="${s.id}" ${dest === s.id ? 'checked' : ''}><div><b>Escala ${s.id}</b> ${chips(s.weekdays)}<small>${esc(timesText(s))}</small></div></label>`).join('')}
        <div class="actions" style="justify-content:flex-end"><button id="mvCancel">Cancelar</button><button id="mvOk" class="primary">Mover</button></div></div>`;
      sub.classList.remove('hidden');
      sub.querySelectorAll('[name=dest]').forEach((r) => (r.onchange = () => { dest = r.value; }));
      $('#mvCancel').onclick = closeSub;
      $('#mvOk').onclick = () => {
        for (const e of emails) {
          const a = G.agents.get(e);
          if (dest === 'custom') { a.def = clone(defOf(a)); a.scaleId = null; } // preserva os valores atuais
          else { a.scaleId = dest; a.def = clone(scales.get(dest)); }
          G.sel.delete(e);
        }
        closeSub(); render();
      };
    };
    draw();
  }

  // ---------- editar (personalizada) ----------
  function openEdit(email) {
    const a = G.agents.get(email);
    const w = new Set(parseWeekdays(a.def.weekdays));
    let c = { entry: a.def.entry, lunch: a.def.lunch, snack: a.def.snack, snackDur: a.def.snackDur, exit: a.def.exit };
    const cur = () => ({ weekdays: weekdaysToString(w), ...c });
    const t = (f, v, dis) => `<input type="time" step="60" data-f="${f}" value="${minToHHMM(f === 'exit' ? exitToInput(v) : v)}" ${dis ? 'disabled' : ''}>`;
    const draw = () => {
      const long = isLong(c.entry ?? 0, c.exit ?? 0);
      const { erros: errs, avisos: warns } = checkDefinition(cur());
      sub.innerHTML = `<div class="modal-card small"><h2>Editar escala · ${esc(a.name)}</h2>
        <div class="row"><label>Dias da semana</label><div class="wd-edit">${WD_NAMES.map((n, i) => `<label class="gen-check"><input type="checkbox" data-wd="${i + 1}" ${w.has(i + 1) ? 'checked' : ''}> ${n}</label>`).join('')}</div></div>
        <div class="row"><label>Entrada</label>${t('entry', c.entry)}</div>
        <div class="row"><label>Almoço (início)</label>${t('lunch', long ? c.lunch : null, !long)}</div>
        <div class="row"><label>Snack (início)</label>${t('snack', c.snack)}</div>
        <div class="row"><label>Snack (duração)</label><div><input type="number" min="1" step="1" data-f="snackDur" value="${c.snackDur ?? ''}" style="width:90px"> min</div></div>
        <div class="row"><label>Saída</label><div>${t('exit', c.exit)}${c.exit >= 1440 ? ' <small>24:00 (meia-noite do dia seguinte)</small>' : ''}</div></div>
        ${errs.length ? `<ul class="errors">${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}${warns.length ? `<ul class="warns">${warns.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        <div class="actions" style="justify-content:flex-end"><button id="edCancel">Cancelar</button><button id="edOk" class="primary" ${errs.length ? 'disabled' : ''}>${withIcon('check', 'Salvar', 16)}</button></div></div>`;
      sub.classList.remove('hidden');
      sub.querySelectorAll('[data-wd]').forEach((x) => (x.onchange = () => { x.checked ? w.add(+x.dataset.wd) : w.delete(+x.dataset.wd); draw(); }));
      sub.querySelectorAll('[data-f]').forEach((x) => (x.onchange = () => {
        const f = x.dataset.f, v = f === 'snackDur' ? Number(x.value) : f === 'exit' ? exitFromInput(hhmmToMin(x.value)) : hhmmToMin(x.value);
        if (v == null || Number.isNaN(v)) return draw();
        c = applyEdit({ taskId: 'x', ...c }, f, v); // mesmas regras do dia: 9h, proporcionalidade, snack 15/45
        c = { entry: c.entry, lunch: c.lunch, snack: c.snack, snackDur: c.snackDur, exit: c.exit };
        draw();
      }));
      $('#edCancel').onclick = closeSub;
      $('#edOk').onclick = () => { a.def = cur(); closeSub(); render(); };
    };
    draw();
  }

  // ---------- aplicar ----------
  async function apply() {
    const n = included().length, outN = G.agents.size - n;
    if (!confirm(`Aplicar a escala de ${month} para ${n} agente(s) no rascunho?${outN ? `\n\n${outN} agente(s) ficam de fora e NÃO serão alterados.` : ''}\n\nO mês inteiro dos agentes incluídos é substituído e as alterações anteriores deles no rascunho são descartadas.`)) return;
    $('#gApply').disabled = true;
    try {
      const r = await (await api('/api/draft/generate', { method: 'POST', body: {
        team, month, version: getVersion(), taskId: G.taskId,
        agents: included().map((a) => ({ email: a.email, scaleId: a.scaleId, def: defOf(a) })),
      } })).json();
      toast(`Escala gerada no rascunho: ${r.agents} agente(s), ${r.items} dia(s) alterado(s). Revise e confirme para exportar.`);
      close(); await onApplied();
    } catch (e) {
      toast(e.status === 409 ? 'O rascunho mudou (outra pessoa editou). Recarregue e tente de novo.' : e.message + (e.violations?.length ? ` — ${e.violations[0]}` : ''), true);
      $('#gApply').disabled = false;
    }
  }

  render();
}
