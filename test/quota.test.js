// Cota do Google Sheets: leituras em lote, sem rajada, com o último valor quando o Google recusa, e contadores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createSheetsGateway } from '../server/data/sheetsGateway.js';
import { createSheetsRepo } from '../server/data/sheetsRepo.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ENV = { SHEETS_SPREADSHEET_ID: 'SID', GOOGLE_CLIENT_EMAIL: 'sa@x.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: privateKey };
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ---------- gateway ----------
function fakeFetch(handler) {
  const real = globalThis.fetch, realWarn = console.warn, calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 't', expires_in: 3600 });
    calls.push(decodeURIComponent(u.replace('https://sheets.googleapis.com/v4/spreadsheets/SID', '')));
    return handler(u, calls.length);
  };
  console.warn = () => {};
  return { calls, restore: () => { globalThis.fetch = real; console.warn = realWarn; } };
}

test('gateway: várias abas numa só chamada (batchGet), na ordem pedida, aba vazia = []', async () => {
  const f = fakeFetch(() => json({ valueRanges: [{ values: [['a']] }, {}, { values: [['c'], ['d']] }] }));
  try {
    const [a, b, c] = await createSheetsGateway(ENV).readTabs(['Teams', 'Users', 'Activities']);
    assert.deepEqual([a, b, c], [[['a']], [], [['c'], ['d']]]);
    assert.equal(f.calls.length, 1); // UMA leitura na cota, não três
    assert.match(f.calls[0], /values:batchGet\?ranges='Teams'&ranges='Users'&ranges='Activities'/);
  } finally { f.restore(); }
});

test('gateway: se uma aba não existe, o Google recusa o lote e o app lê uma a uma (aba inexistente = [])', async () => {
  const f = fakeFetch((u) => {
    if (u.includes('values:batchGet')) return json({ error: { code: 400, message: 'Unable to parse range' } }, 400);
    if (u.includes("'Faltando'")) return json({ error: { code: 400 } }, 400);
    return json({ values: [['ok']] });
  });
  try {
    const [a, b] = await createSheetsGateway(ENV).readTabs(['Teams', 'Faltando']);
    assert.deepEqual([a, b], [[['ok']], []]);
    assert.equal(f.calls.length, 3); // o lote que falhou + as duas leituras individuais
  } finally { f.restore(); }
});

test('gateway: 429 respeita Retry-After, tenta de novo e conta as recusas; o erro final é claro e marcado', async () => {
  let n = 0;
  const f = fakeFetch(() => (++n <= 2 ? json({ error: 'quota' }, 429, { 'Retry-After': '0' }) : json({ values: [['x']] })));
  try {
    const g = createSheetsGateway(ENV);
    assert.deepEqual(await g.readTab('Config'), [['x']]);
    assert.deepEqual([g.stats().reads, g.stats().throttled, g.stats().throttledLastHour], [3, 2, 2]); // cada tentativa conta
  } finally { f.restore(); }
  const f2 = fakeFetch(() => json({ error: 'quota' }, 429, { 'Retry-After': '0' }));
  try {
    const g = createSheetsGateway(ENV);
    await assert.rejects(() => g.readTab('Config'), (e) => e.code === 'sheets_unavailable' && e.status === 503 && /cota ou erro transitório persistente \(HTTP 429\)/.test(e.message));
    assert.equal(g.stats().throttled, 4);
  } finally { f2.restore(); }
});

// ---------- repo ----------
function fakeGateway(over = {}) {
  const st = { reads: [], fail: false };
  const tabs = {
    Teams: [['name', 'agents_ids'], ['sup@x.com', '1']], Users: [['id', 'email', 'name'], ['1', 'a@x.com', 'Ana']], Activities: [['taskType', 'taskId', 'taskName']],
    EscalasPadrao: [['id']], TimeOffReasons: [['taskId', 'taskName']], Config: [['key', 'value'], ['access_mode', 'open']],
  };
  const g = {
    writable: false, st,
    async readTab(n) { st.reads.push(n); if (st.fail) { const e = new Error('Google API: cota ou erro transitório persistente (HTTP 429).'); e.code = 'sheets_unavailable'; throw e; } return structuredClone(tabs[n] ?? []); },
    ...over,
  };
  return g;
}

test('repo: leituras simultâneas do mesmo dado viram UMA leitura (sem rajada)', async () => {
  const g = fakeGateway();
  const r = createSheetsRepo({ gateway: g });
  await Promise.all([r.settings(), r.settings(), r.settings(), r.settings()]); // as 4 chamadas de uma tela
  assert.equal(g.st.reads.filter((n) => n === 'Config').length, 1);
  await Promise.all([r.catalog(), r.catalog(), r.catalog()]);
  assert.equal(g.st.reads.filter((n) => n === 'Teams').length, 1);
});

test('repo: o catálogo usa o gateway em lote (5 abas = 1 leitura) quando ele sabe', async () => {
  let batches = 0;
  const g = fakeGateway({ async readTabs(names) { batches++; return Promise.all(names.map((n) => g.readTab(n))); } });
  const r = createSheetsRepo({ gateway: g });
  await r.catalog();
  assert.equal(batches, 1);
});

test('repo: catálogo tem cache mais longo que o resto', async () => {
  let t = 0;
  const g = fakeGateway();
  const r = createSheetsRepo({ gateway: g, cacheSec: 60, catalogCacheSec: 300, now: () => t });
  await r.catalog(); await r.settings();
  t = 120_000; // 2 min depois
  await r.catalog(); await r.settings();
  assert.equal(g.st.reads.filter((n) => n === 'Teams').length, 1); // catálogo ainda vale
  assert.equal(g.st.reads.filter((n) => n === 'Config').length, 2); // configuração foi relida
  t = 400_000;
  await r.catalog();
  assert.equal(g.st.reads.filter((n) => n === 'Teams').length, 2);
});

test('repo: se o Google recusar na renovação, usa o último valor (e tenta de novo em ~15 s); sem valor antigo, o erro continua', async () => {
  let t = 0;
  const g = fakeGateway();
  const r = createSheetsRepo({ gateway: g, cacheSec: 60, now: () => t });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal((await r.settings()).access_mode, 'open');
    g.st.fail = true; t = 61_000; // cache vencido e o Google recusando
    assert.equal((await r.settings()).access_mode, 'open'); // não derruba: devolve o antigo
    const n = g.st.reads.length;
    t = 70_000; await r.settings(); // dentro dos ~15 s de espera: nem tenta de novo
    assert.equal(g.st.reads.length, n);
    t = 80_000; g.st.fail = false; g.st.reads.length = 0;
    await r.settings();
    assert.equal(g.st.reads.length, 1); // voltou: relê
    // sem valor antigo: o erro aparece
    const g2 = fakeGateway(); g2.st.fail = true;
    await assert.rejects(() => createSheetsRepo({ gateway: g2 }).settings(), (e) => e.code === 'sheets_unavailable');
  } finally { console.warn = warn; }
});

test('repo: sheetsInfo traz os contadores do gateway e os tempos de cache', () => {
  const r = createSheetsRepo({ gateway: fakeGateway({ stats: () => ({ reads: 7, writes: 1, throttled: 0, throttledLastHour: 3 }) }), cacheSec: 60, catalogCacheSec: 300 });
  assert.deepEqual(r.sheetsInfo(), { reads: 7, writes: 1, throttled: 0, throttledLastHour: 3, cacheSec: 60, catalogCacheSec: 300 });
});
