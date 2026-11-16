import test from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsRepo } from '../server/data/sheetsRepo.js';
import { CHUNK_CHARS, MAX_BYTES, createSheetFileStore } from '../server/data/fileStore.js';
import { exportsToMatrix, loadBatches, loadExports, batchesToMatrix } from '../server/data/persist.js';

function fakeGateway({ drive = false, writable = true } = {}) {
  const tabs = new Map(), files = new Map();
  const g = {
    writable, driveEnabled: drive && writable, tabs, files, failFiles: false, failSheet: false,
    async readTab(n) { return structuredClone(tabs.get(n) ?? []); },
    async listTabs() { return [...tabs.keys()]; },
    async ensureTab(n, h) { if (!tabs.get(n)?.length) tabs.set(n, [h]); },
    async replaceTab(n, m) { if (g.failSheet) throw new Error('cota excedida'); tabs.set(n, structuredClone(m)); },
    async appendRows(n, rows) { if (n === 'Arquivos' && g.failFiles) throw new Error('planilha fora do ar'); tabs.set(n, [...(tabs.get(n) ?? []), ...structuredClone(rows)]); },
    async uploadFile({ name, content }) { if (g.failFiles) throw new Error('drive fora do ar'); const id = `D${files.size + 1}`; files.set(id, { name, content }); return id; },
    async downloadFile(id) { return files.get(id).content; },
  };
  return g;
}
const mk = (g) => createSheetsRepo({ gateway: g, debounceMs: 60_000 });
const shift = { taskType: 'workstream', taskId: 'W1', taskName: 'Chat', startTime: '2026-11-02T09:00:00-03:00', endTime: '2026-11-02T10:00:00-03:00' };
const CSV = 'agentName,agentEmail,taskName\r\nAna "Lima",a@x.com,Pausa – café\r\n';
const exp = (over = {}) => ({ id: 'e1', batchId: 'b1', team: 't@x.com', month: '2026-11', name: 'escala_t_2026-11_02.csv', window: { from: '2026-11-02', to: '2026-11-02' }, agents: ['a@x.com'], rows: 5, expected: { 'a@x.com': { 2: [shift] } }, csv: CSV, csvHash: 'h1', status: 'aguardando_verificacao', createdAt: Date.parse('2026-11-13T10:00:00Z'), createdBy: 'u@x.com', attempts: 0, ...over });

test('armazém de arquivos: volta byte a byte (CRLF, acentos, aspas), dividido em pedaços', async () => {
  const g = fakeGateway();
  const store = createSheetFileStore({ gateway: g });
  const content = Array.from({ length: 4000 }, (_, i) => `Ana "Lima",a${i}@x.com,Pausa – café\r\n`).join('');
  const id = await store.save({ name: 'x.csv', content });
  assert.match(id, /^sheet:/);
  const rows = g.tabs.get('Arquivos').slice(1);
  assert.ok(rows.length > 2);
  assert.ok(rows.every((r) => String(r[6]).length <= CHUNK_CHARS)); // cabe numa célula
  assert.equal(await store.load(id), content);
});

test('armazém de arquivos: arquivo vazio, grande demais e incompleto', async () => {
  const g = fakeGateway();
  const store = createSheetFileStore({ gateway: g });
  assert.equal(await store.load(await store.save({ name: 'v.csv', content: '' })), '');
  await assert.rejects(() => store.save({ name: 'g.csv', content: 'x'.repeat(MAX_BYTES + 1) }), (e) => e.status === 422 && /grande demais/.test(e.message));
  const id = await store.save({ name: 'm.csv', content: 'y'.repeat(100000) });
  const t = g.tabs.get('Arquivos');
  g.tabs.set('Arquivos', t.filter((r, i) => i === 0 || !(r[0] === id && r[1] === 1))); // some um pedaço
  await assert.rejects(() => store.load(id), /incompleto/);
  await assert.rejects(() => store.load('sheet:nao-existe'), (e) => e.status === 404);
});

test('checkout fica ligado com escrita, com ou sem Drive; sem escrita fica desligado', () => {
  assert.equal(mk(fakeGateway({ drive: true })).capabilities.checkout, true);
  assert.equal(mk(fakeGateway({ drive: false })).capabilities.checkout, true);
  assert.equal(mk(fakeGateway({ writable: false })).capabilities.checkout, false);
});

test('exportação sem Drive: CSV na aba Arquivos, linha em Exportacoes, tudo volta ao reiniciar', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  const [saved] = await a.exports.addMany([exp()]);
  assert.equal(saved.csv, undefined); // não fica na memória
  assert.match(saved.fileId, /^sheet:/);
  assert.equal(g.files.size, 0); // não usou o Drive
  assert.equal(g.tabs.get('Exportacoes').length, 2);
  await a.batches.add({ batchId: 'b1', team: 't@x.com', month: '2026-11', createdBy: 'u@x.com', createdAt: Date.parse('2026-11-13T10:00:00Z'), items: 2, emails: ['a@x.com'], files: 1, csvRows: 5, removals: [{ email: 'a@x.com', date: '2026-11-05' }], jira: { key: 'DRYRUN-1', dryRun: true } });

  const b = mk(g); const r = await b.init();
  assert.equal(r.exports, 1); assert.equal(r.batches, 1); assert.equal(r.expectedFailed, 0);
  const e = (await b.exports.list())[0];
  assert.deepEqual(e.expected, { 'a@x.com': { 2: [shift] } });
  assert.equal(e.createdAt, Date.parse('2026-11-13T10:00:00Z'));
  assert.equal(await b.exports.csvOf(e), CSV); // idêntico, inclusive CRLF
  const batch = (await b.batches.list())[0];
  assert.deepEqual(batch.jira, { key: 'DRYRUN-1', dryRun: true, error: undefined });
  assert.deepEqual(batch.removals, [{ email: 'a@x.com', date: '2026-11-05' }]);
});

test('com DRIVE_FOLDER_ID o arquivo vai para o Drive (e baixa de lá)', async () => {
  const g = fakeGateway({ drive: true });
  const a = mk(g); await a.init();
  const [saved] = await a.exports.addMany([exp()]);
  assert.equal(saved.fileId, 'D1');
  assert.equal(g.tabs.get('Arquivos'), undefined);
  assert.equal(await a.exports.csvOf(saved), CSV);
});

test('"esperado" grande demais para uma célula vira arquivo e volta', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  const big = {}; for (let d = 1; d <= 30; d++) big[d] = Array.from({ length: 12 }, () => ({ ...shift, taskName: 'x'.repeat(100) }));
  const expected = { 'a@x.com': big };
  assert.ok(JSON.stringify(expected).length > 45000);
  await a.exports.addMany([exp({ expected })]);
  assert.match(g.tabs.get('Exportacoes')[1][19], /^file:sheet:/);
  const b = mk(g); await b.init();
  assert.deepEqual((await b.exports.list())[0].expected, expected);
});

test('exportação já consolidada não carrega o esperado ao iniciar', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.exports.addMany([exp()]);
  await a.exports.update('e1', { status: 'consolidada', consolidatedAt: '2026-11-14T10:00:00.000Z' });
  await a.flush();
  const b = mk(g); await b.init();
  const e = (await b.exports.list())[0];
  assert.equal(e.status, 'consolidada'); assert.deepEqual(e.expected, {}); assert.equal(e.consolidatedAt, '2026-11-14T10:00:00.000Z');
});

test('se guardar o arquivo falhar, nada é registrado (o checkout pode ser repetido sem duplicar)', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  g.failFiles = true;
  await assert.rejects(() => a.exports.addMany([exp({ id: 'e1' }), exp({ id: 'e2' })]), /fora do ar/);
  assert.equal((await a.exports.list()).length, 0);
  assert.equal(g.tabs.get('Exportacoes'), undefined);
});

test('se a planilha falhar ao registrar, o checkout avisa (não finge sucesso) e a regravação fica pendente', async () => {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  g.failSheet = true;
  await assert.rejects(() => a.exports.addMany([exp()]), /Não foi possível gravar/);
  g.failSheet = false;
  await a.flush();
  assert.equal(g.tabs.get('Exportacoes').length, 2);
});

test('sem escrita: nada grava (503)', async () => {
  const ro = mk(fakeGateway({ writable: false }));
  await assert.rejects(() => ro.exports.addMany([exp()]), (e) => e.status === 503);
});

test('serialização: exportações e lotes (helpers puros)', () => {
  const rows = loadExports(exportsToMatrix([{ ...exp(), fileId: 'sheet:abc', expectedCell: '{}' }]));
  assert.equal(rows[0].fileId, 'sheet:abc'); assert.equal(rows[0].attempts, 0);
  assert.equal(loadBatches(batchesToMatrix([{ batchId: 'b', team: 't', month: 'm', createdAt: 0, jira: null }]))[0].jira, null);
});

// ---------- verificação das exportações (resultado do Apps Script em `Verificacoes`) ----------
const verifRow = (ts, id, res, detail = '') => [ts, id, res, detail];
async function comExportacao(over = {}) {
  const g = fakeGateway();
  const a = mk(g); await a.init();
  await a.exports.addMany([exp(over)]);
  return { g, a };
}

test('"Já publiquei" (sheets): só registra o pedido; quem verifica é o Apps Script', async () => {
  const { g, a } = await comExportacao();
  const e = await a.exports.requestVerification('e1');
  assert.ok(e.verifyRequestedAt);
  assert.equal(e.status, 'aguardando_verificacao'); // não muda sozinho
  assert.equal(g.tabs.get('Exportacoes')[1][20], e.verifyRequestedAt); // gravado na coluna do app
  assert.equal(await a.exports.requestVerification('inexistente'), null);
});

test('resultado consolidada: status, data, limpeza programada, e o cache do mês é descartado', async () => {
  const { g, a } = await comExportacao();
  g.tabs.set('Escala 2026-11', [['agentEmail', '1', '2'], ['a@x.com', '', '[]']]);
  await a.cells('2026-11'); // entra no cache
  g.tabs.set('Escala 2026-11', [['agentEmail', '1', '2'], ['a@x.com', '', JSON.stringify([shift])]]); // o Apps Script atualizou a aba
  g.tabs.set('Verificacoes', [['ts', 'exportId', 'resultado', 'detalhe'], verifRow('2026-11-13T12:00:00.000Z', 'e1', 'consolidada')]);
  await a.tick();
  const e = await a.exports.get('e1');
  assert.deepEqual([e.status, e.consolidatedAt, e.deleteAfter, e.attempts, e.lastCheckAt], ['consolidada', '2026-11-13T12:00:00.000Z', '2027-01-13', 1, '2026-11-13T12:00:00.000Z']);
  assert.deepEqual(e.expected, {});
  assert.deepEqual((await a.cells('2026-11'))['a@x.com'][2], [shift]); // releu a aba sem esperar o cache de 60 s
  assert.equal(a.audit.query({ action: 'export.verify' })[0].actor, 'apps-script');
  await a.flush();
  assert.equal(g.tabs.get('Exportacoes')[1][9], 'consolidada'); // persistido
});

test('resultados nao_publicada / divergente / expirada; resultado antigo não desfaz o novo', async () => {
  const { g, a } = await comExportacao();
  g.tabs.set('Verificacoes', [['ts', 'exportId', 'resultado', 'detalhe'], verifRow('2026-11-13T12:00:00.000Z', 'e1', 'nao_publicada')]);
  await a.tick();
  let e = await a.exports.get('e1');
  assert.equal(e.status, 'nao_publicada'); assert.match(e.note, /rascunho/);
  // mais tarde: divergente; e uma linha ANTIGA (já aplicada) não volta a valer
  g.tabs.get('Verificacoes').push(verifRow('2026-11-13T13:00:00.000Z', 'e1', 'divergente', 'dia 2 diferente'));
  await a.tick(); // dentro de 15 s: não relê
  assert.equal((await a.exports.get('e1')).status, 'nao_publicada');
  const t0 = Date.now; Date.now = () => t0() + 20_000; // passam 20 s
  const b = createSheetsRepo({ gateway: g, debounceMs: 60_000, now: () => Date.now() }); await b.init();
  await b.tick();
  e = await b.exports.get('e1');
  assert.equal(e.status, 'divergente'); assert.equal(e.note, 'dia 2 diferente'); assert.equal(e.attempts, 2);
  await b.tick(); assert.equal((await b.exports.get('e1')).attempts, 2); // idempotente
  g.tabs.get('Verificacoes').push(verifRow('2026-11-15T13:00:00.000Z', 'e1', 'expirada', 'Sem consolidar em 48 h.'));
  Date.now = () => t0() + 60_000;
  await b.tick();
  assert.equal((await b.exports.get('e1')).status, 'expirada');
  Date.now = t0;
});

test('exportação já consolidada ignora novos resultados; sem Verificacoes não quebra', async () => {
  const { g, a } = await comExportacao();
  await a.tick(); // aba inexistente
  assert.equal((await a.exports.get('e1')).status, 'aguardando_verificacao');
  g.tabs.set('Verificacoes', [['ts', 'exportId', 'resultado', 'detalhe'], verifRow('2026-11-13T12:00:00.000Z', 'e1', 'consolidada')]);
  const t0 = Date.now; Date.now = () => t0() + 20_000;
  const b = createSheetsRepo({ gateway: g, debounceMs: 60_000, now: () => Date.now() }); await b.init(); await b.tick();
  g.tabs.get('Verificacoes').push(verifRow('2026-11-14T12:00:00.000Z', 'e1', 'divergente', 'x'));
  Date.now = () => t0() + 60_000; await b.tick();
  assert.equal((await b.exports.get('e1')).status, 'consolidada');
  Date.now = t0;
});

test('divergente: as diferenças detalhadas (5ª coluna de Verificacoes) são guardadas, sobrevivem ao reinício e somem ao consolidar', async () => {
  const { g, a } = await comExportacao();
  const diffs = { total: 2, items: [{ email: 'a@x.com', dia: 2, esperado: [{ a: 'W', s: '09:00', e: '13:00' }], publicado: [] }] };
  g.tabs.set('Verificacoes', [['ts', 'exportId', 'resultado', 'detalhe', 'diferencas (JSON)'], ['2026-11-13T12:00:00.000Z', 'e1', 'divergente', 'não bate (2 dia(s) diferentes).', JSON.stringify(diffs)]]);
  await a.tick();
  let e = await a.exports.get('e1');
  assert.deepEqual([e.status, e.diffTotal, e.diffs.length, e.diffs[0].dia], ['divergente', 2, 1, 2]);
  await a.flush();
  assert.match(g.tabs.get('Exportacoes')[1][21], /"total":2/); // coluna própria
  const b = mk(g); await b.init();
  e = await b.exports.get('e1');
  assert.equal(e.diffTotal, 2); assert.deepEqual(e.diffs[0].esperado, [{ a: 'W', s: '09:00', e: '13:00' }]);
  // consolida depois: as diferenças saem
  g.tabs.get('Verificacoes').push(['2026-11-13T13:00:00.000Z', 'e1', 'consolidada', '', '']);
  const t0 = Date.now; Date.now = () => t0() + 20_000;
  const c = createSheetsRepo({ gateway: g, debounceMs: 60_000, now: () => Date.now() }); await c.init(); await c.tick();
  e = await c.exports.get('e1');
  assert.deepEqual([e.status, e.diffs, e.diffTotal], ['consolidada', null, null]);
  Date.now = t0;
});

test('divergente sem coluna de diferenças (linha antiga) e JSON inválido: aplica o status sem quebrar', async () => {
  for (const cell of [undefined, '{ não é json']) {
    const { g, a } = await comExportacao();
    const row = ['2026-11-13T12:00:00.000Z', 'e1', 'divergente', 'texto antigo'];
    if (cell !== undefined) row.push(cell);
    g.tabs.set('Verificacoes', [['ts', 'exportId', 'resultado', 'detalhe'], row]);
    await a.tick();
    const e = await a.exports.get('e1');
    assert.equal(e.status, 'divergente'); assert.equal(e.diffs, null);
  }
});

test('"Já publiquei" repetido: bloqueado (409) enquanto o pedido espera; volta com o resultado ou depois de 30 min sem resposta', async () => {
  let t = Date.parse('2026-11-16T15:00:00Z');
  const g = fakeGateway();
  const a = createSheetsRepo({ gateway: g, debounceMs: 60_000, now: () => t }); await a.init();
  await a.exports.addMany([exp()]);
  const e1 = await a.exports.requestVerification('e1');
  const pedido = e1.verifyRequestedAt;
  await assert.rejects(() => a.exports.requestVerification('e1'), (err) => err.status === 409 && /Já há uma verificação pedida às \d\d:\d\d/.test(err.message));
  assert.equal((await a.exports.get('e1')).verifyRequestedAt, pedido); // o horário do 1º pedido não foi regravado
  assert.equal(g.tabs.get('Exportacoes')[1][20], pedido);

  // 31 min sem resposta (Apps Script parado): o pedido vira "sem resposta" e o botão volta
  t += 31 * 60000;
  const e2 = await a.exports.requestVerification('e1');
  assert.ok(e2.verifyRequestedAt > pedido);
});

test('"Já publiquei": depois que o Apps Script responde, dá para pedir de novo', async () => {
  let t = Date.parse('2026-11-16T15:00:00Z');
  const g = fakeGateway();
  const a = createSheetsRepo({ gateway: g, debounceMs: 60_000, now: () => t }); await a.init();
  await a.exports.addMany([exp()]);
  await a.exports.requestVerification('e1');
  // o Apps Script responde "divergente" depois do pedido
  g.tabs.set('Verificacoes', [['ts', 'exportId', 'resultado', 'detalhe', 'diferencas (JSON)'], [new Date(t + 60000).toISOString(), 'e1', 'divergente', 'x', '']]);
  t += 20_000; await a.tick();
  t += 100_000; // pedido novo, depois do resultado
  const novo = await a.exports.requestVerification('e1');
  assert.ok(novo.verifyRequestedAt > novo.lastCheckAt);
});
