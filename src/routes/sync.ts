import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, latestLedgerChangeId, one, run } from '../lib/db';
import { HttpError, json, nowIso, parseJson, toInt } from '../lib/util';
import { createLedger, getLedgerByExternal, listAccessibleLedgers, type LedgerRow } from '../lib/ledger';
import { buildSnapshot } from '../lib/snapshot';
import { applyPush } from '../lib/push';

export const syncRoutes = new Hono<AppContext>();

syncRoutes.use('*', authMiddleware());
const anyRead = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ);
const appWrite = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE);

const USER_GLOBAL_SENTINEL = '__user_global__';

function iso(value: unknown): string {
  if (!value) return nowIso();
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso();
}

function clampFuture(value: string, nowMs: number): string {
  const t = Date.parse(value);
  return new Date(Math.min(t, nowMs + 5000)).toISOString();
}

async function requireDevice(env: AppContext['Bindings'], userId: string, deviceId: string): Promise<void> {
  const device = await one<any>(
    env.DB,
    `SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    deviceId,
    userId,
  );
  if (!device) throw new HttpError(401, 'Invalid device');
}

/* ----------------------------------- push ----------------------------------- */
syncRoutes.post('/push', appWrite, async (c) => {
  const auth = c.get('auth');
  const body = await readBody(c);
  const result = await applyPush(c.env, auth.user, body as any);
  return json(result);
});

/* ----------------------------------- pull ----------------------------------- */
syncRoutes.get('/pull', anyRead, async (c) => {
  const auth = c.get('auth');
  const since = Math.max(0, toInt(c.req.query('since'), 0));
  const deviceId = c.req.query('device_id') || null;
  const limit = Math.min(5000, Math.max(1, toInt(c.req.query('limit'), 1000)));

  if (deviceId) await requireDevice(c.env, auth.user.id, deviceId);

  const ledgers = await listAccessibleLedgers(c.env, auth.user.id);
  const ledgerById = new Map(ledgers.map((l) => [l.id, l.external_id]));
  const ledgerIds = ledgers.map((l) => l.id);

  const ph = ledgerIds.length ? ledgerIds.map(() => '?').join(',') : null;
  const scopeSql = ph
    ? `AND ((c.scope='ledger' AND c.ledger_id IN (${ph})) OR (c.scope='user' AND c.user_id=?))`
    : `AND (c.scope='user' AND c.user_id=?)`;
  const binds: unknown[] = [...ledgerIds, auth.user.id, since];
  let deviceSql = '';
  if (deviceId) {
    deviceSql = `AND (c.updated_by_device_id IS NULL OR c.updated_by_device_id != ?)`;
  }

  const rows = await all<any>(
    c.env.DB,
    `SELECT c.* FROM sync_changes c
     WHERE c.change_id > ? ${scopeSql} ${deviceSql}
     ORDER BY c.change_id ASC LIMIT ?`,
    since,
    ...binds.slice(0, -1),
    ...(deviceId ? [deviceId] : []),
    limit + 1,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Backfill actor ids for legacy transaction payloads.
  const txPending = page.filter(
    (r) => r.entity_type === 'transaction' && r.ledger_id && (!JSON.parse(r.payload_json || '{}').createdByUserId || !JSON.parse(r.payload_json || '{}').updatedByUserId),
  );
  const actorByKey = new Map<string, { created: string | null; edited: string | null }>();
  if (txPending.length) {
    const ids = [...new Set(txPending.map((r) => r.entity_sync_id))];
    const lids = [...new Set(txPending.map((r) => r.ledger_id))];
    const proj = await all<any>(
      c.env.DB,
      `SELECT ledger_id, sync_id, created_by_user_id, last_edited_by_user_id FROM read_tx
       WHERE ledger_id IN (${lids.map(() => '?').join(',')}) AND sync_id IN (${ids.map(() => '?').join(',')})`,
      ...lids,
      ...ids,
    );
    for (const p of proj) actorByKey.set(`${p.ledger_id}:${p.sync_id}`, { created: p.created_by_user_id, edited: p.last_edited_by_user_id });
  }

  const changes = page.map((r) => {
    const payload = parseJson<Record<string, any>>(r.payload_json, {});
    if (r.entity_type === 'transaction') {
      const actor = actorByKey.get(`${r.ledger_id}:${r.entity_sync_id}`);
      if (actor?.created && !payload.createdByUserId) payload.createdByUserId = actor.created;
      if (actor?.edited && !payload.updatedByUserId) payload.updatedByUserId = actor.edited;
    }
    return {
      change_id: r.change_id,
      ledger_id: r.scope === 'user' ? USER_GLOBAL_SENTINEL : ledgerById.get(r.ledger_id) || r.ledger_id,
      entity_type: r.entity_type,
      entity_sync_id: r.entity_sync_id,
      action: r.action,
      payload,
      updated_at: r.updated_at,
      updated_by_device_id: r.updated_by_device_id ?? null,
      scope: r.scope || 'ledger',
    };
  });

  const serverCursor = page.length ? Number(page[page.length - 1].change_id) : since;

  if (deviceId && page.length) {
    const perLedger = new Map<string, number>();
    for (const ch of changes) perLedger.set(ch.ledger_id, Math.max(perLedger.get(ch.ledger_id) || 0, ch.change_id));
    for (const [key, cursor] of perLedger) {
      await run(
        c.env.DB,
        `INSERT INTO sync_cursors (user_id, device_id, ledger_external_id, last_cursor, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id, device_id, ledger_external_id) DO UPDATE SET
           last_cursor = MAX(sync_cursors.last_cursor, excluded.last_cursor), updated_at = excluded.updated_at`,
        auth.user.id,
        deviceId,
        key,
        cursor,
        nowIso(),
      );
    }
  }

  return json({ changes, server_cursor: serverCursor, has_more: hasMore });
});

/* ----------------------------------- full ----------------------------------- */
syncRoutes.get('/full', anyRead, async (c) => {
  const auth = c.get('auth');
  const externalId = String(c.req.query('ledger_id') || '');
  if (!externalId) throw new HttpError(422, 'ledger_id is required');
  const ledgers = await listAccessibleLedgers(c.env, auth.user.id);
  const latestCursor = ledgers.length ? Math.max(0, ...(await Promise.all(ledgers.map((l) => latestLedgerChangeId(c.env.DB, l.id))))) : 0;

  const ledger = await getLedgerByExternal(c.env, auth.user.id, externalId);
  if (!ledger) return json({ ledger_id: externalId, snapshot: null, latest_cursor: latestCursor });

  const ledgerChangeId = await latestLedgerChangeId(c.env.DB, ledger.id);
  if (ledgerChangeId === 0) return json({ ledger_id: externalId, snapshot: null, latest_cursor: latestCursor });

  const snapshot = await buildSnapshot(c.env, ledger);
  return json({
    ledger_id: externalId,
    latest_cursor: latestCursor,
    snapshot: {
      change_id: ledgerChangeId,
      ledger_id: externalId,
      entity_type: 'ledger_snapshot',
      entity_sync_id: externalId,
      action: 'upsert',
      payload: { content: JSON.stringify(snapshot), metadata: { source: 'lazy_rebuild' } },
      updated_at: nowIso(),
      updated_by_device_id: null,
      scope: 'ledger',
    },
  });
});

/* ---------------------------------- ledgers --------------------------------- */
syncRoutes.get('/ledgers', anyRead, async (c) => {
  const auth = c.get('auth');
  const ledgers = await listAccessibleLedgers(c.env, auth.user.id);
  const out: any[] = [];
  for (const ledger of ledgers) {
    const latestChangeId = await latestLedgerChangeId(c.env.DB, ledger.id);
    if (latestChangeId === 0) continue;
    const latest = await one<any>(
      c.env.DB,
      `SELECT updated_at FROM sync_changes WHERE ledger_id = ? ORDER BY change_id DESC LIMIT 1`,
      ledger.id,
    );
    const count = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM read_tx WHERE ledger_id = ?`, ledger.id);
    out.push({
      ledger_id: ledger.external_id,
      path: ledger.external_id,
      updated_at: latest?.updated_at || ledger.updated_at,
      size: 512 + Number(count?.n || 0) * 300,
      metadata: { source: 'lazy_rebuild' },
      role: ledger.role || 'owner',
    });
  }
  return json(out);
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
