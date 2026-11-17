import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import {
  accessTtl,
  authMiddleware,
  createUser,
  issueSession,
  jwtSecret,
  loadUser,
  refreshTtlDays,
  upsertDevice,
  verifyRecoveryCode,
  regenerateRecoveryCodes,
  SCOPE_APP_WRITE,
  SCOPE_OPS_WRITE,
  SCOPE_WEB_READ,
  SCOPE_WEB_WRITE,
} from '../lib/auth';
import { hashPassword, signJwt, verifyJwt, verifyPassword, verifyTotp, otpauthUri, randomBase32, encryptSecret, decryptSecret } from '../lib/crypto';
import { all, hashToken, one, run } from '../lib/db';
import { HttpError, err, json, normalizeEmail, nowIso, readJson, toInt, uuid, validEmail } from '../lib/util';
import type { AuthUser, Env } from '../env';

export const authRoutes = new Hono<AppContext>();

const resolveScopes = (clientType: string): string[] =>
  clientType === 'web' ? [SCOPE_WEB_READ, SCOPE_WEB_WRITE, SCOPE_OPS_WRITE] : [SCOPE_APP_WRITE];

const userOut = (u: AuthUser) => ({ id: u.id, email: u.email, is_admin: !!u.is_admin });

const clientIp = (c: any): string | null =>
  c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null;

// Very small in-isolate rate limiter. Cloudflare runs many isolates, so this is
// only a speed bump for scripted attempts, not a hard guarantee.
const loginBuckets = new Map<string, number[]>();
function rateLimit(key: string, max = 20, windowMs = 60_000): void {
  const now = Date.now();
  const bucket = (loginBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (bucket.length >= max) throw new HttpError(429, 'Too many requests');
  bucket.push(now);
  loginBuckets.set(key, bucket);
}

async function issueTokens(
  env: Env,
  user: AuthUser,
  deviceId: string,
  clientType: string,
  scopes?: string[],
) {
  const s = scopes?.length ? scopes : resolveScopes(clientType);
  const session = await issueSession(env, user, { deviceId, scopes: s, clientType });
  return {
    user: userOut(user),
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    device_id: session.device_id,
    scopes: session.scopes,
  };
}

function deviceArgs(body: Record<string, any>) {
  return {
    device_id: body.device_id,
    device_name: body.device_name,
    platform: body.platform,
    app_version: body.app_version,
    os_version: body.os_version,
    device_model: body.device_model,
  };
}

/* ---------------------------------- register --------------------------------- */
authRoutes.post('/register', async (c) => {
  const body = await readJson(c.req.raw);
  rateLimit(`register:${clientIp(c) || 'x'}`, 10);
  // Closed by default: a fresh deploy must not expose public sign-up.
  if (String(c.env.ALLOW_REGISTRATION ?? 'false').toLowerCase() !== 'true') throw new HttpError(403, 'Registration disabled');
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) throw new HttpError(422, 'Invalid email format');
  const password = String(body.password || '');
  if (password.length < 6) throw new HttpError(422, 'Password must be at least 6 characters');
  if (await one(c.env.DB, `SELECT id FROM users WHERE email = ?`, email)) throw new HttpError(409, 'Email already exists');

  const isFirst = !(await one(c.env.DB, `SELECT id FROM users LIMIT 1`));
  const user = await createUser(c.env, email, password, isFirst);
  const deviceId = await upsertDevice(c.env, user.id, deviceArgs(body), clientIp(c));
  return json(await issueTokens(c.env, user, deviceId, body.client_type === 'web' ? 'web' : 'app'));
});

/* ---------------------- bootstrap admin from env secrets --------------------- */
// On a brand-new database, ADMIN_EMAIL + ADMIN_PASSWORD create the first account
// so an open /register can never be claimed by a stranger. Idempotent: it only
// runs while the users table is still empty.
async function ensureBootstrapAdmin(env: Env): Promise<void> {
  const email = normalizeEmail(env.ADMIN_EMAIL || '');
  const password = String(env.ADMIN_PASSWORD || '');
  if (!validEmail(email) || password.length < 6) return;
  if (await one(env.DB, `SELECT id FROM users LIMIT 1`)) return;
  try {
    await createUser(env, email, password, true);
  } catch {
    // Another isolate won the race; the account exists now, carry on.
  }
}

/* ----------------------------------- login ----------------------------------- */
authRoutes.post('/login', async (c) => {
  const body = await readJson(c.req.raw);
  rateLimit(`login:${clientIp(c) || 'x'}`, 20);
  const email = normalizeEmail(body.email);
  await ensureBootstrapAdmin(c.env);
  const row = await one<any>(c.env.DB, `SELECT * FROM users WHERE email = ?`, email);
  if (!row || !(await verifyPassword(String(body.password || ''), row.password_hash))) {
    throw new HttpError(401, 'Invalid credentials');
  }
  if (!row.is_enabled) throw new HttpError(403, 'User disabled');

  const clientType = body.client_type === 'web' ? 'web' : 'app';
  if (row.totp_enabled_at) {
    const challenge = await signJwt({ sub: row.id, scopes: [], ct: clientType, type: '2fa' }, jwtSecret(c.env), 300);
    return json({ requires_2fa: true, challenge_token: challenge, available_methods: ['totp', 'recovery_code'] });
  }
  const deviceId = await upsertDevice(c.env, row.id, deviceArgs(body), clientIp(c));
  const tokens = await issueTokens(c.env, row as AuthUser, deviceId, clientType);
  return json({ requires_2fa: false, ...tokens });
});

/* ---------------------------------- refresh ---------------------------------- */
authRoutes.post('/refresh', async (c) => {
  const body = await readJson(c.req.raw);
  const token = String(body.refresh_token || '');
  const payload = await verifyJwt(token, jwtSecret(c.env));
  if (!payload || payload.type !== 'refresh') throw new HttpError(401, 'Invalid refresh token');
  const clientType = payload.ct === 'web' ? 'web' : 'app';
  const scopes = Array.isArray(payload.scopes) && payload.scopes.length ? payload.scopes : resolveScopes(clientType);

  const row = await one<any>(
    c.env.DB,
    `SELECT * FROM refresh_tokens WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    await hashToken(token),
    payload.sub,
    nowIso(),
  );
  if (!row) throw new HttpError(401, 'Refresh token expired');
  const user = await loadUser(c.env, payload.sub);
  if (!user) throw new HttpError(401, 'User not found');
  if (!user.is_enabled) throw new HttpError(403, 'User disabled');

  let device = row.device_id
    ? await one<any>(c.env.DB, `SELECT * FROM devices WHERE id = ? AND user_id = ?`, row.device_id, user.id)
    : null;
  if (device?.revoked_at) throw new HttpError(401, 'Device revoked');
  const deviceId = device
    ? (await run(c.env.DB, `UPDATE devices SET last_seen_at = ?, last_ip = COALESCE(?, last_ip) WHERE id = ?`, nowIso(), clientIp(c), device.id),
      device.id)
    : await upsertDevice(c.env, user.id, { device_id: row.device_id || undefined }, clientIp(c));

  await run(c.env.DB, `UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`, nowIso(), row.id);
  return json(await issueTokens(c.env, user, deviceId, clientType, scopes));
});

/* ----------------------------------- logout ---------------------------------- */
authRoutes.post('/logout', authMiddleware(), async (c) => {
  const body = await readJson(c.req.raw).catch(() => ({}) as any);
  const auth = c.get('auth');
  let revoked = false;
  if (body.refresh_token) {
    const res = await run(
      c.env.DB,
      `UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL`,
      nowIso(),
      auth.user.id,
      await hashToken(String(body.refresh_token)),
    );
    revoked = (res.meta?.changes ?? 0) > 0;
  }
  return json({ ok: true, refresh_revoked: revoked });
});

/* ------------------------------------ 2FA ------------------------------------ */
const twoFa = new Hono<AppContext>();
twoFa.use('*', async (c, next) => {
  // /2fa/verify exchanges a short-lived challenge token, so it is public.
  if (c.req.path.endsWith('/2fa/verify')) return next();
  return authMiddleware()(c, next);
});
twoFa.get('/status', async (c) => {
  const u = c.get('auth').user;
  const row = await one<any>(c.env.DB, `SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?`, u.id);
  return json({ enabled: !!row?.totp_enabled_at, enabled_at: row?.totp_enabled_at ?? null });
});

twoFa.post('/setup', async (c) => {
  const u = c.get('auth').user;
  const row = await one<any>(c.env.DB, `SELECT totp_enabled_at FROM users WHERE id = ?`, u.id);
  if (row?.totp_enabled_at) throw new HttpError(409, '2FA already enabled. Disable first to re-setup.');
  const secret = randomBase32(32);
  await run(c.env.DB, `UPDATE users SET totp_secret = ?, totp_enabled_at = NULL, updated_at = ? WHERE id = ?`, await encryptSecret(secret, jwtSecret(c.env)), nowIso(), u.id);
  return json({ secret, qr_code_uri: otpauthUri(secret, u.email), expires_in: 300 });
});

twoFa.post('/confirm', async (c) => {
  const u = c.get('auth').user;
  const body = await readJson(c.req.raw);
  const row = await one<any>(c.env.DB, `SELECT totp_secret, totp_enabled_at FROM users WHERE id = ?`, u.id);
  if (row?.totp_enabled_at) throw new HttpError(409, '2FA already enabled.');
  const secret = await decryptSecret(row?.totp_secret || '', jwtSecret(c.env));
  if (!secret) throw new HttpError(400, 'No pending 2FA setup. Call /2fa/setup first.');
  if (!(await verifyTotp(secret, String(body.code || '')))) throw new HttpError(400, 'Invalid code');
  const now = nowIso();
  await run(c.env.DB, `UPDATE users SET totp_enabled_at = ?, updated_at = ? WHERE id = ?`, now, now, u.id);
  const codes = await regenerateRecoveryCodes(c.env, u.id);
  return json({ enabled: true, recovery_codes: codes });
});

twoFa.post('/verify', async (c) => {
  const body = await readJson(c.req.raw);
  rateLimit(`2fa:${(clientIp(c) || 'x') + String(body.challenge_token || '').slice(-24)}`, 8);
  const payload = await verifyJwt(String(body.challenge_token || ''), jwtSecret(c.env));
  if (!payload || payload.type !== '2fa') throw new HttpError(401, 'Invalid challenge token');
  const user = await loadUser(c.env, payload.sub);
  if (!user || !user.is_enabled) throw new HttpError(401, 'User not found');

  const clientType = body.client_type === 'web' ? 'web' : payload.ct === 'web' ? 'web' : 'app';
  const method = String(body.method || 'totp');
  if (method === 'recovery_code') {
    if (!(await verifyRecoveryCode(c.env, user.id, String(body.code || '')))) throw new HttpError(401, 'Invalid recovery code');
  } else {
    const row = await one<any>(c.env.DB, `SELECT totp_secret FROM users WHERE id = ?`, user.id);
    const secret = await decryptSecret(row?.totp_secret || '', jwtSecret(c.env));
    if (!secret || !(await verifyTotp(secret, String(body.code || '')))) throw new HttpError(401, 'Invalid code');
  }
  const deviceId = await upsertDevice(c.env, user.id, deviceArgs(body), clientIp(c));
  const tokens = await issueTokens(c.env, user, deviceId, clientType);
  return json({ requires_2fa: false, ...tokens });
});

twoFa.post('/disable', async (c) => {
  const u = c.get('auth').user;
  const body = await readJson(c.req.raw);
  const row = await one<any>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row?.totp_enabled_at) throw new HttpError(400, '2FA is not enabled');
  if (!(await verifyPassword(String(body.password || ''), row.password_hash))) throw new HttpError(401, 'Invalid password');
  const secret = await decryptSecret(row.totp_secret || '', jwtSecret(c.env));
  if (!secret || !(await verifyTotp(secret, String(body.code || '')))) throw new HttpError(401, 'Invalid code');
  await run(c.env.DB, `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), u.id);
  await run(c.env.DB, `DELETE FROM recovery_codes WHERE user_id = ?`, u.id);
  return json({ disabled: true });
});

twoFa.post('/recovery-codes/regenerate', async (c) => {
  const u = c.get('auth').user;
  const body = await readJson(c.req.raw);
  const row = await one<any>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!row?.totp_enabled_at) throw new HttpError(400, '2FA is not enabled');
  if (!(await verifyPassword(String(body.password || ''), row.password_hash))) throw new HttpError(401, 'Invalid password');
  const secret = await decryptSecret(row.totp_secret || '', jwtSecret(c.env));
  if (!secret || !(await verifyTotp(secret, String(body.code || '')))) throw new HttpError(401, 'Invalid code');
  return json({ recovery_codes: await regenerateRecoveryCodes(c.env, u.id) });
});

/* ------------------------- password change (self-service) --------------------- */
// Upstream only exposes admin password reset; keep a small self endpoint used by
// the web settings page fallback.
authRoutes.post('/password', authMiddleware(), async (c) => {
  const u = c.get('auth').user;
  const body = await readJson(c.req.raw);
  const row = await one<any>(c.env.DB, `SELECT * FROM users WHERE id = ?`, u.id);
  if (!(await verifyPassword(String(body.current_password || ''), row?.password_hash || ''))) throw new HttpError(401, 'Invalid password');
  const next = String(body.new_password || '');
  if (next.length < 6) throw new HttpError(422, 'Password must be at least 6 characters');
  await run(c.env.DB, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, await hashPassword(next), nowIso(), u.id);
  return json({ ok: true });
});

authRoutes.route('/2fa', twoFa);

export { resolveScopes, issueTokens, userOut };
