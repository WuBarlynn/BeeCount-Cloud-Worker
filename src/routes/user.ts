import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_OPS_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one, run } from '../lib/db';
import { broadcastToUser } from '../lib/changes';
import { HttpError, json, nowIso, parseJson, toInt, uuid } from '../lib/util';
import { hashToken } from '../lib/db';
import { verifyPassword } from '../lib/crypto';

export const userRoutes = new Hono<AppContext>();

userRoutes.use('*', async (c, next) => {
  // Avatars are loaded by <img src> without an Authorization header, matching
  // the upstream server where GET /profile/avatar/{user_id} is public.
  if (c.req.method === 'GET' && c.req.path.includes('/profile/avatar/')) return next();
  return authMiddleware()(c, next);
});
const readScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, SCOPE_OPS_WRITE);
const writeScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE, SCOPE_OPS_WRITE);
userRoutes.use('*', async (c, next) => {
  if (c.req.method === 'GET' && c.req.path.includes('/profile/avatar/')) return next();
  return readScope(c, next);
});

async function readBody(c: any): Promise<Record<string, any>> {
  const text = await c.req.raw.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
}

function profileOut(user: any, p: any) {
  const version = Number(p?.avatar_version || 0);
  return {
    user_id: user.id,
    email: user.email,
    display_name: p?.display_name ?? null,
    avatar_url: p?.avatar_file_id ? `/api/v1/profile/avatar/${user.id}?v=${version}` : null,
    avatar_version: version,
    income_is_red: p?.income_is_red == null ? null : !!p.income_is_red,
    theme_primary_color: p?.theme_primary_color ?? null,
    appearance: parseJson(p?.appearance_json, null),
    ai_config: parseJson(p?.ai_config_json, null),
    primary_currency: p?.primary_currency ?? null,
  };
}

async function loadProfile(env: AppContext['Bindings'], userId: string) {
  return one<any>(env.DB, `SELECT * FROM user_profiles WHERE user_id = ?`, userId);
}

/* ---------------------------------- profile --------------------------------- */
userRoutes.get('/profile/me', async (c) => {
  const auth = c.get('auth');
  return json(profileOut(auth.user, await loadProfile(c.env, auth.user.id)));
});

userRoutes.patch('/profile/me', writeScope, async (c) => {
  const auth = c.get('auth');
  const body = await readBody(c);
  const row = await loadProfile(c.env, auth.user.id);
  const now = nowIso();
  const fields: Record<string, unknown> = {
    display_name: body.display_name !== undefined ? body.display_name : row?.display_name ?? null,
    income_is_red: body.income_is_red !== undefined ? (body.income_is_red == null ? null : body.income_is_red ? 1 : 0) : row?.income_is_red ?? null,
    theme_primary_color: body.theme_primary_color !== undefined ? body.theme_primary_color : row?.theme_primary_color ?? null,
    appearance_json:
      body.appearance !== undefined
        ? body.appearance && Object.keys(body.appearance).length
          ? JSON.stringify(body.appearance)
          : null
        : row?.appearance_json ?? null,
    ai_config_json:
      body.ai_config !== undefined
        ? body.ai_config && Object.keys(body.ai_config).length
          ? JSON.stringify(body.ai_config)
          : null
        : row?.ai_config_json ?? null,
    primary_currency: body.primary_currency !== undefined ? String(body.primary_currency).toUpperCase() : row?.primary_currency ?? null,
    updated_at: now,
  };
  if (row) {
    await run(
      c.env.DB,
      `UPDATE user_profiles SET display_name=?, income_is_red=?, theme_primary_color=?, appearance_json=?,
       ai_config_json=?, primary_currency=?, updated_at=? WHERE user_id=?`,
      fields.display_name,
      fields.income_is_red,
      fields.theme_primary_color,
      fields.appearance_json,
      fields.ai_config_json,
      fields.primary_currency,
      now,
      auth.user.id,
    );
  } else {
    await run(
      c.env.DB,
      `INSERT INTO user_profiles (user_id, display_name, income_is_red, theme_primary_color, appearance_json,
        ai_config_json, primary_currency, avatar_version, updated_at) VALUES (?,?,?,?,?,?,?,0,?)`,
      auth.user.id,
      fields.display_name,
      fields.income_is_red,
      fields.theme_primary_color,
      fields.appearance_json,
      fields.ai_config_json,
      fields.primary_currency,
      now,
    );
  }
  const profile = await loadProfile(c.env, auth.user.id);
  await broadcastToUser(c.env, auth.user.id, {
    type: 'profile_change',
    avatar_version: profile?.avatar_version || 0,
    display_name: profile?.display_name ?? null,
    income_is_red: profile?.income_is_red == null ? null : !!profile.income_is_red,
    theme_primary_color: profile?.theme_primary_color ?? null,
    appearance: parseJson(profile?.appearance_json, null),
    primary_currency: profile?.primary_currency ?? null,
  });
  return json(profileOut(auth.user, profile));
});

userRoutes.post('/profile/avatar', writeScope, async (c) => {
  const auth = c.get('auth');
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Profile avatar file is required');
  if (!file.size) throw new HttpError(400, 'Profile avatar file is empty');
  if (file.size > 1024 * 1024) throw new HttpError(413, 'Profile avatar upload too large');
  const type = (file.type || '').toLowerCase();
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : file.name.toLowerCase().endsWith('.png') ? 'png' : file.name.toLowerCase().endsWith('.webp') ? 'webp' : 'jpg';
  const fileId = `avatar_${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
  const key = `avatars/${auth.user.id}/${fileId}`;
  if (!c.env.BUCKET) throw new HttpError(503, 'Attachment storage is not configured');
  await c.env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: type || 'image/jpeg' } });
  const row = await loadProfile(c.env, auth.user.id);
  const version = Number(row?.avatar_version || 0) + 1;
  if (row) {
    await run(c.env.DB, `UPDATE user_profiles SET avatar_file_id=?, avatar_version=?, updated_at=? WHERE user_id=?`, fileId, version, nowIso(), auth.user.id);
  } else {
    await run(c.env.DB, `INSERT INTO user_profiles (user_id, avatar_file_id, avatar_version, updated_at) VALUES (?,?,?,?)`, auth.user.id, fileId, version, nowIso());
  }
  const profile = await loadProfile(c.env, auth.user.id);
  await broadcastToUser(c.env, auth.user.id, { type: 'profile_change', avatar_version: version, display_name: profile?.display_name ?? null });
  return json(profileOut(auth.user, profile));
});

userRoutes.get('/profile/avatar/:userId', async (c) => {
  const userId = c.req.param('userId');
  const profile = await loadProfile(c.env, userId);
  if (!profile?.avatar_file_id) throw new HttpError(404, 'Profile avatar not found');
  if (!c.env.BUCKET) throw new HttpError(404, 'Profile avatar not found');
  const obj = await c.env.BUCKET.get(`avatars/${userId}/${profile.avatar_file_id}`);
  if (!obj) throw new HttpError(404, 'Profile avatar not found');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
  return new Response(obj.body, { headers });
});

userRoutes.get('/profile/mcp-calls', async () => json([]));

/* ------------------------------------ pats ---------------------------------- */
userRoutes.get('/profile/pats', async (c) => {
  const auth = c.get('auth');
  const rows = await all<any>(c.env.DB, `SELECT * FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC`, auth.user.id);
  return json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: parseJson(r.scopes_json, []),
      expires_at: r.expires_at ?? null,
      last_used_at: r.last_used_at ?? null,
      last_used_ip: null,
      created_at: r.created_at,
      revoked_at: r.revoked_at ?? null,
    })),
  );
});

userRoutes.post('/profile/pats', writeScope, async (c) => {
  const auth = c.get('auth');
  const body = await readBody(c);
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(422, 'name is required');
  const scopes: string[] = Array.isArray(body.scopes) && body.scopes.length ? body.scopes.map(String) : ['mcp:read'];
  const bad = scopes.filter((s) => !['mcp:read', 'mcp:write'].includes(s));
  if (bad.length) throw new HttpError(422, `Unknown scopes: ${bad.join(',')}`);
  const raw = [...crypto.getRandomValues(new Uint8Array(32))];
  const token = `bcmcp_${btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const days = body.expires_in_days === null ? null : toInt(body.expires_in_days, 90);
  const expiresAt = days === null ? null : new Date(Date.now() + Math.max(1, Math.min(3650, days)) * 86400_000).toISOString();
  const id = uuid();
  await run(
    c.env.DB,
    `INSERT INTO personal_access_tokens (id, user_id, name, token_hash, prefix, scopes_json, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    auth.user.id,
    name.slice(0, 128),
    await hashToken(token),
    token.slice(0, 14),
    JSON.stringify(scopes),
    expiresAt,
    nowIso(),
  );
  return json({ id, name, token, prefix: token.slice(0, 14), scopes, expires_at: expiresAt, created_at: nowIso() }, 201);
});

userRoutes.patch('/profile/pats/:id', writeScope, async (c) => {
  const auth = c.get('auth');
  const body = await readBody(c);
  const id = c.req.param('id');
  const row = await one<any>(c.env.DB, `SELECT * FROM personal_access_tokens WHERE id = ? AND user_id = ?`, id, auth.user.id);
  if (!row) throw new HttpError(404, 'Token not found');
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 128) : row.name;
  const scopes = Array.isArray(body.scopes) ? body.scopes.map(String) : parseJson(row.scopes_json, []);
  await run(c.env.DB, `UPDATE personal_access_tokens SET name = ?, scopes_json = ? WHERE id = ?`, name, JSON.stringify(scopes), id);
  return json({ ok: true });
});

userRoutes.delete('/profile/pats/:id', writeScope, async (c) => {
  const auth = c.get('auth');
  const res = await run(c.env.DB, `UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?`, nowIso(), c.req.param('id'), auth.user.id);
  if ((res.meta?.changes ?? 0) === 0) throw new HttpError(404, 'Token not found');
  return json({ ok: true });
});

/* ----------------------------------- devices -------------------------------- */
userRoutes.get('/devices', async (c) => {
  const auth = c.get('auth');
  const rows = await all<any>(c.env.DB, `SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`, auth.user.id);
  const view = c.req.query('view') || 'deduped';
  const map = (d: any, count: number) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    app_version: d.app_version ?? null,
    os_version: d.os_version ?? null,
    device_model: d.device_model ?? null,
    last_ip: d.last_ip ?? null,
    last_seen_at: d.last_seen_at,
    created_at: d.created_at,
    session_count: count,
  });
  if (view === 'sessions') return json(rows.map((d) => map(d, 1)));
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = [r.name, r.platform, r.device_model, r.os_version, r.app_version].map((v) => String(v || '').toLowerCase()).join('|');
    const bucket = groups.get(key) || [];
    bucket.push(r);
    groups.set(key, bucket);
  }
  const out = [...groups.values()].map((bucket) => map(bucket[0], bucket.length));
  out.sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
  return json(out);
});

userRoutes.post('/devices/:id/revoke', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const row = await one<any>(c.env.DB, `SELECT * FROM devices WHERE id = ? AND user_id = ?`, id, auth.user.id);
  if (!row) throw new HttpError(404, 'Device not found');
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE devices SET revoked_at = ? WHERE id = ?`).bind(now, id),
    c.env.DB.prepare(`UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`).bind(now, auth.user.id, id),
  ]);
  return json({ ok: true, device_id: id });
});
