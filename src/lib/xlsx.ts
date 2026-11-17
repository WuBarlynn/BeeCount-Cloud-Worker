/**
 * Minimal XLSX reader for the Workers runtime.
 *
 * An .xlsx file is a ZIP archive of SpreadsheetML parts. This module reads the
 * central directory, inflates only the parts it needs (`deflate-raw` via the
 * native DecompressionStream) and parses rows with small regex-based XML
 * scanners. It intentionally supports the first worksheet only and caps the
 * work so a malformed upload cannot burn the 10 ms CPU budget.
 */
import type { CsvTable } from './csv';

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

const MAX_SHEET_BYTES = 24 * 1024 * 1024;

function u16(dv: DataView, off: number): number {
  return dv.getUint16(off, true);
}

function u32(dv: DataView, off: number): number {
  return dv.getUint32(off, true);
}

function readEntries(buf: ArrayBuffer): ZipEntry[] {
  const dv = new DataView(buf);
  const len = buf.byteLength;
  if (len < 22) throw new Error('not a ZIP archive');
  let eocd = -1;
  const start = Math.max(0, len - 65557);
  for (let i = len - 22; i >= start; i--) {
    if (u32(dv, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive');
  const count = u16(dv, eocd + 10);
  let off = u32(dv, eocd + 16);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > len || u32(dv, off) !== 0x02014b50) break;
    const method = u16(dv, off + 10);
    const compressedSize = u32(dv, off + 20);
    const nameLen = u16(dv, off + 28);
    const extraLen = u16(dv, off + 30);
    const commentLen = u16(dv, off + 32);
    const localOffset = u32(dv, off + 42);
    const name = decoder.decode(new Uint8Array(buf, off + 46, nameLen));
    entries.push({ name, method, compressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(buf);
  const lo = entry.localOffset;
  if (lo + 30 > buf.byteLength || u32(dv, lo) !== 0x04034b50) throw new Error('corrupt ZIP entry');
  const nameLen = u16(dv, lo + 26);
  const extraLen = u16(dv, lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  if (start + entry.compressedSize > buf.byteLength) throw new Error('corrupt ZIP entry');
  const raw = new Uint8Array(buf, start, entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error('unsupported ZIP compression method');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return XML_ENTITIES[body] ?? all;
  });
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function richText(fragment: string): string {
  const cleaned = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of cleaned.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function valueOf(body: string): string | null {
  const m = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  return m ? decodeXml(m[1]) : null;
}

function columnIndex(ref: string | undefined): number | null {
  if (!ref) return null;
  const letters = ref.match(/^([A-Za-z]+)\d+/);
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function excelSerialText(serial: number): string {
  if (!Number.isFinite(serial)) return String(serial);
  const adjusted = serial - 25569 + (serial < 61 ? 1 : 0);
  const ms = Math.round(adjusted * 86_400_000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  const hasTime = serial % 1 !== 0;
  return hasTime ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

function dateStyleIndexes(stylesXml: string): Set<number> {
  const result = new Set<number>();
  if (!stylesXml) return result;
  const builtin = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55,
    56, 57, 58,
  ]);
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const a = attrsOf(m[0]);
    const id = Number(a.numFmtId);
    if (Number.isFinite(id) && a.formatCode) custom.set(id, a.formatCode);
  }
  const cellXfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfs) return result;
  let index = 0;
  for (const m of cellXfs[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attrsOf(m[0]).numFmtId || 0);
    if (builtin.has(id)) {
      result.add(index);
    } else if (custom.has(id)) {
      const code = custom.get(id)!.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
      if (/[ymdhs]/i.test(code)) result.add(index);
    }
    index++;
  }
  return result;
}

function parseSheet(xml: string, shared: string[], dateStyles: Set<number>, maxRows: number): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let sequential = 0;
    for (const token of rowMatch[1].matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const tag = token[0];
      const attrs = attrsOf(tag);
      const index = columnIndex(attrs.r) ?? sequential;
      sequential = index + 1;
      const body = tag.endsWith('/>') ? '' : tag.replace(/^<c\b[^>]*>/, '').replace(/<\/c>$/, '');
      const type = attrs.t || '';
      let value = '';
      if (type === 'inlineStr') {
        value = richText(body);
      } else if (type === 's') {
        const raw = valueOf(body);
        const idx = raw === null ? -1 : Number.parseInt(raw, 10);
        value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
      } else if (type === 'str' || type === 'e' || type === 'd') {
        value = valueOf(body) ?? '';
      } else if (type === 'b') {
        value = valueOf(body) === '1' ? 'TRUE' : 'FALSE';
      } else {
        const raw = valueOf(body);
        if (raw === null) {
          value = '';
        } else if (attrs.s !== undefined && dateStyles.has(Number(attrs.s))) {
          value = excelSerialText(Number(raw));
        } else {
          value = raw;
        }
      }
      cells[index] = value.trim();
    }
    if (cells.some((v) => v !== undefined && v !== '')) {
      rows.push(cells.map((v) => v ?? ''));
      if (rows.length >= maxRows + 1) break;
    }
  }
  return rows;
}

function pickSheetPath(entries: ZipEntry[], workbook: string, rels: string): string {
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrsOf(m[0]);
    if (a.Id && a.Target) relMap.set(a.Id, a.Target);
  }
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrsOf(m[0]);
    const relId = a['r:id'];
    if (!relId) continue;
    const target = relMap.get(relId);
    if (!target) continue;
    const path = target.startsWith('/')
      ? target.slice(1)
      : target.startsWith('xl/')
        ? target
        : `xl/${target.replace(/^\.\//, '')}`;
    if (path.includes('/worksheets/')) return path;
  }
  const fallback = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(a.name.match(/(\d+)/)![1]) - Number(b.name.match(/(\d+)/)![1]))[0];
  return fallback?.name || '';
}

export async function parseXlsx(buf: ArrayBuffer, maxRows = 50_000): Promise<CsvTable> {
  const entries = readEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const decoder = new TextDecoder();

  const readText = async (name: string): Promise<string> => {
    const entry = byName.get(name);
    if (!entry) return '';
    const bytes = await readEntry(buf, entry);
    return decoder.decode(bytes);
  };

  const workbook = await readText('xl/workbook.xml');
  const rels = await readText('xl/_rels/workbook.xml.rels');
  const sheetPath = pickSheetPath(entries, workbook, rels);
  if (!sheetPath) throw new Error('no worksheet found');
  const sheetEntry = byName.get(sheetPath);
  if (sheetEntry && sheetEntry.compressedSize > MAX_SHEET_BYTES) throw new Error('worksheet is too large');

  const [sheetXml, sharedXml, stylesXml] = await Promise.all([
    readText(sheetPath),
    readText('xl/sharedStrings.xml'),
    readText('xl/styles.xml'),
  ]);

  const shared: string[] = [];
  for (const m of sharedXml.matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(m[1] ? richText(m[1]) : '');

  const rows = parseSheet(sheetXml, shared, dateStyleIndexes(stylesXml), maxRows);
  if (!rows.length) return { headers: [], rows: [], delimiter: ',' };

  const headers = rows[0].map((h, idx) => (h || `column_${idx + 1}`).trim());
  const out: Record<string, string>[] = [];
  for (const line of rows.slice(1)) {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (line[idx] ?? '').trim();
    });
    out.push(obj);
  }
  return { headers, rows: out, delimiter: ',' };
}
