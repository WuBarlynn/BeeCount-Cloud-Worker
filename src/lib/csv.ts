/** Minimal RFC4180-ish CSV/TSV parser (no dependencies, low CPU). */
export type CsvTable = { headers: string[]; rows: Record<string, string>[]; delimiter: string };

function detectDelimiter(text: string): string {
  const firstLines = text.split(/\r?\n/).slice(0, 5).join('\n');
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    const count = (firstLines.match(new RegExp(`\\${d}`, 'g')) || []).length;
    if (count > bestScore) {
      best = d;
      bestScore = count;
    }
  }
  return best;
}

export function parseCsv(raw: string): CsvTable {
  const text = raw.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  if (!rows.length) return { headers: [], rows: [], delimiter };
  const headers = rows[0].map((h, idx) => (h || `column_${idx + 1}`).trim());
  const out: Record<string, string>[] = [];
  for (const line of rows.slice(1)) {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (line[idx] ?? '').trim()));
    out.push(obj);
  }
  return { headers, rows: out, delimiter };
}
