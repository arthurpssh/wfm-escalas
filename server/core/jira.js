// Abertura de card no Jira para o que o CSV de importação não consegue expressar
// (hoje: remoção da escala de dias). UM card consolidado por checkout.
// Por padrão roda em DRY-RUN: monta o payload, devolve uma chave fictícia, sem nenhuma chamada de rede.
//
// Para ativar de verdade (futuro): JIRA_LIVE=1 + JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
// JIRA_PROJECT_KEY e (opcional) JIRA_ISSUE_TYPE. Endpoint: POST {base}/rest/api/3/issue (Jira Cloud, auth Basic email:token).

const cfg = () => ({
  live: process.env.JIRA_LIVE === '1',
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_EMAIL,
  token: process.env.JIRA_API_TOKEN,
  projectKey: process.env.JIRA_PROJECT_KEY ?? 'CXOPS',
  issueType: process.env.JIRA_ISSUE_TYPE ?? 'Task',
});

const adf = (lines) => ({ type: 'doc', version: 1, content: lines.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });
const hhmm = (iso) => iso.slice(11, 16);

/**
 * removals: [{ agent:{name,email}, date, previousShifts }]
 * Monta o corpo do POST /issue.
 */
export function buildRemovalsPayload({ team, month, removals, requestedBy }) {
  const c = cfg();
  const lines = removals.flatMap((r) => [`• ${r.agent.name} <${r.agent.email}> — ${r.date}: ${r.previousShifts.map((s) => `${hhmm(s.startTime)}–${hhmm(s.endTime)} ${s.taskName}`).join(' | ')}`]);
  return {
    fields: {
      project: { key: c.projectKey },
      issuetype: { name: c.issueType },
      summary: `[Escala] Remover ${removals.length} dia(s) de escala — ${team} — ${month}`,
      description: adf([
        `Remoção de escala solicitada pelo app de gestão de escalas. Time: ${team}. Solicitante: ${requestedBy}.`,
        'Dias a remover no Tymeshift (o CSV de importação não permite remover dias):',
        ...lines,
      ]),
      labels: ['escala', 'wfm', 'remocao-de-dia'],
    },
  };
}

let dry = 0;
/** Acionada no checkout quando o rascunho tem remoções. Nunca lança: falha vira { error }. */
export async function openRemovalsCard(input) {
  const payload = buildRemovalsPayload(input);
  const c = cfg();
  if (!c.live) {
    const key = `DRYRUN-${++dry}`;
    console.log(`[jira:dry-run] ${key} — ${payload.fields.summary}`);
    return { key, dryRun: true, payload };
  }
  try {
    const r = await fetch(`${c.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64') },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`Jira ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return { key: j.key, url: `${c.baseUrl}/browse/${j.key}`, dryRun: false, payload };
  } catch (e) {
    return { error: String(e.message ?? e), dryRun: false, payload };
  }
}
