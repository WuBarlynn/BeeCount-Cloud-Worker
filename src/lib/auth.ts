import type { Context, Next } from 'hono';
import type { AuthInfo, AuthUser, Env } from '../env';
import { HttpError, err, nowIso, normalizeEmail, uuid, toInt } from './util';
import { hashPassword, signJwt, verifyJwt, verifyPassword, verifyTotp, randomRecoveryCodes } from './crypto';
import { hashToken, one, run, all } from './db';

export type AppContext = { Bindings: Env; Variables: { auth: AuthInfo } };

export const SCOPE_APP_WRITE = 'app_write';
export const SCOPE_WEB_READ = 'web_read';
export const SCOPE_WEB_WRITE = 'web_write';
export const SCOPE_OPS_WRITE = 'ops_write';

export function jwtSecret(env: Env): string {
  return env.JWT_SECRET || 'beecount-dev-secret-change-me';
}

export function accessTtl(env: Env): number {
  return Math.max(60, toInt(env.ACCESS_TOKEN_TTL, 1800));
}

export function refreshTtlDays(env: Env): number {
  return Math.max(1, toInt(env.REFRESH_TOKEN_TTL_DAYS, 30));
}

export async function loadUser(env: Env, id: string): Promise<AuthUser | null> {
  return one<AuthUser>(
    env.DB,
    `SELECT id, email, is_admin, is_enabled, totp_enabled_at, created_at FROM users WHERE id = ?`,
    id,
  );
}

export async function issueSession(
  env: Env,
  user: AuthUser,
  opts: { deviceId: string; scopes: string[]; clientType: string },
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scopes: string[]; device_id: string }> {
  const expiresIn = accessTtl(env);
  const access = await signJwt(
    { sub: user.id, scopes: opts.scopes, ct: opts.clientType, type: 'access', email: user.email },
    jwtSecret(env),
    expiresIn,
  );
  const refresh = await signJwt(
    { sub: user.id, scopes: opts.scopes, ct: opts.clientType, type: 'refresh', jti: uuid() },
    jwtSecret(env),
    refreshTtlDays(env) * 86400,
  );
  const expiresAt = new Date(Date.now() + refreshTtlDays(env) * 86400_000).toISOString();
  await run(
    env.DB,
    `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, scopes_json, client_type, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    uuid(),
    user.id,
    opts.deviceId,
    await hashToken(refresh),
    JSON.stringify(opts.scopes),
    opts.clientType,
    expiresAt,
    nowIso(),
  );
  return { access_token: access, refresh_token: refresh, expires_in: expiresIn, scopes: opts.scopes, device_id: opts.deviceId };
}

export async function authenticate(c: Context<AppContext>): Promise<AuthInfo> {
  const header = c.req.header('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Not authenticated');

  let auth: AuthInfo | null = null;

  if (token.startsWith('bcmcp_') || token.startsWith('bc_pat_')) {
    const row = await one<any>(
      c.env.DB,
      `SELECT p.id, p.user_id, p.scopes_json, p.revoked_at, p.expires_at, u.email, u.is_admin, u.is_enabled, u.totp_enabled_at, u.created_at
       FROM personal_access_tokens p JOIN users u ON u.id = p.user_id WHERE p.token_hash = ?`,
      await hashToken(token),
    );
    if (!row || row.revoked_at || !row.is_enabled) throw new HttpError(401, 'Invalid token');
    if (row.expires_at && row.expires_at <= nowIso()) throw new HttpError(401, 'Token expired');
    // Upstream contract: a PAT only ever opens the MCP endpoint.
    if (!c.req.path.startsWith('/api/v1/mcp')) throw new HttpError(403, 'Personal access tokens can only be used on /api/v1/mcp');
    await run(c.env.DB, `UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?`, nowIso(), row.id);
    auth = {
      user: {
        id: row.user_id,
        email: row.email,
        is_admin: !!row.is_admin,
        is_enabled: !!row.is_enabled,
        totp_enabled_at: row.totp_enabled_at ?? null,
        created_at: row.created_at,
      },
      scopes: JSON.parse(row.scopes_json || '[]'),
      clientType: 'pat',
      via: 'pat',
    };
  } else {
    const payload = await verifyJwt(token, jwtSecret(c.env));
    if (!payload || payload.type !== 'access') throw new HttpError(401, 'Invalid token');
    const user = await loadUser(c.env, payload.sub);
    if (!user || !user.is_enabled) throw new HttpError(401, 'User disabled');
    auth = {
      user,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
      clientType: payload.ct || 'app',
      via: 'jwt',
      tokenExp: payload.exp,
    };
  }

  const deviceId = c.req.header('x-device-id');
  if (deviceId) {
    await run(
      c.env.DB,
      `UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?`,
      nowIso(),
      deviceId,
      auth.user.id,
    ).catch(() => undefined);
  }
  return auth;
}

export function authMiddleware() {
  return async (c: Context<AppContext>, next: Next) => {
    try {
      const auth = await authenticate(c);
      c.set('auth', auth);
      await next();
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.detail);
      return err(401, 'Not authenticated');
    }
  };
}

export function hasAnyScope(auth: AuthInfo, ...scopes: string[]): boolean {
  if (auth.user.is_admin && scopes.includes(SCOPE_OPS_WRITE)) return true;
  return scopes.some((s) => auth.scopes.includes(s));
}

export function requireScopes(...scopes: string[]) {
  return async (c: Context<AppContext>, next: Next) => {
    const auth = c.get('auth');
    if (!auth || !hasAnyScope(auth, ...scopes)) {
      return err(403, 'Insufficient scope');
    }
    await next();
  };
}

export function requireAdmin() {
  return async (c: Context<AppContext>, next: Next) => {
    const auth = c.get('auth');
    if (!auth?.user.is_admin) return err(403, 'Admin required');
    await next();
  };
}

export async function upsertDevice(
  env: Env,
  userId: string,
  body: Record<string, any>,
  ip?: string | null,
): Promise<string> {
  let deviceId = typeof body.device_id === 'string' && body.device_id.trim() ? body.device_id.trim() : uuid();
  const existing = await one<any>(env.DB, `SELECT id, user_id FROM devices WHERE id = ?`, deviceId);
  if (existing && existing.user_id !== userId) deviceId = uuid();
  const now = nowIso();
  const prior = await one<any>(env.DB, `SELECT id FROM devices WHERE id = ? AND user_id = ?`, deviceId, userId);
  if (prior) {
    await run(
      env.DB,
      `UPDATE devices SET name=COALESCE(?,name), platform=COALESCE(?,platform), app_version=COALESCE(?,app_version),
       os_version=COALESCE(?,os_version), device_model=COALESCE(?,device_model), last_ip=COALESCE(?,last_ip),
       last_seen_at=?, revoked_at=NULL WHERE id=?`,
      body.device_name ?? null,
      body.platform ?? null,
      body.app_version ?? null,
      body.os_version ?? null,
      body.device_model ?? null,
      ip ?? null,
      now,
      deviceId,
    );
  } else {
    await run(
      env.DB,
      `INSERT INTO devices (id,user_id,name,platform,app_version,os_version,device_model,last_ip,last_seen_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      deviceId,
      userId,
      body.device_name || 'Unknown Device',
      body.platform || 'unknown',
      body.app_version ?? null,
      body.os_version ?? null,
      body.device_model ?? null,
      ip ?? null,
      now,
      now,
    );
  }
  return deviceId;
}

export async function createUser(
  env: Env,
  email: string,
  password: string,
  isAdmin = false,
): Promise<AuthUser> {
  const id = uuid();
  const now = nowIso();
  await run(
    env.DB,
    `INSERT INTO users (id,email,password_hash,is_admin,is_enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`,
    id,
    normalizeEmail(email),
    await hashPassword(password),
    isAdmin ? 1 : 0,
    now,
    now,
  );
  await run(env.DB, `INSERT INTO user_profiles (user_id, avatar_version, updated_at) VALUES (?,0,?)`, id, now);
  return (await loadUser(env, id))!;
}

export async function verifyRecoveryCode(env: Env, userId: string, code: string): Promise<boolean> {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized) return false;
  const row = await one<any>(
    env.DB,
    `SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    userId,
    await hashToken(normalized),
  );
  if (!row) return false;
  await run(env.DB, `UPDATE recovery_codes SET used_at = ? WHERE id = ?`, nowIso(), row.id);
  return true;
}

export async function regenerateRecoveryCodes(env: Env, userId: string): Promise<string[]> {
  const codes = randomRecoveryCodes(8);
  await run(env.DB, `DELETE FROM recovery_codes WHERE user_id = ?`, userId);
  for (const code of codes) {
    await run(
      env.DB,
      `INSERT INTO recovery_codes (id,user_id,code_hash,created_at) VALUES (?,?,?,?)`,
      uuid(),
      userId,
      await hashToken(code),
      nowIso(),
    );
  }
  return codes;
}

export { verifyPassword, verifyTotp, all };
