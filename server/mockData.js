// Dados mockados. Em produção isto vem da planilha de escalas (extraída do WFM) + planilha de índices.
// Os IDs de atividades/razões abaixo são reais (copiados da aba Activities do índice); agentes são fictícios.
import { resolveAgentDefinition } from './core/scales.js';
import { configToShifts, dateOf, daysInMonth, roundMin, toIso, pad } from '../shared/rules.js';

export const ACTIVITIES = [
  { taskType: 'workstream', taskId: 'fb20db9f-8f1b-4e68-81d9-6fba2c0c9a13', taskName: '[BR] Chat' },
  { taskType: 'workstream', taskId: 'f52bc668-6091-437e-a418-4b904d886de2', taskName: 'CX Planning & CRM' },
  { taskType: 'workstream', taskId: 'a99a639f-04a9-41f8-a9c7-9f237b9bfd65', taskName: '[BR] E-mail' },
  { taskType: 'workstream', taskId: '6f549f95-1c8d-4554-8051-5680cf25224c', taskName: '[BR] Whatsapp' },
  { taskType: 'workstream', taskId: 'aed36177-df9c-48ec-827b-2ed4d9b500bb', taskName: '[INT] Chat' },
  { taskType: 'workstream', taskId: 'c4097bb3-300a-4314-a915-c51f6b5c5681', taskName: 'N2 [Tickets]' },
  { taskType: 'workstream', taskId: '5636844b-3e7b-420c-8f02-aaf94fe8ac2d', taskName: 'Legal Ops' },
  { taskType: 'multitask', taskId: '2fcfcd2e-13dc-4ba5-bfc6-aae85e13626c', taskName: '[BR] Canais Síncronos + E-mail' },
  { taskType: 'multitask', taskId: 'da8a3ea4-78f3-4024-bcec-f9b7b92af027', taskName: '[INT] Canais Síncronos + E-mail' },
  { taskType: 'generalTask', taskId: '9fba0dd5-5e54-466f-a371-6909971376af', taskName: 'Backoffice Hotmart' },
  { taskType: 'generalTask', taskId: '253143', taskName: 'Lunch Time' },
  { taskType: 'generalTask', taskId: '253263', taskName: 'Snack Break' },
];
export const LUNCH = ACTIVITIES.find((a) => a.taskName === 'Lunch Time');
export const SNACK = ACTIVITIES.find((a) => a.taskName === 'Snack Break');
export const MAIN_TASKS = ACTIVITIES.filter((a) => a.taskType !== 'generalTask' || a.taskName === 'Backoffice Hotmart');

export const TIMEOFF_REASONS = [
  { taskId: '9235db2a-6bd1-4f6b-ad96-80fecb5988f9', taskName: 'Day Off' },
  { taskId: '078fc362-22c8-4ffb-b248-a27b437088c4', taskName: 'Doctor Appointment' },
  { taskId: '85c51cf2-16d4-42a3-b1de-414281c0076a', taskName: 'Holiday' },
  { taskId: '6db2335b-0eca-4d66-bda8-76fb1899b56d', taskName: 'Paid time off for Sunday team' },
  { taskId: 'b522bd3b-17eb-4bf3-a164-12ddc2cf4c7d', taskName: 'Sick Day' },
  { taskId: '606bcdff-ebaf-4b90-a85e-66af010ed039', taskName: 'Time off agreed with leadership' },
  { taskId: '57d8c893-0504-443b-96ef-527ab7d93e69', taskName: 'Vacation' },
];

const names = ['Ana Beatriz Lima', 'Bruno Carvalho', 'Camila Ferreira', 'Diego Nascimento', 'Eduarda Souza', 'Felipe Andrade', 'Gabriela Rocha', 'Henrique Alves', 'Isabela Martins', 'João Pedro Costa', 'Karina Barros', 'Lucas Moreira', 'Mariana Teixeira', 'Nicolas Ribeiro', 'Olivia Pinto', 'Rafael Duarte'];
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(' ');

// Aba EscalasPadrao: diasSemana em dígitos (1=dom..7=sáb; segunda a sexta = '23456'); horários HH:MM; almoco vazio = sem almoço.
export const STANDARD_SCALES = [
  { id: 'EP01', diasSemana: '23456', entrada: '09:00', almoco: '13:00', snack: '16:00', duracaoSnack: 15, saida: '18:00' },
  { id: 'EP02', diasSemana: '23456', entrada: '08:00', almoco: '12:00', snack: '15:00', duracaoSnack: 15, saida: '17:00' },
  { id: 'EP03', diasSemana: '234567', entrada: '10:00', almoco: '', snack: '14:00', duracaoSnack: 45, saida: '16:20' },
  { id: 'EP04', diasSemana: '167', entrada: '12:00', almoco: '16:00', snack: '19:00', duracaoSnack: 15, saida: '21:20' },
];
const SCALE_BY_ID = new Map(STANDARD_SCALES.map((s) => [s.id, s]));
// Escala padrão (ou personalizada) de cada agente por posição: a aba Users ganha escalaPadraoId e as colunas particulares.
const SCALE_OF = ['EP01', 'EP01', 'EP01', 'EP02', 'EP03', 'EP04', '-'];
const CUSTOM = [
  { diasSemana: '2345', entrada: '11:00', almoco: '15:00', snack: '18:00', duracaoSnack: 15, saida: '20:30' },
  { diasSemana: '34567', entrada: '07:00', almoco: '', snack: '11:00', duracaoSnack: 45, saida: '13:20' },
];

// Espelham as abas Users (id,email,name + colunas de escala) e Teams (name = e-mail do supervisor, agents_ids, Coordenação, defaultTaskId) do índice.
export const USERS = names.map((name, i) => {
  const p = slug(name);
  const escalaPadraoId = SCALE_OF[i % 7];
  const own = escalaPadraoId === '-' ? CUSTOM[Math.floor(i / 7) % CUSTOM.length] : {};
  return { id: String(1000 + i), email: `${p[0]}.${p.at(-1)}@example.com`, name, escalaPadraoId, diasSemana: '', entrada: '', almoco: '', snack: '', duracaoSnack: '', saida: '', ...own };
});
const SUPS = ['sup.alfa@example.com', 'sup.beta@example.com', 'sup.gama@example.com'];
export const COORD = 'coord@example.com';
export const TEAMS = SUPS.map((name, t) => ({
  id: `team-${t}`,
  name,
  coordinator: t < 2 ? COORD : '', // gama não tem coordenação
  defaultTaskId: ['f52bc668-6091-437e-a418-4b904d886de2', 'fb20db9f-8f1b-4e68-81d9-6fba2c0c9a13', '2fcfcd2e-13dc-4ba5-bfc6-aae85e13626c'][t], // workstream/multitask padrão da equipe
  agentIds: [...USERS.filter((_, i) => i % 3 === t).map((u) => u.id), ...(t === 0 ? ['999999'] : [])], // 999999 = id sem Users (órfão)
}));
export const ORPHAN_AGENT_IDS = [];
/** Agentes resolvidos = Teams.agents_ids x Users. Ids sem Users são ignorados (e contados no admin). */
export const AGENTS = TEAMS.flatMap((t) => t.agentIds.flatMap((id) => {
  const u = USERS.find((x) => x.id === id);
  if (!u) { ORPHAN_AGENT_IDS.push(id); return []; }
  const r = resolveAgentDefinition(u, SCALE_BY_ID);
  return [{ id, email: u.email, name: u.name, team: t.name, scaleId: r.scaleId, def: r.def }];
}));

export const MOCK_LOGINS = [
  ...SUPS.map((e) => ({ email: e, label: `${e} (supervisor)` })),
  { email: COORD, label: `${COORD} (coordenação alfa+beta)` },
  { email: 'admin@example.com', label: 'admin@example.com (admin)' },
  { email: 'visitante@example.com', label: 'visitante@example.com (só leitura)' },
];
/** Espelha a aba Acessos. validUntil em YYYY-MM-DD. */
export const ACCESS_SEED = [
  { id: 'a1', email: 'admin@example.com', team: '*', role: 'admin', validUntil: '', grantedBy: 'seed', note: 'Admin do app' },
  { id: 'a2', email: 'sup.gama@example.com', team: 'sup.alfa@example.com', role: 'editor', validUntil: '2099-12-31', grantedBy: 'admin@example.com', note: 'Cobertura de férias' },
  { id: 'a3', email: 'visitante@example.com', team: 'sup.beta@example.com', role: 'editor', validUntil: '2020-01-31', grantedBy: 'admin@example.com', note: 'Expirado (não vale)' },
];

export const CTX = {
  lunch: LUNCH,
  snack: SNACK,
  tasks: new Map(ACTIVITIES.map((a) => [a.taskId, a])),
};

function rng(seed) {
  let a = [...seed].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Escala mockada de um mês: { [email]: { [dia]: Shift[] } } */
export function generateMonth(month) {
  const cells = {};
  const n = daysInMonth(month);
  AGENTS.forEach((agent, i) => {
    const r = rng(`${agent.email}${month}`);
    const entry = [7, 8, 9, 10, 11, 12][i % 6] * 60;
    const long = i % 4 !== 3;
    const len = long ? 560 : 380;
    const task = MAIN_TASKS[i % 8].taskId;
    const workDays = i % 5 === 4 ? [5, 6, 0] : i % 5 === 3 ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5];
    cells[agent.email] = {};
    for (let d = 1; d <= n; d++) {
      const dow = new Date(+month.slice(0, 4), +month.slice(5) - 1, d).getDay();
      if (!workDays.includes(dow) || r() < 0.06) continue;
      const exit = entry + len;
      const cfg = long
        ? { taskId: task, entry, lunch: entry + roundMin(len * 0.4), snack: entry + roundMin(len * 0.75), snackDur: 15, exit }
        : { taskId: task, entry, lunch: null, snack: entry + roundMin(len * 0.5), snackDur: 45, exit };
      cells[agent.email][d] = configToShifts(cfg, dateOf(month, d), CTX);
    }
  });
  return cells;
}

/** Folgas mockadas ao redor de um mês (inclui uma que atravessa a virada do mês). */
export function generateTimeoffs(month, now = Date.now()) {
  const n = daysInMonth(month);
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  const reason = (name) => TIMEOFF_REASONS.find((t) => t.taskName === name);
  const mk = (id, agent, reasonName, start, end, extra = {}) => ({
    id: `${month}-${id}`, email: AGENTS[agent].email, reasonId: reason(reasonName).taskId, reasonName,
    startTime: start, endTime: end, status: 'aprovada', origin: 'wfm', ...extra,
  });
  const fullStart = (d) => `${d}T00:00:00-03:00`;
  const fullEnd = (d) => `${d}T23:59:59-03:00`;
  return [
    mk('vac1', 1, 'Vacation', fullStart(dateOf(month, 3)), fullEnd(dateOf(month, 9))),
    mk('vac2', 5, 'Vacation', fullStart(dateOf(month, n - 3)), fullEnd(`${nextMonth}-05`)),
    mk('sick', 2, 'Sick Day', fullStart(dateOf(month, 12)), fullEnd(dateOf(month, 12))),
    mk('doc', 0, 'Doctor Appointment', toIso(dateOf(month, 11), 14 * 60), toIso(dateOf(month, 11), 16 * 60)),
    mk('doc2', 6, 'Time off agreed with leadership', toIso(dateOf(month, 17), 8 * 60), toIso(dateOf(month, 17), 11 * 60)),
    mk('pend', 3, 'Day Off', fullStart(dateOf(month, 18)), fullEnd(dateOf(month, 18)), {
      status: 'agendada', origin: 'app', createdBy: 'sup.alfa@example.com', createdAt: new Date(now).toISOString(), scheduledAt: new Date(now + 10 * 60_000).toISOString(),
    }),
    // pedidos feitos pelos próprios agentes (pendentes de decisão no WFM)
    mk('req1', 2, 'Day Off', fullStart(dateOf(month, 20)), fullEnd(dateOf(month, 20)), { status: 'pendente', origin: 'agent', createdBy: AGENTS[2].email, createdAt: new Date(now - 3 * 3600_000).toISOString() }),
    mk('req2', 4, 'Doctor Appointment', toIso(dateOf(month, 19), 14 * 60), toIso(dateOf(month, 19), 16 * 60), { status: 'pendente', origin: 'agent', createdBy: AGENTS[4].email, createdAt: new Date(now - 26 * 3600_000).toISOString() }),
    mk('req3', 7, 'Vacation', fullStart(dateOf(month, 24)), fullEnd(dateOf(month, 26)), { status: 'pendente', origin: 'agent', createdBy: AGENTS[7].email, createdAt: new Date(now - 5 * 3600_000).toISOString() }),
    mk('den1', 8, 'Day Off', fullStart(dateOf(month, 13)), fullEnd(dateOf(month, 13)), { status: 'negada', origin: 'agent', createdBy: AGENTS[8].email, decidedBy: 'sup.beta@example.com', createdAt: new Date(now - 48 * 3600_000).toISOString() }),
  ];
}
