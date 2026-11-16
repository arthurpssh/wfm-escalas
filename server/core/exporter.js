// Planejamento dos CSVs de importação a partir dos itens do rascunho.
//
// Regras validadas na Fase 0:
//  - a janela do import vai da PRIMEIRA à ÚLTIMA data de todas as linhas do arquivo;
//  - vale só para os agentes presentes no arquivo; dentro da janela eles são substituídos por completo
//    (dia sem linha é apagado);
//  - dia = data local; tudo-ou-nada; folgas fora do CSV.
// Logo: um arquivo por "cluster" de datas; só entram agentes com alteração no cluster; cada um é reemitido
// em TODOS os dias da janela (os não alterados vêm da escala base = publicado + pendentes de consolidação).
import { CSV_HEADER, shiftRow, toCsv } from './csv.js';

const MAX_BYTES = 5 * 1024 * 1024;
const dd = (n) => String(n).padStart(2, '0');
const byStart = (a, b) => a.startTime.localeCompare(b.startTime);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * @param {object} p
 * @param {string} p.team  nome do time (e-mail do supervisor)
 * @param {string} p.month 'YYYY-MM'
 * @param {Array}  p.items itens do rascunho { email, day, kind, before, after }
 * @param {object} p.baseCells escala base { email: { dia: Shift[] } } (sem o rascunho)
 * @param {Array}  p.agents agentes do time { email, name }
 * @param {Array}  p.activities índice de atividades { taskType, taskId, taskName }
 * @param {string} p.today 'YYYY-MM-DD'
 * @param {number} [p.gapDays=Infinity] dias vazios tolerados entre alterações para ficarem no mesmo arquivo.
 *   Padrão: SEMPRE um arquivo (a janela vai da primeira à última alteração do rascunho, no máximo o mês).
 *   Um número finito divide em vários arquivos quando há buracos maiores que isso.
 * @param {Map}    [p.assignments] email -> Set(taskId) (aba Atribuicoes); sem ele, só avisa
 * @returns {{ files: object[], unexpressible: object[], errors: string[], warnings: string[] }}
 */
export function planExports({ team, month, items, baseCells, agents, activities, today, gapDays = Infinity, assignments = null }) {
  const files = [], unexpressible = [], errors = [], warnings = [];
  const agentOf = new Map(agents.map((a) => [a.email, a]));
  const activity = new Map(activities.map((a) => [a.taskId, a]));
  const minDate = addDays(today, -30);
  const maxDate = addDays(today, 365 * 2);
  const slug = team.split('@')[0];

  // 1) clusters de dias (entre todos os agentes)
  const clusters = [];
  for (const d of [...new Set(items.map((i) => i.day))].sort((a, b) => a - b)) {
    const last = clusters.at(-1);
    if (last && d - last.to - 1 <= gapDays) last.to = d; else clusters.push({ from: d, to: d });
  }

  clusters.forEach((cl) => {
    const its = items.filter((i) => i.day >= cl.from && i.day <= cl.to);
    const byItem = new Map(its.map((i) => [`${i.email}|${i.day}`, i]));
    const rows = [], expected = {}, included = [];
    let reemitted = 0; // dias de agente SEM alteração que são reemitidos só para preservá-los

    for (const email of [...new Set(its.map((i) => i.email))].sort()) {
      const agent = agentOf.get(email);
      const exp = {}, agentRows = [];
      for (let d = cl.from; d <= cl.to; d++) {
        const it = byItem.get(`${email}|${d}`);
        const shifts = [...(it ? it.after : baseCells[email]?.[d] ?? [])].sort(byStart);
        exp[d] = shifts;
        shifts.forEach((s) => agentRows.push(shiftRow(agent, s)));
        if (!it && shifts.length) reemitted++;
      }
      if (!agentRows.length) { // agente sem nenhuma linha na janela: não aparece no arquivo, logo não dá para apagar pelo CSV
        its.filter((i) => i.email === email && i.kind === 'removed').forEach((i) => unexpressible.push({ email, day: i.day, before: i.before }));
        continue;
      }
      expected[email] = exp; rows.push(...agentRows); included.push(email);
    }
    if (!rows.length) return;

    const name = `escala_${slug}_${month}_${dd(cl.from)}-${dd(cl.to)}.csv`;
    const from = `${month}-${dd(cl.from)}`, to = `${month}-${dd(cl.to)}`;

    // 2) pré-voo (qualquer erro derruba o arquivo inteiro no WFM)
    const fileErrors = [];
    if (from < minDate) fileErrors.push(`${name}: a janela começa antes de ${minDate} (o import aceita até 30 dias no passado).`);
    if (to > maxDate) fileErrors.push(`${name}: a janela passa de 2 anos no futuro.`);
    for (const email of included) {
      const list = rows.filter((r) => r.agentEmail === email).sort(byStart);
      list.forEach((r, i) => {
        const where = `${name} · ${email} ${r.startTime.slice(0, 10)}`;
        const act = activity.get(r.taskId);
        if (!act) fileErrors.push(`${where}: atividade inexistente no índice (${r.taskName} / ${r.taskId}).`);
        else if (act.taskType !== r.taskType) fileErrors.push(`${where}: tipo "${r.taskType}" não bate com o índice ("${act.taskType}") para ${r.taskName}.`);
        if (r.startTime >= r.endTime) fileErrors.push(`${where}: ${r.taskName} com duração zero ou negativa.`);
        if (i > 0 && r.startTime < list[i - 1].endTime) fileErrors.push(`${where}: ${r.taskName} sobrepõe ${list[i - 1].taskName}.`);
        if (assignments && r.taskType !== 'generalTask' && !assignments.get(email)?.has(r.taskId)) fileErrors.push(`${where}: agente não atribuído a ${r.taskName}.`);
      });
    }
    const csv = toCsv(rows);
    if (Buffer.byteLength(csv) > MAX_BYTES) fileErrors.push(`${name}: arquivo maior que 5 MB.`);
    errors.push(...fileErrors);
    files.push({ name, window: { from, to }, agents: included, rows: rows.length, days: cl.to - cl.from + 1, reemitted, csv, expected, header: CSV_HEADER });
  });

  if (files.length && !assignments) warnings.push('A atribuição dos agentes aos workstreams não é verificada pelo app: o WFM recusa o arquivo inteiro se faltar alguma.');
  if (files.length > 1) warnings.push(`O app está configurado para dividir em ${files.length} arquivos: importe e publique um de cada vez, na ordem.`);
  const re = files.reduce((n, f) => n + f.reemitted, 0);
  if (re) warnings.push(`${re} dia(s) de agente sem alteração serão reemitidos no arquivo para não serem apagados pelo import (dados da última extração).`);
  return { files, unexpressible, errors, warnings };
}
