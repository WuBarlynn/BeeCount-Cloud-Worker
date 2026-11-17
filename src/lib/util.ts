export class HttpError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

export const nowIso = (): string => new Date().toISOString();
export const uuid = (): string => crypto.randomUUID();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function err(status: number, detail: unknown): Response {
  return json({ detail }, status);
}

export function toInt(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function toFloat(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

export function sqlBool(v: unknown): number {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

export function parseJson<T = any>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  const e = normalizeEmail(email);
  const at = e.indexOf('@');
  return at > 0 && e.slice(at + 1).includes('.') && !e.includes(' ');
}

export async function readJson<T = Record<string, any>>(req: Request): Promise<T> {
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    // Be forgiving: some clients omit the header.
  }
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
}

export function isoToMs(value: unknown): number {
  if (!value) return 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

export function clampMonthStartDay(v: unknown): number {
  const n = toInt(v, 1);
  return Math.max(1, Math.min(28, n || 1));
}

export function clampIso(value: unknown, fallback = nowIso()): string {
  if (typeof value !== 'string') return fallback;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer> | string): Promise<string> {
  let input: BufferSource;
  if (typeof data === 'string') input = new TextEncoder().encode(data);
  else if (data instanceof Uint8Array) input = data;
  else input = data;
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function monthKey(iso: string, tzOffsetMinutes = 0, monthStartDay = 1): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const local = new Date(t + tzOffsetMinutes * 60_000);
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth() + 1;
  if (local.getUTCDate() < monthStartDay) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function localDateKey(iso: string, tzOffsetMinutes = 0): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + tzOffsetMinutes * 60_000);
  return d.toISOString().slice(0, 10);
}
