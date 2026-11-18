// Feriados. Fonte em produção: aba `Feriados` (dona: Apps Script, que preenche as linhas de origem "google" a partir do calendário
// público de feriados do Brasil; linhas de outra origem, como municipal ou estadual, são manuais e o Apps Script não toca nelas).
// Colunas: data | nome | tipo | origem | time (vazio ou * = todos os times; senão o nome do time). O app só LÊ esta aba.
// A leitura vem com UNFORMATTED_VALUE: uma célula de data chega como número de série do Sheets, por isso o parser aceita as duas formas.

const SERIAL_EPOCH = 25569; // 1970-01-01 em número de série do Sheets

/** Número de série, 'YYYY-MM-DD…' ou 'DD/MM/YYYY' -> 'YYYY-MM-DD' ('' se não der). */
export function normalizeDate(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(Math.round((v - SERIAL_EPOCH) * 86400000)).toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

const KEYS = { data: 'date', date: 'date', nome: 'name', name: 'name', tipo: 'type', type: 'type', origem: 'source', source: 'source', time: 'team', team: 'team' };

/** Matriz da aba (linha 0 = cabeçalho) -> [{ date, name, type, source, team }] sem repetidos, em ordem de data. */
export function parseHolidays(matrix) {
  if (!matrix?.length) return [];
  const cols = matrix[0].map((k) => KEYS[String(k).trim().toLowerCase()] ?? null);
  const seen = new Set(), out = [];
  for (const r of matrix.slice(1)) {
    const o = {};
    cols.forEach((k, i) => { if (k) o[k] = r[i]; });
    const date = normalizeDate(o.date), name = String(o.name ?? '').trim();
    if (!date || !name) continue;
    const team = String(o.team ?? '').trim();
    const key = `${date}|${name.toLowerCase()}|${team}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, name, type: String(o.type ?? '').trim() || 'nacional', source: String(o.source ?? '').trim() || 'manual', team: team === '*' ? '' : team });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'pt-BR'));
}

/** Feriados de um mês que valem para o time (linha sem time vale para todos). Data comemorativa ("Dia das Mães") não é feriado: fica de fora. */
export const holidaysFor = (list, team, month) => list.filter((h) => h.date.startsWith(month) && h.type !== 'comemorativa' && (!h.team || h.team === team));

// Mock (DATA_SOURCE=mock): feriados nacionais de 2026 e 2027, só para a tela ter o que mostrar.
const nat = (date, name, type = 'nacional') => ({ date, name, type, source: 'google', team: '' });
export const MOCK_HOLIDAYS = [
  nat('2026-01-01', 'Confraternização Universal'), nat('2026-04-03', 'Sexta-feira Santa'), nat('2026-04-21', 'Tiradentes'), nat('2026-05-01', 'Dia do Trabalho'),
  nat('2026-06-04', 'Corpus Christi', 'facultativo'), nat('2026-09-07', 'Independência do Brasil'), nat('2026-10-12', 'Nossa Senhora Aparecida'), nat('2026-11-02', 'Finados'),
  nat('2026-11-15', 'Proclamação da República'), nat('2026-11-20', 'Dia da Consciência Negra'), nat('2026-12-25', 'Natal'),
  nat('2027-01-01', 'Confraternização Universal'), nat('2027-03-26', 'Sexta-feira Santa'), nat('2027-04-21', 'Tiradentes'), nat('2027-05-01', 'Dia do Trabalho'),
  nat('2027-05-27', 'Corpus Christi', 'facultativo'), nat('2027-09-07', 'Independência do Brasil'), nat('2027-10-12', 'Nossa Senhora Aparecida'), nat('2027-11-02', 'Finados'),
  nat('2027-11-15', 'Proclamação da República'), nat('2027-11-20', 'Dia da Consciência Negra'), nat('2027-12-25', 'Natal'),
];
