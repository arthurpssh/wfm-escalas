import { $, esc, api, getJson, toast, setupMockLogin, fmtTs, renderNav } from '/common.js';

let meta, me, teams = [];

async function init() {
  meta = await getJson('/api/meta');
  await setupMockLogin($('#mockUser'), start);
  await start();
}
async function start() {
  try { me = await getJson('/api/me'); } catch (e) { return toast(e.message, true); }
  teams = me.teams.map((t) => t.name);
  renderNav('admin', me);
  $('#denied').classList.toggle('hidden', me.isAdmin);
  $('#content').classList.toggle('hidden', !me.isAdmin);
  if (me.isAdmin) { await Promise.all([renderStats(), renderHistory(), renderAccess()]); }
}

// Abas = rotas: /admin/estatisticas | /admin/historico | /admin/acessos
const TABS = ['estatisticas', 'historico', 'acessos'];
function showTab(tab, push = false) {
  if (!TABS.includes(tab)) tab = TABS[0];
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  TABS.forEach((t) => $(`#tab-${t}`).classList.toggle('hidden', t !== tab));
  const url = `/admin/${tab}`;
  if (location.pathname.replace(/\/$/, '') !== url) history[push ? 'pushState' : 'replaceState'](null, '', url);
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab, true)));
window.addEventListener('popstate', () => showTab(location.pathname.split('/')[2]));
showTab(location.pathname.split('/')[2]);

// ---------- estatísticas ----------
const bars = (rows) => { const max = Math.max(1, ...rows.map((r) => r.n)); return `<div class="bars">${rows.map((r) => `<div><span style="width:200px;overflow:hidden;text-overflow:ellipsis">${esc(r.key)}</span><i style="width:${(r.n / max) * 240}px"></i>${r.n}</div>`).join('') || '<small>sem dados</small>'}</div>`; };
async function renderStats() {
  const s = await getJson('/api/admin/stats');
  const t = s.totals;
  const card = (n, l) => `<div class="card"><b>${n}</b><span>${l}</span></div>`;
  $('#tab-estatisticas').innerHTML = `<div class="cards">${card(t.actions, 'ações registradas')}${card(t.activeUsers, 'usuários ativos')}${card(t.checkouts, 'checkouts (lotes)')}${card(t.jiraCards, 'cards de remoção')}${card(t.openDrafts, 'rascunhos abertos')}${card(t.staleDrafts, 'rascunhos parados (>24h)')}</div>
    <div class="panel-card"><h3>Ações por tipo</h3>${bars(s.byAction)}</div>
    <div class="panel-card"><h3>Por usuário</h3>${bars(s.byActor)}</div>
    <div class="panel-card"><h3>Por time</h3>${bars(s.byTeam)}</div>
    <div class="panel-card"><h3>Rascunhos abertos</h3><table class="plain"><tr><th>Time | mês</th><th>Alterações</th><th>Última edição</th></tr>${s.openDrafts.map((d) => `<tr><td>${esc(d.key)}</td><td>${d.items}</td><td>${esc(d.updatedBy)} · ${fmtTs(d.updatedAt)}</td></tr>`).join('') || '<tr><td colspan="3"><small>nenhum</small></td></tr>'}</table></div>
    <div class="panel-card"><h3>Lotes recentes</h3><table class="plain"><tr><th>Lote</th><th>Time</th><th>Mês</th><th>Por</th><th>Dias</th><th>Arquivos</th><th>Jira</th><th>Status dos arquivos</th></tr>${s.batches.map((b) => `<tr><td>${b.batchId}</td><td>${esc(b.team)}</td><td>${b.month}</td><td>${esc(b.createdBy)}</td><td>${b.items}</td><td>${b.files ?? 0}</td><td>${esc(b.jira?.key ?? '—')}</td><td>${(b.exports ?? []).map((e) => e.status).join(', ') || '—'}</td></tr>`).join('') || '<tr><td colspan="8"><small>nenhum</small></td></tr>'}</table></div>
    <div class="panel-card"><h3>Integridade dos índices</h3>${s.orphanAgentIds.length ? `${s.orphanAgentIds.length} id(s) em Teams.agents_ids sem registro em Users (ignorados): <code>${s.orphanAgentIds.map(esc).join(', ')}</code>. A correção é do fluxo que alimenta as planilhas de índices.` : 'Todos os agentes dos times existem em Users.'}</div>`;
}

// ---------- histórico ----------
async function renderHistory(filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  const h = await getJson(`/api/admin/history?${qs}`);
  const sel = (id, label, opts, cur) => `<label>${label}<select id="${id}"><option value="">todos</option>${opts.map((o) => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
  $('#tab-historico').innerHTML = `<div class="form-inline">${sel('hMonth', 'Aba (mês)', h.months, filters.histMonth)}${sel('hTeam', 'Time', teams, filters.team)}${sel('hAction', 'Ação', meta.actions, filters.action)}<label>Usuário<input id="hActor" value="${esc(filters.actor ?? '')}" placeholder="e-mail"></label><button id="hGo" class="primary">Filtrar</button></div>
    <div class="panel-card"><table class="plain"><tr><th>Quando</th><th>Quem</th><th>Time</th><th>Ação</th><th>Agente / dia</th><th>Detalhes</th></tr>${h.entries.map((e) => `<tr><td>${fmtTs(e.ts)}</td><td>${esc(e.actor)}</td><td>${esc(e.team)}</td><td>${esc(e.action)}</td><td>${esc(e.agentEmail)}${e.day ? ` · dia ${e.day}` : ''}</td><td><small>${esc(e.details)}${e.batchId ? ` · lote ${esc(e.batchId)}` : ''}</small></td></tr>`).join('') || '<tr><td colspan="6"><small>sem registros</small></td></tr>'}</table></div>`;
  $('#hGo').onclick = () => renderHistory({ histMonth: $('#hMonth').value, team: $('#hTeam').value, action: $('#hAction').value, actor: $('#hActor').value.trim() });
}

// ---------- acessos ----------
async function renderAccess() {
  const rows = await getJson('/api/admin/access');
  $('#tab-acessos').innerHTML = `<div class="panel-card"><h3>Regra base (sem precisar de linha aqui)</h3><small>Supervisor edita o próprio time (nome do time = e-mail) · coordenador edita os times sob ele · todos visualizam. Aqui ficam as exceções e os admins.</small></div>
    <form id="accForm" class="form-inline"><label>E-mail<input name="email" required placeholder="pessoa@empresa.com"></label>
      <label>Time<select name="team"><option value="*">* (todos)</option>${teams.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
      <label>Papel<select name="role"><option>editor</option><option>viewer</option><option>admin</option></select></label>
      <label>Validade<input type="date" name="validUntil"></label><label>Nota<input name="note"></label><button class="primary">Conceder</button></form>
    <div class="panel-card"><table class="plain"><tr><th>E-mail</th><th>Time</th><th>Papel</th><th>Validade</th><th>Concedido por</th><th>Nota</th><th></th></tr>${rows.map((r) => `<tr class="${r.expired ? 'expired' : ''}"><td>${esc(r.email)}</td><td>${esc(r.team)}</td><td>${r.role}</td><td>${r.validUntil || '—'}${r.expired ? ' (expirado)' : ''}</td><td>${esc(r.grantedBy)}</td><td>${esc(r.note)}</td><td><button data-rev="${r.id}">Revogar</button></td></tr>`).join('')}</table></div>`;
  $('#accForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('/api/admin/access', { method: 'POST', body: f }); toast('Acesso concedido.'); await Promise.all([renderAccess(), renderHistory(), renderStats()]); } catch (err) { toast(err.message, true); }
  };
  document.querySelectorAll('[data-rev]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Revogar este acesso?')) return;
    try { await api(`/api/admin/access/${b.dataset.rev}`, { method: 'DELETE' }); toast('Acesso revogado.'); await Promise.all([renderAccess(), renderHistory(), renderStats()]); } catch (err) { toast(err.message, true); }
  }));
}

init().catch((e) => toast(e.message, true));
