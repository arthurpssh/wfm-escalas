// Acesso cru à planilha via Google Sheets API v4 (sem dependências): conta de serviço → token OAuth (JWT RS256).
// Env: SHEETS_SPREADSHEET_ID; secrets GOOGLE_CLIENT_EMAIL e GOOGLE_PRIVATE_KEY (aceita "\n" literal).
// SHEETS_WRITE=1 liga as operações de escrita (e pede o escopo de edição); sem isso o gateway é somente leitura,
// mesmo que a conta de serviço tenha acesso de Editor. DRIVE_FOLDER_ID (com SHEETS_WRITE=1) liga o upload dos CSVs/arquivos grandes
// para essa pasta (a conta de serviço precisa ser Editora dela). Escrita testada só com planilha falsa; NÃO com a planilha real.
import { createSign } from 'node:crypto';

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const SCOPE_RO = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SCOPE_RW = 'https://www.googleapis.com/auth/spreadsheets';
const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export function createSheetsGateway(env = process.env) {
  const spreadsheetId = env.SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error('SHEETS_SPREADSHEET_ID não definido.');
  const clientEmail = (env.GOOGLE_CLIENT_EMAIL ?? '').trim();
  const privateKey = (env.GOOGLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (!clientEmail || !privateKey) throw new Error('GOOGLE_CLIENT_EMAIL e GOOGLE_PRIVATE_KEY não definidos.');
  const writable = ['1', 'true'].includes(String(env.SHEETS_WRITE ?? '').toLowerCase());
  const folderId = (env.DRIVE_FOLDER_ID ?? '').trim();
  const driveEnabled = writable && !!folderId;
  let token = null, exp = 0;

  async function accessToken() {
    if (token && Date.now() < exp - 60_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u({ alg: 'RS256', typ: 'JWT' });
    const claim = b64u({ iss: clientEmail, scope: writable ? (driveEnabled ? `${SCOPE_RW} ${SCOPE_DRIVE}` : SCOPE_RW) : SCOPE_RO, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(privateKey, 'base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    });
    if (!r.ok) throw new Error(`OAuth falhou (${r.status}).`);
    const j = await r.json();
    token = j.access_token; exp = Date.now() + j.expires_in * 1000;
    return token;
  }

  // Chamadas à API na última hora (cada tentativa conta na cota do Google, que é por minuto e por conta de serviço, somando todos os
  // ambientes que usam a mesma conta: produção, máquina de quem desenvolve...). Serve para diagnosticar "cota excedida".
  const hits = []; // { at, kind: 'read' | 'write', throttled }
  const note = (kind, throttled) => { const t = Date.now(); hits.push({ at: t, kind, throttled }); while (hits.length && t - hits[0].at > 3_600_000) hits.shift(); };
  const lastMinute = () => { const t = Date.now(), m = hits.filter((h) => t - h.at <= 60_000); return { reads: m.filter((h) => h.kind === 'read').length, writes: m.filter((h) => h.kind === 'write').length, throttled: m.filter((h) => h.throttled).length }; };

  async function call(method, url, body, { okEmpty = false, raw = false, headers = {} } = {}) {
    const kind = method === 'GET' ? 'read' : 'write';
    let last = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken()}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
      last = r.status;
      note(kind, r.status === 429);
      if (r.status === 429 || r.status >= 500) { // cota/erro transitório: espera (respeita Retry-After, com folga aleatória) e tenta de novo
        const m = lastMinute();
        console.warn(`[sheets] HTTP ${r.status} em ${method} ${url.replace(/\?.*/, '').slice(-50)} (tentativa ${attempt + 1}/4): ${m.reads} leitura(s) e ${m.writes} gravação(ões) deste processo no último minuto.`);
        const raw = r.headers?.get?.('retry-after'), ra = raw == null || raw === '' ? NaN : Number(raw); // o cabeçalho, quando existe, manda
        await new Promise((ok) => setTimeout(ok, (Number.isFinite(ra) ? Math.min(ra, 20) * 1000 : 1000 * 2 ** attempt) + Math.random() * 500));
        continue;
      }
      if (okEmpty && (r.status === 400 || r.status === 404)) return null;
      if (!r.ok) throw new Error(`Google API ${r.status} em ${method} ${url.replace(/\?.*/, '').slice(-60)}: ${(await r.text()).slice(0, 200)}`);
      return headers.Accept === 'text/plain' ? r.text() : r.json();
    }
    const e = new Error(`Google API: cota ou erro transitório persistente (HTTP ${last}).`);
    e.status = 503; e.code = 'sheets_unavailable';
    throw e;
  }

  const rangeOf = (name, a1 = '') => encodeURIComponent(`'${name}'${a1 ? '!' + a1 : ''}`);
  let meta = null; // { title -> { sheetId, rows, cols } }
  async function loadMeta(force = false) {
    if (meta && !force) return meta;
    const j = await call('GET', `${API}/${spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`);
    meta = Object.fromEntries(j.sheets.map((s) => [s.properties.title, { sheetId: s.properties.sheetId, rows: s.properties.gridProperties.rowCount, cols: s.properties.gridProperties.columnCount }]));
    return meta;
  }
  const requireWrite = () => { if (!writable) { const e = new Error('Escrita desligada (defina SHEETS_WRITE=1).'); e.status = 503; throw e; } };
  const colLetter = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  return {
    writable, driveEnabled,
    /** Grava um arquivo de texto na pasta do Drive (DRIVE_FOLDER_ID). Retorna o id. */
    async uploadFile({ name, content, mime = 'text/csv' }) {
      requireWrite();
      if (!driveEnabled) { const e = new Error('Drive desligado (defina DRIVE_FOLDER_ID).'); e.status = 503; throw e; }
      const boundary = `wfm${Date.now().toString(36)}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n--${boundary}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      const j = await call('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', body, { raw: true, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
      return j.id;
    },
    /** Conteúdo (texto) de um arquivo do Drive. */
    async downloadFile(id) {
      return call('GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, null, { headers: { Accept: 'text/plain' } });
    },
    /** Lê uma aba inteira como matriz (linha 0 = cabeçalho). Aba inexistente → []. */
    async readTab(name) {
      const j = await call('GET', `${API}/${spreadsheetId}/values/${rangeOf(name)}?valueRenderOption=UNFORMATTED_VALUE`, null, { okEmpty: true });
      return j?.values ?? [];
    },
    async listTabs() { return Object.keys(await loadMeta(true)); },
    /** Várias abas numa só chamada (batchGet): conta como UMA leitura na cota. Se alguma aba não existir o Google recusa o lote todo; aí lê uma a uma. */
    async readTabs(names) {
      if (names.length < 2) return Promise.all(names.map((n) => this.readTab(n)));
      const q = names.map((n) => `ranges=${rangeOf(n)}`).join('&');
      const j = await call('GET', `${API}/${spreadsheetId}/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE`, null, { okEmpty: true });
      if (!j) return Promise.all(names.map((n) => this.readTab(n)));
      return names.map((_, i) => j.valueRanges?.[i]?.values ?? []);
    },
    /** Chamadas deste processo à API: último minuto (leituras, gravações, recusadas por cota) e recusas na última hora. */
    stats() { return { ...lastMinute(), throttledLastHour: hits.filter((h) => h.throttled).length }; },

    /** Cria a aba (se faltar) e grava o cabeçalho quando a aba está vazia. */
    async ensureTab(name, header) {
      requireWrite();
      let m = await loadMeta();
      if (!m[name]) m = await loadMeta(true); // a lista guardada pode estar velha: a aba pode ter sido criada/importada depois que o app subiu
      if (!m[name]) {
        try {
          await call('POST', `${API}/${spreadsheetId}:batchUpdate`, { requests: [{ addSheet: { properties: { title: name, gridProperties: { rowCount: 1000, columnCount: Math.max(header.length, 10), frozenRowCount: 1 } } } }] });
        } catch (e) {
          if (!/already exists/i.test(e.message)) throw e; // alguém (Apps Script, outra pessoa) criou no meio: tudo bem, é o que queríamos
        }
        await loadMeta(true);
      }
      if (!(await this.readTab(name)).length) await this.replaceTab(name, [header]);
    },

    /** Substitui o conteúdo de A1 em diante pela matriz (linhas antigas além do novo fim são limpas). Uma chamada de gravação. */
    async replaceTab(name, matrix) {
      requireWrite();
      let m = await loadMeta();
      if (!m[name]) m = await loadMeta(true);
      if (!m[name]) throw new Error(`Aba ${name} não existe.`);
      const width = Math.max(1, ...matrix.map((r) => r.length));
      const known = m[name].written ?? (await this.readTab(name)).length; // linhas com conteúdo antes desta gravação
      const total = Math.max(matrix.length, known);
      if (total > m[name].rows || width > m[name].cols) {
        await call('POST', `${API}/${spreadsheetId}:batchUpdate`, { requests: [{ updateSheetProperties: { properties: { sheetId: m[name].sheetId, gridProperties: { rowCount: Math.max(total + 200, m[name].rows), columnCount: Math.max(width, m[name].cols) } }, fields: 'gridProperties(rowCount,columnCount)' } }] });
        await loadMeta(true);
      }
      const padded = Array.from({ length: total }, (_, i) => Array.from({ length: width }, (_, c) => matrix[i]?.[c] ?? ''));
      await call('PUT', `${API}/${spreadsheetId}/values/${rangeOf(name, `A1:${colLetter(width)}${total}`)}?valueInputOption=RAW`, { values: padded });
      meta[name].written = matrix.length;
    },

    /** Acrescenta linhas ao fim da aba (histórico: só inclusão). */
    async appendRows(name, rows) {
      requireWrite();
      if (!rows.length) return;
      await call('POST', `${API}/${spreadsheetId}/values/${rangeOf(name, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
      if (meta?.[name]) delete meta[name].written;
    },
  };
}
