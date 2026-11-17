import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, latestLedgerChangeId, maxAccessibleCursor, one, run } from '../lib/db';
import { appendChange, broadcastToLedger, broadcastToUser } from '../lib/changes';
import { HttpError, json, nowIso, parseJson, toInt } from '../lib/util';
import { createLedger, getLedgerByExternal, listAccessibleLedgers, type LedgerRow } from '../lib/ledger';
import { applyLedgerChange, applyUserChange, isUserGlobal, type ChangeInput } from '../lib/projection';
import { buildSnapshot } from '../lib/snapshot';

export const syncRoutes = new Hono<AppContext>();

syncRoutes.use('*', authMiddleware());
const anyRead = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ);
const appWrite = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE);

const USER_GLOBAL_SENTINEL = '__user_global__';
const USER_GLOBAL_TYPES = new Set(['account', 'category', 'tag', 'exchange_rate_override']);

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
  const deviceId = String(body.device_id || '');
  if (!deviceId) throw new HttpError(401, 'Invalid device');
  await requireDevice(c.env, auth.user.id, deviceId);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  await run(c.env.DB, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, now, deviceId);

  let accepted = 0;
  let rejected = 0;
  let conflictCount = 0;
  const conflictSamples: any[] = [];
  let maxCursor = 0;
  const touchedLedgers = new Map<string, string>();
  let touchedUserGlobal = false;

  for (const raw of changes) {
    const entityType = String(raw?.entity_type || '');
    const entitySyncId = String(raw?.entity_sync_id || '');
    const action = raw?.action === 'delete' ? 'delete' : 'upsert';
    if (!entityType || !entitySyncId) {
      rejected++;
      continue;
    }
    const userGlobal = USER_GLOBAL_TYPES.has(entityType) || raw?.scope === 'user';

    let ledger: LedgerRow | null = null;
    if (userGlobal) {
      // user-global entities do not belong to a ledger
    } else {
      const externalId = raw?.ledger_id ? String(raw.ledger_id) : '';
      if (!externalId) {
        rejected++;
        continue;
      }
      ledger = await getLedgerByExternal(c.env, auth.user.id, externalId);
      if (!ledger) {
        ledger = await createLedger(c.env, auth.user.id, { externalId, name: externalId });
      } else if ((ledger.role || 'owner') !== 'owner' && (entityType === 'ledger' || entityType === 'ledger_snapshot')) {
        rejected++;
        continue;
      }
    }

    const incomingPublished = iso(raw?.updated_at);
    const incomingUpdatedAt = clampFuture(incomingPublished, nowMs);

    const latest = userGlobal
      ? await one<any>(
          c.env.DB,
          `SELECT change_id, updated_at, updated_by_device_id FROM sync_changes
           WHERE user_id = ? AND scope = 'user' AND entity_type = ? AND entity_sync_id = ?
           ORDER BY change_id DESC LIMIT 1`,
          auth.user.id,
          entityType,
          entitySyncId,
        )
      : await one<any>(
          c.env.DB,
          `SELECT change_id, updated_at, updated_by_device_id FROM sync_changes
           WHERE ledger_id = ? AND entity_type = ? AND entity_sync_id = ?
           ORDER BY change_id DESC LIMIT 1`,
          ledger!.id,
          entityType,
          entitySyncId,
        );

    if (latest) {
      const existingTs = iso(latest.updated_at);
      const existingDevice = latest.updated_by_device_id || '';
      const cmpTs = Date.parse(existingTs);
      const inTs = Date.parse(incomingUpdatedAt);
      if (cmpTs > inTs || (cmpTs === inTs && existingDevice > deviceId)) {
        rejected++;
        conflictCount++;
        if (conflictSamples.length < 20) {
          conflictSamples.push({
            reason: 'lww_rejected_older_change',
            ledgerId: raw?.ledger_id ?? null,
            entityType,
            entitySyncId,
            existingChangeId: latest.change_id,
          });
        }
        continue;
      }
      if (cmpTs === inTs && existingDevice === deviceId) {
        accepted++;
        continue;
      }
    }

    const payload = raw?.payload && typeof raw.payload === 'object' ? { ...raw.payload } : {};
    if (entityType === 'transaction') {
      const existingTx = ledger
        ? await one<any>(
            c.env.DB,
            `SELECT created_by_user_id FROM read_tx WHERE ledger_id = ? AND sync_id = ?`,
            ledger.id,
            entitySyncId,
          )
        : null;
      if (!payload.updatedByUserId) payload.updatedByUserId = auth.user.id;
      if (!payload.createdByUserId) payload.createdByUserId = existingTx?.created_by_user_id || auth.user.id;
    }

    const changeId = await appendChange(c.env, {
      userId: userGlobal ? auth.user.id : ledger!.user_id,
      ledgerId: userGlobal ? null : ledger!.id,
      scope: userGlobal ? 'user' : 'ledger',
      entityType,
      entitySyncId,
      action,
      payload,
      updatedAt: incomingUpdatedAt,
      deviceId,
      updatedByUserId: auth.user.id,
    });

    const input: ChangeInput = {
      changeId,
      entityType,
      entitySyncId,
      action,
      payload,
      updatedAt: incomingUpdatedAt,
      actorUserId: auth.user.id,
      deviceId,
    };
    if (userGlobal) {
      await applyUserChange(c.env, auth.user.id, input);
      touchedUserGlobal = true;
    } else {
      await applyLedgerChange(c.env, ledger!, input);
      touchedLedgers.set(ledger!.external_id, ledger!.id);
    }

    accepted++;
    maxCursor = Math.max(maxCursor, changeId);
  }

  if (maxCursor === 0) maxCursor = await maxAccessibleCursor(c.env.DB, auth.user.id);

  const broadcastPayload = (ledgerExternalId: string) => ({
    type: 'sync_change',
    ledgerId: ledgerExternalId,
    serverCursor: maxCursor,
    serverTimestamp: now,
  });
  for (const [externalId, internalId] of touchedLedgers) {
    await broadcastToLedger(c.env, internalId, broadcastPayload(externalId));
  }
  if (touchedUserGlobal) {
    await broadcastToUser(c.env, auth.user.id, broadcastPayload(USER_GLOBAL_SENTINEL));
  }

  return json({
    accepted,
    rejected,
    conflict_count: conflictCount,
    conflict_samples: conflictSamples,
    server_cursor: maxCursor,
    server_timestamp: now,
  });
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
