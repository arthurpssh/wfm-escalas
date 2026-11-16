// Armazenamento de arquivos grandes (CSVs de exportação, "esperado" volumoso) na própria planilha, sem Drive.
// Aba `Arquivos`: uma linha por pedaço (fileId, seq, total, kind, name, createdAt, chunk). O conteúdo vai em base64 para voltar
// byte a byte (o Sheets normaliza quebras de linha e mexe em texto que parece fórmula/número) e é dividido em pedaços menores
// que o limite de uma célula (50.000 caracteres). Só inclusão: a limpeza (após a consolidação) é feita à parte.
import { randomUUID } from 'node:crypto';

export const FILES_HEAD = ['fileId', 'seq', 'total', 'kind', 'name', 'createdAt', 'chunk (base64)'];
export const CHUNK_CHARS = 40000;
export const MAX_BYTES = 4 * 1024 * 1024; // o import do WFM aceita até 5 MB; acima de 4 MB o arquivo não cabe com folga na planilha
const BATCH_CHARS = 1_500_000; // por chamada de gravação (a API recomenda payloads pequenos)

const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };

export function createSheetFileStore({ gateway, tab = 'Arquivos', now = () => new Date().toISOString() }) {
  let ready = false;
  return {
    /** Grava o conteúdo e devolve o id (`sheet:<id>`). Pedaços órfãos de uma falha no meio são inofensivos (nenhuma exportação os referencia). */
    async save({ name, content, kind = 'csv' }) {
      const buf = Buffer.from(String(content), 'utf8');
      if (buf.length > MAX_BYTES) throw fail(422, `Arquivo grande demais para guardar na planilha (${(buf.length / 1048576).toFixed(1)} MB; máximo ${MAX_BYTES / 1048576} MB). Reduza a janela de datas ou o número de agentes.`);
      if (!ready) { await gateway.ensureTab(tab, FILES_HEAD); ready = true; }
      const id = `sheet:${randomUUID().slice(0, 12)}`;
      const b64 = buf.toString('base64');
      const parts = [];
      for (let i = 0; i < b64.length; i += CHUNK_CHARS) parts.push(b64.slice(i, i + CHUNK_CHARS));
      if (!parts.length) parts.push('');
      const at = now();
      let batch = [], size = 0;
      for (let i = 0; i < parts.length; i++) {
        if (batch.length && size + parts[i].length > BATCH_CHARS) { await gateway.appendRows(tab, batch); batch = []; size = 0; }
        batch.push([id, i, parts.length, kind, name, at, parts[i]]);
        size += parts[i].length;
      }
      if (batch.length) await gateway.appendRows(tab, batch);
      return id;
    },

    /** Reconstitui o conteúdo. Falha se faltar algum pedaço (nunca devolve arquivo truncado). */
    async load(id) {
      const rows = (await gateway.readTab(tab)).slice(1).filter((r) => String(r[0]) === id).sort((a, b) => Number(a[1]) - Number(b[1]));
      if (!rows.length) throw fail(404, 'Arquivo não encontrado na planilha (já removido?).');
      const total = Number(rows[0][2]);
      const seqs = new Set(rows.map((r) => Number(r[1])));
      if (seqs.size !== total || rows.length !== total) throw fail(500, `Arquivo incompleto na planilha (${seqs.size} de ${total} pedaços).`);
      return Buffer.from(rows.map((r) => String(r[6] ?? '')).join(''), 'base64').toString('utf8');
    },
  };
}
