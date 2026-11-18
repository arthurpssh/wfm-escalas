// Modal "configurar vários dias" de um agente: a mesma configuração do dia (fluxo, entrada, almoço, snack, saída) aplicada em vários dias
// do mês de uma vez, escolhidos no calendário, por intervalo e/ou por dia da semana. O resultado entra no rascunho (nada vai ao WFM até confirmar).
import { withIcon } from '/icons.js';
import { $, esc } from '/common.js';
import {
  addDaysIso, applyEdit, checkConfig, configToShifts, dateOf, defaultConfig, exitFromInput, exitToInput, hhmmToMin, minToHHMM, pickDays, shiftsToConfig,
} from '/shared/rules.js';

const WD = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']; // dom..sáb (dígitos 1..7)
const WD_NAME = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const hm = (iso) => iso.slice(11, 16);

/**
 * @param {object} p
 * @param {object} p.agent { email, name }   @param {string} p.month 'YYYY-MM'   @param {number} p.n dias do mês   @param {string} p.today 'YYYY-MM-DD'
 * @param {Function} p.shiftsOf (dia) => Shift[] (escala efetiva, com o rascunho)   @param {Function} p.coverageOf (dia) => 'none'|'partial'|'full'
 * @param {Array} p.workTasks fluxos escolhíveis   @param {object} p.ctx contexto de atividades (almoço, snack, tarefas)
 * @param {Function} p.onApply async ([{ day, shifts }]) => void   @param {Function} p.onRemove async ([dia]) => void (remove a escala desses dias)
 * @param {Function} [p.onClose]
 */
export function openAgentRange({ agent, month, n, today, shiftsOf, coverageOf, workTasks, ctx, onApply, onRemove, onClose }) {
  const root = $('#modal');
  const minDate = addDaysIso(today, -30); // o import do WFM só aceita até 30 dias no passado
  const date = (d) => dateOf(month, d);
  const hasShift = (d) => shiftsOf(d).length > 0;
  const locked = (d) => coverageOf(d) === 'full' || date(d) < minDate; // folga total bloqueia a edição do dia, como no painel do dia
  const withShifts = Array.from({ length: n }, (_, i) => i + 1).filter(hasShift);

  const startCfg = (d) => {
    const { config } = d ? shiftsToConfig(shiftsOf(d), ctx) : { config: null };
    return config ? { ...config } : defaultConfig(workTasks[0].taskId);
  };
  const st = { cfg: startCfg(withShifts[0]), from: 1, to: n, wd: new Set(), includeEmpty: false, sel: new Set(), copyFrom: withShifts[0] ? String(withShifts[0]) : '', busy: false };

  const close = () => { root.classList.add('hidden'); root.innerHTML = ''; onClose?.(); };
  const timeInput = (f, v, dis) => `<input type="time" step="60" data-f="${f}" value="${minToHHMM(f === 'exit' ? exitToInput(v) : v)}" ${dis ? 'disabled' : ''}>`;

  function dayButton(d) {
    const sh = shiftsOf(d), cov = coverageOf(d), lk = locked(d), sel = st.sel.has(d);
    const label = cov === 'full' ? 'folga' : sh.length ? `${hm(sh[0].startTime)}<br>${hm(sh.at(-1).endTime)}` : '—';
    const why = cov === 'full' ? 'Folga total neste dia: a escala está bloqueada' : date(d) < minDate ? 'Fora da janela de importação do WFM (até 30 dias no passado)' : sh.length ? 'Já tem escala' : 'Sem escala (será escalado se você marcar)';
    return `<button type="button" class="rg-day${sh.length ? ' has' : ''}${sel ? ' sel' : ''}" data-d="${d}" ${lk ? 'disabled' : ''} title="${why}"><b>${d}</b><small>${label}</small></button>`;
  }

  function draw() {
    const { cfg } = st;
    const { erros, avisos } = checkConfig(cfg);
    const long = cfg.entry != null && cfg.exit != null && cfg.exit - cfg.entry >= 540;
    const first = new Date(+month.slice(0, 4), +month.slice(5) - 1, 1).getDay();
    const cal = `${WD_NAME.map((nm, i) => `<div class="rg-h" title="${nm}">${WD[i]}</div>`).join('')}${'<div></div>'.repeat(first)}${Array.from({ length: n }, (_, i) => dayButton(i + 1)).join('')}`;
    const sel = [...st.sel], novos = sel.filter((d) => !hasShift(d)).length, rem = sel.length - novos; // rem = dias selecionados que têm escala (podem ser removidos)
    const ok = !st.busy && !erros.length && sel.length > 0;
    root.innerHTML = `<div class="modal-card range"><h2>Configurar vários dias · ${esc(agent.name)}</h2>
      <p class="hint" style="margin:-8px 0 12px">${esc(agent.email)} · ${month}. A mesma configuração vai para todos os dias escolhidos e entra no <b>rascunho</b>.</p>
      <div class="rg-cols">
        <div class="rg-cfg">
          <h3 class="sec" style="margin-top:0">Escala</h3>
          ${withShifts.length ? `<div class="row"><label>Partir do dia</label><select id="rgCopy"><option value="">escala padrão do app</option>${withShifts.map((d) => `<option value="${d}" ${String(d) === st.copyFrom ? 'selected' : ''}>dia ${d} · ${hm(shiftsOf(d)[0].startTime)}–${hm(shiftsOf(d).at(-1).endTime)}</option>`).join('')}</select></div>` : ''}
          <div class="row"><label>Fluxo</label><select data-f="taskId">${['workstream', 'multitask', 'generalTask'].map((t) => `<optgroup label="${t}">${workTasks.filter((a) => a.taskType === t).map((a) => `<option value="${esc(a.taskId)}" ${a.taskId === cfg.taskId ? 'selected' : ''}>${esc(a.taskName)}</option>`).join('')}</optgroup>`).join('')}</select></div>
          <div class="row"><label>Entrada</label>${timeInput('entry', cfg.entry)}</div>
          <div class="row"><label>Almoço (início)</label>${timeInput('lunch', long ? cfg.lunch : null, !long)}</div>
          <div class="row"><label>Snack (início)</label>${timeInput('snack', cfg.snack)}</div>
          <div class="row"><label>Snack (duração)</label><div><input type="number" min="1" step="1" style="width:90px" data-f="snackDur" value="${cfg.snackDur ?? ''}"> min</div></div>
          <div class="row"><label>Saída</label><div>${timeInput('exit', cfg.exit)}${cfg.exit >= 1440 ? ' <small>24:00 (meia-noite do dia seguinte)</small>' : ''}</div></div>
          ${erros.length ? `<ul class="errors">${erros.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}${avisos.length ? `<ul class="warns">${avisos.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="rg-days">
          <h3 class="sec" style="margin-top:0">Dias</h3>
          <div class="rg-cal">${cal}</div>
          <div class="rg-tools">
            <span>Dia</span><input type="number" id="rgFrom" min="1" max="${n}" value="${st.from}" style="width:64px"><span>até</span><input type="number" id="rgTo" min="1" max="${n}" value="${st.to}" style="width:64px">
            <span class="rg-wd">${WD.map((w, i) => `<label title="${WD_NAME[i]}"><input type="checkbox" data-wd="${i + 1}" ${st.wd.has(i + 1) ? 'checked' : ''}>${w}</label>`).join('')}</span>
            <label class="chk"><input type="checkbox" id="rgEmpty" ${st.includeEmpty ? 'checked' : ''}> incluir dias sem escala</label>
          </div>
          <div class="rg-tools"><button type="button" id="rgRange">Selecionar intervalo</button><button type="button" id="rgAll">Todos com escala</button><button type="button" id="rgNone">Limpar</button></div>
          <p class="hint" style="margin:8px 0 0">${sel.length ? `<b>${sel.length}</b> dia(s) escolhido(s): ${sel.length - novos} já com escala${novos ? ` e <b>${novos} sem escala (o agente será escalado)</b>` : ''}.` : 'Clique nos dias, ou use o intervalo e os dias da semana. Sem marcar a opção "incluir dias sem escala", o intervalo só pega dias que já têm escala.'}</p>
        </div>
      </div>
      <div class="actions"><button type="button" id="rgRemove" ${!st.busy && rem ? '' : 'disabled'} title="Marca para remoção a escala dos dias escolhidos que têm escala (dias sem escala são ignorados)">${withIcon('trash', rem ? `Remover a escala de ${rem} dia${rem > 1 ? 's' : ''}` : 'Remover a escala dos dias', 16)}</button><span class="spacer"></span><button type="button" id="rgCancel">Cancelar</button><button type="button" id="rgOk" class="primary" ${ok ? '' : 'disabled'}>${withIcon('check', sel.length ? `Aplicar em ${sel.length} dia${sel.length > 1 ? 's' : ''}` : 'Aplicar', 16)}</button></div></div>`;
    root.classList.remove('hidden');
    bind();
  }

  const addPick = (days) => days.forEach((d) => st.sel.add(d));
  function bind() {
    root.querySelectorAll('[data-f]').forEach((el) => (el.onchange = () => {
      const f = el.dataset.f;
      const v = f === 'taskId' ? el.value : f === 'snackDur' ? Number(el.value) : f === 'exit' ? exitFromInput(hhmmToMin(el.value)) : hhmmToMin(el.value);
      if (v == null || Number.isNaN(v)) return draw();
      st.cfg = applyEdit(st.cfg, f, v); draw();
    }));
    $('#rgCopy')?.addEventListener('change', (e) => { st.copyFrom = e.target.value; st.cfg = startCfg(Number(e.target.value) || 0); draw(); });
    root.querySelectorAll('.rg-day').forEach((b) => (b.onclick = () => { const d = Number(b.dataset.d); st.sel.has(d) ? st.sel.delete(d) : st.sel.add(d); draw(); }));
    root.querySelectorAll('[data-wd]').forEach((c) => (c.onchange = () => { c.checked ? st.wd.add(+c.dataset.wd) : st.wd.delete(+c.dataset.wd); }));
    $('#rgFrom').onchange = (e) => { st.from = Math.max(1, Math.min(n, Number(e.target.value) || 1)); };
    $('#rgTo').onchange = (e) => { st.to = Math.max(1, Math.min(n, Number(e.target.value) || n)); };
    $('#rgEmpty').onchange = (e) => { st.includeEmpty = e.target.checked; };
    $('#rgRange').onclick = () => { addPick(pickDays({ month, from: st.from, to: st.to, weekdays: st.wd, hasShift, locked, includeEmpty: st.includeEmpty })); draw(); };
    $('#rgAll').onclick = () => { addPick(pickDays({ month, from: 1, to: n, hasShift, locked })); draw(); };
    $('#rgNone').onclick = () => { st.sel.clear(); draw(); };
    $('#rgCancel').onclick = close;
    $('#rgRemove').onclick = async () => {
      const ds = [...st.sel].filter(hasShift).sort((a, b) => a - b);
      if (!ds.length) return;
      if (!confirm(`Marcar para remoção a escala de ${ds.length} dia(s) de ${agent.name} (${ds.join(', ')})? Entra no rascunho; se o agente ficar sem nenhum turno na janela do CSV, um card será aberto no Jira só quando você confirmar o rascunho.`)) return;
      st.busy = true; draw();
      try { await onRemove(ds); close(); } catch { st.busy = false; draw(); }
    };
    $('#rgOk').onclick = async () => {
      const days = [...st.sel].sort((a, b) => a - b).map((d) => ({ day: d, shifts: configToShifts(st.cfg, date(d), ctx) }));
      if (!days.length) return;
      st.busy = true; draw();
      try { await onApply(days); close(); } catch { st.busy = false; draw(); }
    };
  }

  draw();
}
