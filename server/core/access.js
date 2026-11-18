// Permissões. Regra base (não depende da aba Acessos):
//  - supervisor (nome do time = e-mail) edita o próprio time;
//  - coordenador (coluna Coordenação) edita os times sob ele;
//  - todos os demais visualizam.
// Aba Acessos: exceções por time (ou "*") com validade; role "admin" libera a página admin (não implica editar).
// ENTRADA: por padrão (ACCESS_MODE=open) qualquer pessoa autenticada abre o app e vê todos os times em leitura; a aba Acessos só dá
// edição/admin. Com ACCESS_MODE=restricted, só entra quem tem alguma linha válida em Acessos (qualquer papel, inclusive viewer).

const norm = (s) => String(s ?? '').trim().toLowerCase();
/** E-mail com forma válida (sem espaços, um @, um ponto no domínio). Usado em DEV_IMPERSONATE. */
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? ''));
const valid = (row, today) => !row.validUntil || row.validUntil >= today;

export function roleFor(email, team, { access = [], today }) {
  const e = norm(email);
  if (norm(team.name) === e || norm(team.coordinator) === e) return 'editor';
  const ok = access.some((a) => norm(a.email) === e && a.role === 'editor' && (a.team === '*' || norm(a.team) === norm(team.name)) && valid(a, today));
  return ok ? 'editor' : 'viewer';
}

/** Tem alguma linha válida (não vencida) em Acessos, de qualquer papel. Usado no modo restrito (ACCESS_MODE=restricted). */
export const hasAccess = (email, { access = [], today }) => access.some((a) => norm(a.email) === norm(email) && valid(a, today));

/**
 * Modo de entrada. A aba Config (access_mode) manda quando preenchida; senão vale o ambiente (ACCESS_MODE, padrão open).
 * Valor preenchido mas inválido (ex.: "restrito") FECHA o app (restricted): um erro de digitação não pode abrir o acesso.
 */
export function resolveAccessMode(configValue, envMode = 'open') {
  const v = String(configValue ?? '').trim().toLowerCase();
  if (!v) return { mode: envMode, source: 'ambiente' };
  return { mode: v === 'open' || v === 'restricted' ? v : 'restricted', source: 'planilha (Config)', invalid: !(v === 'open' || v === 'restricted') };
}

/**
 * Portal do agente (Config agent_portal ou AGENT_PORTAL do ambiente): on | off, padrão off. Desligado, nada muda para ninguém.
 * Ligado, quem é agente de um time e não tem papel de supervisão (nem é supervisor, coordenador, editor ou admin, nem tem linha em Acessos)
 * passa a ver SÓ o portal. Valor preenchido mas inválido mantém DESLIGADO (um erro de digitação não muda quem vê o quê).
 */
export function resolvePortal(configValue, envValue = 'off') {
  const pick = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return null;
    return ['on', 'true', '1', 'sim'].includes(s) ? 'on' : ['off', 'false', '0', 'nao', 'não'].includes(s) ? 'off' : 'invalid';
  };
  const c = pick(configValue);
  if (c) return { on: c === 'on', source: 'planilha (Config)', ...(c === 'invalid' ? { invalid: true } : {}) };
  return { on: pick(envValue) === 'on', source: 'ambiente' };
}

export const isAdmin = (email, { access = [], today }) =>
  access.some((a) => norm(a.email) === norm(email) && a.role === 'admin' && valid(a, today));

/** Time aberto por padrão: o próprio; senão o primeiro sob coordenação/acesso; senão o primeiro. */
export function defaultTeam(email, teams, ctx) {
  return (teams.find((t) => norm(t.name) === norm(email))
    ?? teams.find((t) => roleFor(email, t, ctx) === 'editor')
    ?? teams[0])?.name;
}
