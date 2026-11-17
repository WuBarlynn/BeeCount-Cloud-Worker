import { Hono } from 'hono';
import type { AppContext } from './lib/auth';
import { jwtSecret, loadUser } from './lib/auth';
import { verifyJwt } from './lib/crypto';
import { HttpError, json, nowIso, toInt } from './lib/util';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/user';
import { syncRoutes } from './routes/sync';
import { writeRoutes } from './routes/write';
import { readRoutes } from './routes/read';
import { attachmentRoutes } from './routes/attachments';
import { importRoutes } from './routes/import';
import { sharingRoutes } from './routes/sharing';
import { adminRoutes } from './routes/admin';
import { aiRoutes } from './routes/ai';
import { mcpRoutes } from './routes/mcp';
import type { Env } from './env';

export { SyncHub } from './durable/sync-hub';

const app = new Hono<AppContext>();
const api = new Hono<AppContext>();

api.get('/version', (c) => json({ name: c.env.APP_NAME || 'BeeCount Cloud', version: c.env.APP_VERSION || '1.9.0-worker.1' }));
api.get('/web-config', () => json({ project_partnerships_enabled: false }));

api.route('/auth', authRoutes);
api.route('/sync', syncRoutes);
api.route('/write', writeRoutes);
api.route('/read', readRoutes);
api.route('/attachments', attachmentRoutes);
api.route('/import', importRoutes);
api.route('/admin', adminRoutes);
api.route('/ai', aiRoutes);
api.route('/mcp', mcpRoutes);
api.route('/', userRoutes);
api.route('/', sharingRoutes);

app.route('/api/v1', api);

app.get('/healthz', (c) => json({ status: 'ok' }));
app.get('/ready', (c) => json({ status: 'ready', time: nowIso() }));
app.get('/metrics', (c) =>
  new Response(`# HELP beecount_up Whether the worker answers\n# TYPE beecount_up gauge\nbeecount_up 1\n`, {
    headers: { 'content-type': 'text/plain; version=0.0.4' },
  }),
);

/* --------------------------------- websocket -------------------------------- */
app.get('/ws', async (c) => {
  const token = c.req.query('token') || '';
  if (!token) return new Response('missing token', { status: 401 });
  if (c.req.header('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
  const payload = await verifyJwt(token, jwtSecret(c.env));
  if (!payload || payload.type !== 'access') return new Response('unauthorized', { status: 401 });
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
  if (!scopes.includes('app_write') && !scopes.includes('web_write') && !scopes.includes('ops_write')) {
    return new Response('forbidden', { status: 403 });
  }
  const user = await loadUser(c.env, payload.sub);
  if (!user || !user.is_enabled) return new Response('unauthorized', { status: 401 });
  if (!c.env.SYNC_HUB) return new Response('websocket hub unavailable', { status: 503 });
  const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(`u:${user.id}`));
  return stub.fetch(c.req.raw);
});

/* ---------------------------------- fallback -------------------------------- */
app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return json({ detail: 'Not Found' }, 404);
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return new Response('Not Found', { status: 404 });
});

app.onError((err, c) => {
  if (err instanceof HttpError) return json({ detail: err.detail }, err.status);
  console.error('unhandled', err);
  return json({ detail: 'Internal Server Error' }, 500);
});

/* ----------------------------------- cron ---------------------------------- */
async function cleanup(env: Env): Promise<void> {
  const now = nowIso();
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`).bind(now, cutoff),
    env.DB.prepare(`DELETE FROM import_jobs WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM sync_push_idempotency WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM sync_push_log WHERE created_at < ?`).bind(new Date(Date.now() - 7 * 86400_000).toISOString()),
    env.DB.prepare(`DELETE FROM sync_changes WHERE created_at < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM audit_logs WHERE created_at < ?`).bind(new Date(Date.now() - 90 * 86400_000).toISOString()),
  ]);
}

async function bootstrapAdmin(env: Env): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) return;
  const any = await env.DB.prepare(`SELECT id FROM users LIMIT 1`).first();
  if (any) return;
  const { createUser } = await import('./lib/auth');
  await createUser(env, env.ADMIN_EMAIL, env.ADMIN_PASSWORD, true);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = {
      'access-control-allow-origin': request.headers.get('origin') || '*',
      'access-control-allow-headers': 'authorization, content-type, x-device-id, idempotency-key',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      vary: 'origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname.startsWith('/api/v1/auth/') && url.pathname !== '/api/v1/auth/logout') {
      ctx.waitUntil(bootstrapAdmin(env).catch(() => undefined));
    }

    const response = await app.fetch(request, env, ctx);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const out = new Response(response.body, response);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    return response;
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
