import { b64url, b64urlDecode, timingSafeEqualStr, toInt } from './util';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */
// PBKDF2-SHA256. Iterations are kept low enough for the Workers free plan's
// 10 ms CPU budget; raise with care (README explains the trade-off).
const PBKDF2_ITERATIONS = 12_000;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']),
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = toInt(parts[1], PBKDF2_ITERATIONS);
  const salt = fromB64(parts[2]);
  const expected = parts[3];
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']),
    256,
  );
  const actual = toB64(new Uint8Array(bits));
  return timingSafeEqualStr(actual, expected);
}

/* ------------------------------------------------------------------ */
/* JWT (HS256)                                                         */
/* ------------------------------------------------------------------ */
export type JwtPayload = {
  sub: string;
  scopes: string[];
  ct?: string;
  type?: 'access' | 'refresh' | '2fa';
  iat?: number;
  exp?: number;
  jti?: string;
  email?: string;
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signJwt(payload: JwtPayload, secret: string, ttlSeconds: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload, iat, exp: iat + ttlSeconds };
  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const data = `${head}.${b64url(enc.encode(JSON.stringify(body)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(parts[2]),
      enc.encode(data),
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1]))) as JwtPayload;
    if (!payload.sub) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000) - 5) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* TOTP (RFC 6238, SHA-1, 30s, 6 digits)                              */
/* ------------------------------------------------------------------ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function randomBase32(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += B32[b % 32];
  return out;
}

function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function totpAt(secretB32: string, counter: number): Promise<string> {
  const key = base32Decode(secretB32);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const sig = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']), msg);
  const h = new Uint8Array(sig);
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export async function verifyTotp(secretB32: string, code: string, window = 1): Promise<boolean> {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(Date.now() / 30_000);
  for (let d = -window; d <= window; d++) {
    if ((await totpAt(secretB32, counter + d)) === normalized) return true;
  }
  return false;
}

export function otpauthUri(secret: string, email: string, issuer = 'BeeCount Cloud'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function randomRecoveryCodes(count = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    out.push(`${hex.slice(0, 5)}-${hex.slice(5, 10)}`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Symmetric secret storage (TOTP secret at rest)                      */
/* ------------------------------------------------------------------ */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`beecount-totp:${secret}`));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain));
  return `v1:${b64url(iv)}:${b64url(new Uint8Array(ct))}`;
}

export async function decryptSecret(stored: string, secret: string): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith('v1:')) return stored; // legacy plaintext
  const [, ivPart, ctPart] = stored.split(':');
  if (!ivPart || !ctPart) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(ivPart) },
      await aesKey(secret),
      b64urlDecode(ctPart),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
