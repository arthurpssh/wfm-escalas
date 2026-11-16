import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, createSheetsRepo, hhmmCell, parseAccess, parseMonthSheet, parseTimeoffs, rowsToObjects } from '../server/data/sheetsRepo.js';
import { createRepo } from '../server/data/repo.js';

const TABS = {
  Teams: [['name', 'agents_ids', 'Coordenação', 'defaultTaskId'], ['Sup.Alfa@example.com', '1, 2 ,9', 'coord@example.com', 'T1']],
  Users: [
    ['id', 'email', 'name', 'escalaPadraoId', 'diasSemana', 'entrada', 'almoco', 'snack', 'duracaoSnack', 'saida'],
    ['1', 'Ana@example.com', 'Ana', 'EP01', '', '', '', '', '', ''],
    ['2', 'bia@example.com', 'Bia', '-', '23456', 0.375, '', '14:00', 45, '16:20'], // 0.375 = 09:00 (célula tipo hora)
  ],
  Activities: [['taskType', 'taskId', 'taskName'], ['workstream', 'T1', '[BR] Chat'], ['generalTask', '253143', 'Lunch Time'], ['generalTask', '253263', 'Snack Break']],
  EscalasPadrao: [['id', 'diasSemana', 'entrada', 'almoco', 'snack', 'duracaoSnack', 'saida'], ['EP01', '23456', '09:00', '13:00', '16:00', 15, '18:00']],
  TimeOffReasons: [['taskId', 'taskName'], ['R1', 'Day Off']],
  'Escala 2026-11': [['agentEmail', '1', '2', '3'], ['ana@example.com', '', '[{"taskId":"T1","startTime":"2026-11-02T09:00:00-03:00","endTime":"2026-11-02T10:00:00-03:00"}]', 'lixo{']],
  TimeOffs: [['id', 'agentEmail', 'reasonId', 'reasonName', 'startTime', 'endTime', 'status', 'createdAt', 'scheduledAt', 'externalId', 'createdBy'], ['t1', 'ana@example.com', 'R1', 'Day Off', '2026-11-05T00:00:00-03:00', '2026-11-05T23:59:59-03:00', 'approved', '', '', 'x', 'sup.alfa@example.com']],
  Acessos: [['email', 'team (nome do time ou *)', 'role', 'validUntil', 'grantedBy', 'grantedAt', 'note'], ['Admin@x.com', '*', 'admin', '', '', '', '']],
};
const gateway = (calls = []) => ({ readTab: async (n) => { calls.push(n); return TABS[n] ?? []; } });

test('catálogo: cabeçalho por nome, e-mails em minúsculas, órfãos e escala padrão × personalizada', () => {
  const c = buildCatalog({ teams: TABS.Teams, users: TABS.Users, activities: TABS.Activities, scales: TABS.EscalasPadrao, reasons: TABS.TimeOffReasons });
  assert.deepEqual(c.orphanAgentIds, ['9']);
  assert.equal(c.teams[0].name, 'sup.alfa@example.com');
  assert.deepEqual(c.agents.map((a) => a.email), ['ana@example.com', 'bia@example.com']);
  assert.equal(c.agents[0].scaleId, 'EP01');
  assert.equal(c.agents[0].def.entry, 9 * 60);
  assert.equal(c.agents[1].scaleId, null);
  assert.equal(c.agents[1].def.entry, 9 * 60); // fração do dia convertida
  assert.equal(c.ctx.lunch.taskId, '253143');
});

test('aba do mês: JSON por célula; célula inválida é ignorada', () => {
  const { cells, bad } = parseMonthSheet(TABS['Escala 2026-11']);
  assert.equal(bad, 1);
  assert.deepEqual(Object.keys(cells['ana@example.com']), ['2']);
});

test('folgas e acessos: normalização e nomes antigos de status', () => {
  const [t] = parseTimeoffs(TABS.TimeOffs);
  assert.equal(t.status, 'aprovada');
  assert.equal(t.origin, 'app');
  assert.equal(parseTimeoffs([TABS.TimeOffs[0], ['t2', 'ana@x.com', 'R1', 'Day Off', 'a', 'b', 'pendente', '', '', 'y', 'ana@x.com'], ['t3', 'ana@x.com', 'R1', 'Day Off', 'a', 'b', 'aprovada', '', '', 'z', '']])[0].origin, 'agent');
  assert.equal(parseTimeoffs([TABS.TimeOffs[0], ['t3', 'ana@x.com', 'R1', 'Day Off', 'a', 'b', 'aprovada', '', '', 'z', '']])[0].origin, 'wfm');
  assert.equal(parseAccess(TABS.Acessos)[0].team, '*');
  assert.equal(hhmmCell(0.5), '12:00');
  assert.equal(rowsToObjects([['a'], [''], ['x']]).length, 1);
});

test('repo sheets: leitura com cache, escrita recusada (somente leitura)', async () => {
  const calls = [];
  let t = 0;
  const repo = createSheetsRepo({ gateway: gateway(calls), cacheSec: 60, now: () => t });
  assert.equal(repo.readOnly, true);
  await repo.cells('2026-11'); await repo.cells('2026-11');
  assert.equal(calls.filter((n) => n === 'Escala 2026-11').length, 1);
  t = 61_000; await repo.cells('2026-11');
  assert.equal(calls.filter((n) => n === 'Escala 2026-11').length, 2);
  await assert.rejects(() => repo.timeoffs.add({}), (e) => e.status === 503);
  assert.equal((await repo.timeoffs.get('t1')).email, 'ana@example.com');
});

test('repo sheets: Users vazio aborta em vez de zerar o catálogo', async () => {
  const repo = createSheetsRepo({ gateway: { readTab: async (n) => (n === 'Users' ? [['id', 'email']] : TABS[n] ?? []) } });
  await assert.rejects(() => repo.catalog(), /Users vazia/);
});

test('fábrica: DATA_SOURCE padrão é mock; valor inválido falha', async () => {
  assert.equal((await createRepo({})).kind, 'mock');
  await assert.rejects(() => createRepo({ DATA_SOURCE: 'xyz' }), /inválido/);
});

test('settings: aba Config como objeto (chaves em minúsculas), com cache de 60 s para alternar na planilha', async () => {
  const cfg = [['key', 'value', 'description'], ['Access_Mode', ' restricted ', 'x'], ['timezone_offset', '-03:00', ''], ['', 'sem chave', ''], ['jira_live', 'FALSE', '']];
  const tabs = { Config: cfg };
  let t = 0;
  const repo = createSheetsRepo({ gateway: { readTab: async (n) => tabs[n] ?? [] }, cacheSec: 60, now: () => t });
  assert.deepEqual(await repo.settings(), { access_mode: 'restricted', timezone_offset: '-03:00', jira_live: 'FALSE' });
  tabs.Config = [cfg[0], ['access_mode', 'open', '']]; // alguém troca na planilha
  assert.equal((await repo.settings()).access_mode, 'restricted'); // ainda no cache
  t = 61_000;
  assert.equal((await repo.settings()).access_mode, 'open'); // passou 1 min: vale
  tabs.Config = []; // sem aba Config: objeto vazio (cai no ambiente)
  t = 200_000;
  assert.deepEqual(await repo.settings(), {});
});
