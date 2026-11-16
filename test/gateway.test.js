import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createSheetsGateway } from '../server/data/sheetsGateway.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ENV = { SHEETS_SPREADSHEET_ID: 'SID', GOOGLE_CLIENT_EMAIL: 'sa@x.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: privateKey, SHEETS_WRITE: '1' };

/** Sheets API falsa (só o que o gateway usa), com a lista de abas alterável "por fora". */
function fakeSheets({ tabs = {}, addSheetRaces = false } = {}) {
  const st = { tabs: new Map(Object.entries(tabs)), calls: [], nextId: 10 };
  const ids = new Map([...st.tabs.keys()].map((n, i) => [n, i + 1]));
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url), method = opts.method ?? 'GET';
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 't', expires_in: 3600 });
    const path = decodeURIComponent(u.replace('https://sheets.googleapis.com/v4/spreadsheets/SID', ''));
    st.calls.push(`${method} ${path.split('?')[0]}`);
    if (method === 'GET' && path.startsWith('?fields=')) return json({ sheets: [...st.tabs.keys()].map((n) => ({ properties: { sheetId: ids.get(n), title: n, gridProperties: { rowCount: 1000, columnCount: 26 } } })) });
    if (method === 'POST' && path.startsWith(':batchUpdate')) {
      const req = JSON.parse(opts.body).requests[0];
      if (req.addSheet) {
        const title = req.addSheet.properties.title;
        if (st.tabs.has(title) || addSheetRaces) { st.tabs.set(title, st.tabs.get(title) ?? []); ids.set(title, ids.get(title) ?? st.nextId++); return json({ error: { code: 400, message: `Invalid requests[0].addSheet: A sheet with the name "${title}" already exists. Please enter another name.` } }, 400); }
        st.tabs.set(title, []); ids.set(title, st.nextId++);
      }
      return json({});
    }
    const m = /\/values\/'([^']+)'(?:!([^?]*))?(:append)?/.exec(path);
    if (m) {
      const [, name, , append] = m;
      if (!st.tabs.has(name)) return json({ error: { code: 400, message: 'Unable to parse range' } }, 400);
      if (method === 'GET') return json({ values: st.tabs.get(name) });
      const values = JSON.parse(opts.body).values;
      st.tabs.set(name, append ? [...st.tabs.get(name), ...values] : values);
      return json({});
    }
    return json({ error: { code: 404, message: `rota não prevista: ${method} ${path}` } }, 404);
  };
  return { st, restore: () => { globalThis.fetch = real; } };
}

test('aba criada à mão DEPOIS de o app carregar a lista de abas: não tenta criar de novo', async () => {
  const f = fakeSheets({ tabs: { Rascunhos: [['h']] } });
  try {
    const g = createSheetsGateway(ENV);
    await g.ensureTab('Rascunhos', ['h']); // carrega a lista (só tem Rascunhos)
    f.st.tabs.set('FolgasPedidos', []); // alguém importa a aba na planilha com o app no ar
    await g.ensureTab('FolgasPedidos', ['id', 'tipo']);
    assert.deepEqual(f.st.tabs.get('FolgasPedidos'), [['id', 'tipo']]); // só gravou o cabeçalho
    assert.ok(!f.st.calls.some((c, i) => c === 'POST :batchUpdate' && i > 3)); // nenhum addSheet
  } finally { f.restore(); }
});

test('aba realmente ausente é criada; e se alguém a criar no meio ("already exists") segue em frente', async () => {
  const f = fakeSheets({ tabs: { Rascunhos: [['h']] } });
  try {
    const g = createSheetsGateway(ENV);
    await g.ensureTab('Nova', ['a', 'b']);
    assert.deepEqual(f.st.tabs.get('Nova'), [['a', 'b']]);
  } finally { f.restore(); }
  const race = fakeSheets({ tabs: {}, addSheetRaces: true });
  try {
    const g = createSheetsGateway(ENV);
    await g.ensureTab('Corrida', ['x']); // o addSheet responde 400 "already exists", mas a aba passou a existir
    assert.deepEqual(race.st.tabs.get('Corrida'), [['x']]);
  } finally { race.restore(); }
});

test('replaceTab em aba criada depois do carregamento da lista também funciona', async () => {
  const f = fakeSheets({ tabs: { A: [['h']] } });
  try {
    const g = createSheetsGateway(ENV);
    await g.ensureTab('A', ['h']);
    f.st.tabs.set('B', [['velho']]);
    await g.replaceTab('B', [['id'], ['1']]);
    assert.deepEqual(f.st.tabs.get('B').slice(0, 2), [['id'], ['1']]);
  } finally { f.restore(); }
});

test('um erro de verdade ao criar a aba continua sendo erro', async () => {
  const f = fakeSheets({ tabs: {} });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes(':batchUpdate') ? new Response(JSON.stringify({ error: { code: 403, message: 'sem permissão' } }), { status: 403 }) : real(url, opts));
  try {
    const g = createSheetsGateway(ENV);
    await assert.rejects(() => g.ensureTab('X', ['a']), /403/);
  } finally { f.restore(); }
});
