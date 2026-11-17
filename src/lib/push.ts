import type { Env } from '../env';
import type { AuthUser } from '../env';
import { all, one, reserveChangeIds, run } from './db';
import { applyLedgerChange, applyUserChange, type ChangeInput } from './projection';
import { broadcastToLedger, broadcastToUser } from './changes';
import { HttpError, nowIso, parseJson, sqlBool, toFloat, toInt } from './util';
import { createLedger, getLedgerByExternal, listAccessibleLedgers, type LedgerRow } from './ledger';

const USER_GLOBAL_TYPES = new Set(['account', 'category', 'tag', 'exchange_rate_override']);

type Incoming = {
  ledger_id?: string | null;
  entity_type: string;
  entity_sync_id: string;
  action: 'upsert' | 'delete';
  payload: Record<string, any>;
  updated_at: string;
  scope?: string | null;
};

type Accepted = {
  index: number;
  raw: Incoming;
  ledger: LedgerRow | null;
  userGlobal: boolean;
  payload: Record<string, any>;
  updatedAt: string;
  changeId: number;
  /** Same (timestamp, device) already stored: re-project, but do not store a new change row. */
  replay?: boolean;
};

const iso = (v: unknown, fallback = nowIso()) => {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
};
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : toFloat(v, 0));
const nullableInt = (v: unknown): number | null => (v === null || v === undefined ? null : toInt(v, 0));
const jsonOrNull = (v: unknown): string | null => (Array.isArray(v) && v.length ? JSON.stringify(v) : null);

/**
 * Batch applier for mobile `/sync/push`.
 *
 * Free-plan D1 allows only 50 queries per Worker invocation, so this path
 * deliberately:
 *   - checks the device once,
 *   - resolves every LWW head in ONE batch,
 *   - reserves change ids in one atomic UPDATE,
 *   - inserts all changes in ONE batch,
 *   - writes all projections in batches of up to 400 statements.
 *
 * A 100-change push therefore costs ~8 queries instead of ~400.
 */
export async function applyPush(
  env: Env,
  user: AuthUser,
  body: { device_id?: string; changes?: Incoming[] },
): Promise<{
  accepted: number;
  rejected: number;
  skipped: number;
  conflict_count: number;
  conflict_samples: any[];
  skip_samples: any[];
  server_cursor: number;
  server_timestamp: string;
}> {
  const deviceId = String(body.device_id || '');
  if (!deviceId) throw new HttpError(401, 'Invalid device');
  const device = await one<any>(
    env.DB,
    `SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    deviceId,
    user.id,
  );
  if (!device) throw new HttpError(401, 'Invalid device');

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const changes = Array.isArray(body.changes) ? body.changes : [];

  // 1. Resolve ledgers once.
  const ledgers = await listAccessibleLedgers(env, user.id);
  const byExternal = new Map(ledgers.map((l) => [l.external_id, l]));
  const missingCreates = new Map<string, LedgerRow>();
  for (const ch of changes) {
    const userGlobal = USER_GLOBAL_TYPES.has(ch.entity_type) || ch.scope === 'user';
    if (userGlobal) continue;
    const ext = ch.ledger_id ? String(ch.ledger_id) : '';
    if (!ext) continue;
    if (!byExternal.has(ext) && !missingCreates.has(ext)) {
      const created = await createLedger(env, user.id, { externalId: ext, name: ext });
      missingCreates.set(ext, created);
      byExternal.set(ext, created);
    }
  }

  // 2. One batch for all LWW heads.
  const lwwStatements: D1PreparedStatement[] = [];
  const routable: (Incoming & { ledger: LedgerRow | null; userGlobal: boolean })[] = [];
  // Reasons a change was dropped are surfaced instead of vanishing silently: a
  // stuck mobile outbox is otherwise impossible to diagnose from the server.
  const skippedSamples: any[] = [];
  let skipped = 0;
  const noteSkip = (reason: string, ch: any) => {
    skipped++;
    const sample = {
      reason,
      ledgerId: ch?.ledger_id ?? null,
      entityType: ch?.entity_type ?? null,
      entitySyncId: ch?.entity_sync_id ?? null,
    };
    if (skippedSamples.length < 20) skippedSamples.push(sample);
    console.warn('sync.push.skip', JSON.stringify(sample));
  };
  // A budget/transaction may arrive before (or without) its ledger id; when a
  // client owns exactly one ledger, attach it there instead of dropping it.
  const soleLedger = byExternal.size === 1 ? [...byExternal.values()][0] : null;
  for (const ch of changes) {
    if (!ch?.entity_type || !ch?.entity_sync_id) {
      noteSkip('missing_entity_fields', ch);
      continue;
    }
    // Scope is derived from the entity type (as the reference server does): a
    // client that labels a budget `scope: user` must not lose the projection.
    const userGlobal = USER_GLOBAL_TYPES.has(ch.entity_type);
    let ledger: LedgerRow | null = null;
    if (!userGlobal) {
      let ext = ch.ledger_id ? String(ch.ledger_id) : '';
      if (!ext && soleLedger) ext = soleLedger.external_id;
      if (!ext) {
        noteSkip('missing_ledger_id', ch);
        continue;
      }
      ledger = byExternal.get(ext) || null;
      if (!ledger) {
        noteSkip('unknown_ledger', ch);
        continue;
      }
      if ((ledger.role || 'owner') !== 'owner' && (ch.entity_type === 'ledger' || ch.entity_type === 'ledger_snapshot')) {
        noteSkip('ledger_meta_requires_owner', ch);
        continue;
      }
    }
    routable.push({ ...ch, ledger, userGlobal });
    lwwStatements.push(
      userGlobal
        ? env.DB.prepare(
            `SELECT change_id, updated_at, updated_by_device_id FROM sync_changes
             WHERE user_id=? AND scope='user' AND entity_type=? AND entity_sync_id=?
             ORDER BY change_id DESC LIMIT 1`,
          ).bind(user.id, ch.entity_type, ch.entity_sync_id)
        : env.DB.prepare(
            `SELECT change_id, updated_at, updated_by_device_id FROM sync_changes
             WHERE ledger_id=? AND entity_type=? AND entity_sync_id=?
             ORDER BY change_id DESC LIMIT 1`,
          ).bind(ledger!.id, ch.entity_type, ch.entity_sync_id),
    );
  }
  const lww = lwwStatements.length ? await env.DB.batch(lwwStatements) : [];

  // 3. Decide winners.
  const winners: (Omit<Accepted, 'changeId'> & { changeId?: number; replay?: boolean })[] = [];
  let rejected = 0;
  let conflictCount = 0;
  const conflictSamples: any[] = [];
  for (let i = 0; i < routable.length; i++) {
    const ch = routable[i];
    const latest = lww[i]?.results?.[0] as any | undefined;
    const incomingAt = new Date(Math.min(Date.parse(iso(ch.updated_at, now)) || nowMs, nowMs + 5000)).toISOString();
    const action: 'upsert' | 'delete' = ch.action === 'delete' ? 'delete' : 'upsert';
    if (latest) {
      const existingAt = iso(latest.updated_at, now);
      const existingDevice = latest.updated_by_device_id || '';
      const cmp = Date.parse(existingAt) - Date.parse(incomingAt);
      if (cmp > 0 || (cmp === 0 && existingDevice > deviceId)) {
        rejected++;
        conflictCount++;
        if (conflictSamples.length < 20) {
          conflictSamples.push({
            reason: 'lww_rejected_older_change',
            ledgerId: ch.ledger_id ?? null,
            entityType: ch.entity_type,
            entitySyncId: ch.entity_sync_id,
            existingChangeId: latest.change_id,
          });
        }
        continue;
      }
      if (cmp === 0 && existingDevice === deviceId) {
        // Idempotent replay: re-project so a row lost after a partial failure
        // (change stored, projection missing) heals on the next push.
        const payload = ch.payload && typeof ch.payload === 'object' ? { ...ch.payload } : {};
        if (ch.entity_type === 'transaction') {
          if (!payload.updatedByUserId) payload.updatedByUserId = user.id;
          if (!payload.createdByUserId) payload.createdByUserId = user.id;
        }
        winners.push({
          index: i,
          raw: { ...ch, action },
          ledger: ch.ledger,
          userGlobal: ch.userGlobal,
          payload,
          updatedAt: incomingAt,
          changeId: Number(latest.change_id),
          replay: true,
        } as any);
        continue;
      }
    }
    const payload = ch.payload && typeof ch.payload === 'object' ? { ...ch.payload } : {};
    if (ch.entity_type === 'transaction') {
      if (!payload.updatedByUserId) payload.updatedByUserId = user.id;
      if (!payload.createdByUserId) payload.createdByUserId = user.id;
    }
    winners.push({ index: i, raw: { ...ch, action }, ledger: ch.ledger, userGlobal: ch.userGlobal, payload, updatedAt: incomingAt });
  }

  if (!winners.length) {
    const maxCursor = await maxCursorFor(env, user.id);
    await run(env.DB, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, now, deviceId);
    return {
      accepted: 0,
      rejected,
      skipped,
      conflict_count: conflictCount,
      conflict_samples: conflictSamples,
      skip_samples: skippedSamples,
      server_cursor: maxCursor,
      server_timestamp: now,
    };
  }

  // 4. Reserve contiguous ids for genuinely new changes; replays reuse theirs.
  const fresh = winners.filter((w) => !w.replay);
  const start = fresh.length ? await reserveChangeIds(env.DB, fresh.length) : 0;
  let offset = 0;
  const accepted: Accepted[] = winners.map((w) => ({
    ...w,
    changeId: w.replay ? (w.changeId as number) : start + offset++,
  }));
  const insertStatements = accepted.filter((a) => !a.replay).map((a) =>
    env.DB.prepare(
      `INSERT INTO sync_changes
        (change_id,user_id,ledger_id,scope,entity_type,entity_sync_id,action,payload_json,updated_at,
         updated_by_device_id,updated_by_user_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      a.changeId,
      a.userGlobal ? user.id : a.ledger!.user_id,
      a.userGlobal ? null : a.ledger!.id,
      a.userGlobal ? 'user' : 'ledger',
      a.raw.entity_type,
      a.raw.entity_sync_id,
      a.raw.action,
      JSON.stringify(a.payload ?? {}),
      a.updatedAt,
      deviceId,
      user.id,
      now,
    ),
  );

  // 5. Projection statements.
  const projectionStatements: D1PreparedStatement[] = [];
  const userGlobalTouched = accepted.some((a) => a.userGlobal && !a.replay);
  const touchedLedgers = new Set<string>();
  const sharedFanout: { type: string; action: string; payload: Record<string, any> }[] = [];
  for (const a of accepted) {
    const type = a.raw.entity_type;
    const sid = a.raw.entity_sync_id;
    const p = a.payload || {};
    const del = a.raw.action === 'delete';
    if (a.userGlobal) {
      if (type === 'account') {
        if (del) projectionStatements.push(env.DB.prepare(`DELETE FROM user_accounts WHERE user_id=? AND sync_id=?`).bind(user.id, sid));
        else {
          projectionStatements.push(
            env.DB.prepare(
              `INSERT INTO user_accounts
                (user_id,sync_id,name,account_type,currency,initial_balance,note,credit_limit,billing_day,
                 payment_due_day,bank_name,card_last_four,hidden,source_change_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id,sync_id) DO UPDATE SET
                 name=excluded.name, account_type=excluded.account_type, currency=excluded.currency,
                 initial_balance=excluded.initial_balance, note=excluded.note, credit_limit=excluded.credit_limit,
                 billing_day=excluded.billing_day, payment_due_day=excluded.payment_due_day,
                 bank_name=excluded.bank_name, card_last_four=excluded.card_last_four, hidden=excluded.hidden,
                 source_change_id=excluded.source_change_id`,
            ).bind(
              user.id, sid, String(p.name ?? ''), nullableStr(p.type), nullableStr(p.currency),
              nullableNum(p.initialBalance), nullableStr(p.note), nullableNum(p.creditLimit),
              nullableInt(p.billingDay), nullableInt(p.paymentDueDay), nullableStr(p.bankName),
              nullableStr(p.cardLastFour), p.hidden ? 1 : 0, a.changeId,
            ),
          );
          projectionStatements.push(
            env.DB.prepare(
              `UPDATE read_tx SET
                 account_name = CASE WHEN account_sync_id=? THEN ? ELSE account_name END,
                 from_account_name = CASE WHEN from_account_sync_id=? THEN ? ELSE from_account_name END,
                 to_account_name = CASE WHEN to_account_sync_id=? THEN ? ELSE to_account_name END
               WHERE account_sync_id=? OR from_account_sync_id=? OR to_account_sync_id=?`,
            ).bind(sid, p.name ?? '', sid, p.name ?? '', sid, p.name ?? '', sid, sid, sid),
          );
          if (!a.replay) sharedFanout.push({ type, action: a.raw.action, payload: p });
        }
      } else if (type === 'category') {
        if (del) projectionStatements.push(env.DB.prepare(`DELETE FROM user_categories WHERE user_id=? AND sync_id=?`).bind(user.id, sid));
        else {
          projectionStatements.push(
            env.DB.prepare(
              `INSERT INTO user_categories
                (user_id,sync_id,name,kind,level,sort_order,icon,icon_type,custom_icon_path,
                 icon_cloud_file_id,icon_cloud_sha256,parent_name,parent_sync_id,source_change_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id,sync_id) DO UPDATE SET
                 name=excluded.name, kind=excluded.kind, level=excluded.level, sort_order=excluded.sort_order,
                 icon=excluded.icon, icon_type=excluded.icon_type, custom_icon_path=excluded.custom_icon_path,
                 icon_cloud_file_id=excluded.icon_cloud_file_id, icon_cloud_sha256=excluded.icon_cloud_sha256,
                 parent_name=excluded.parent_name, parent_sync_id=excluded.parent_sync_id,
                 source_change_id=excluded.source_change_id`,
            ).bind(
              user.id, sid, String(p.name ?? ''), p.kind ?? 'expense', nullableInt(p.level), nullableInt(p.sortOrder),
              nullableStr(p.icon), nullableStr(p.iconType), nullableStr(p.customIconPath),
              nullableStr(p.iconCloudFileId), nullableStr(p.iconCloudSha256), nullableStr(p.parentName),
              nullableStr(p.parentSyncId), a.changeId,
            ),
          );
          projectionStatements.push(
            env.DB.prepare(`UPDATE read_tx SET category_name=?, category_kind=? WHERE category_sync_id=?`).bind(
              p.name ?? '',
              p.kind ?? 'expense',
              sid,
            ),
          );
          if (!a.replay) sharedFanout.push({ type, action: a.raw.action, payload: p });
        }
      } else if (type === 'tag') {
        if (del) projectionStatements.push(env.DB.prepare(`DELETE FROM user_tags WHERE user_id=? AND sync_id=?`).bind(user.id, sid));
        else {
          projectionStatements.push(
            env.DB.prepare(
              `INSERT INTO user_tags (user_id,sync_id,name,color,source_change_id) VALUES (?,?,?,?,?)
               ON CONFLICT(user_id,sync_id) DO UPDATE SET name=excluded.name, color=excluded.color,
                 source_change_id=excluded.source_change_id`,
            ).bind(user.id, sid, String(p.name ?? ''), nullableStr(p.color), a.changeId),
          );
          if (!a.replay) sharedFanout.push({ type, action: a.raw.action, payload: p });
        }
      } else if (type === 'exchange_rate_override') {
        const base = p.baseCurrency ?? null;
        const quote = p.quoteCurrency ?? null;
        if (del) {
          if (base && quote) projectionStatements.push(env.DB.prepare(`DELETE FROM exchange_rate_overrides WHERE user_id=? AND base_currency=? AND quote_currency=?`).bind(user.id, base, quote));
          else projectionStatements.push(env.DB.prepare(`DELETE FROM exchange_rate_overrides WHERE user_id=? AND sync_id=?`).bind(user.id, sid));
        } else if (base && quote) {
          projectionStatements.push(
            env.DB.prepare(
              `INSERT INTO exchange_rate_overrides (user_id,base_currency,quote_currency,rate,sync_id,updated_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(user_id,base_currency,quote_currency) DO UPDATE SET
                 rate=excluded.rate, sync_id=excluded.sync_id, updated_at=excluded.updated_at`,
            ).bind(user.id, base, quote, toFloat(p.rate, 0), sid, a.updatedAt),
          );
        }
      }
      continue;
    }

    const ledger = a.ledger!;
    if (!a.replay) touchedLedgers.add(ledger.external_id);
    if (type === 'transaction') {
      if (del) {
        projectionStatements.push(env.DB.prepare(`DELETE FROM read_tx WHERE ledger_id=? AND sync_id=?`).bind(ledger.id, sid));
      } else {
        const tagIds = Array.isArray(p.tagIds) ? p.tagIds : null;
        projectionStatements.push(
          env.DB.prepare(
            `INSERT INTO read_tx
              (ledger_id,sync_id,tx_type,amount,happened_at,note,category_sync_id,category_name,category_kind,
               account_sync_id,account_name,from_account_sync_id,from_account_name,to_account_sync_id,to_account_name,
               tags_csv,tag_sync_ids_json,attachments_json,tx_index,currency_code,native_amount,
               exclude_from_stats,exclude_from_budget,created_by_user_id,last_edited_by_user_id,source_change_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(ledger_id,sync_id) DO UPDATE SET
               tx_type=excluded.tx_type, amount=excluded.amount, happened_at=excluded.happened_at, note=excluded.note,
               category_sync_id=excluded.category_sync_id, category_name=excluded.category_name,
               category_kind=excluded.category_kind, account_sync_id=excluded.account_sync_id,
               account_name=excluded.account_name, from_account_sync_id=excluded.from_account_sync_id,
               from_account_name=excluded.from_account_name, to_account_sync_id=excluded.to_account_sync_id,
               to_account_name=excluded.to_account_name, tags_csv=excluded.tags_csv,
               tag_sync_ids_json=excluded.tag_sync_ids_json, attachments_json=excluded.attachments_json,
               tx_index=excluded.tx_index, currency_code=excluded.currency_code, native_amount=excluded.native_amount,
               exclude_from_stats=excluded.exclude_from_stats, exclude_from_budget=excluded.exclude_from_budget,
               created_by_user_id=COALESCE(read_tx.created_by_user_id, excluded.created_by_user_id),
               last_edited_by_user_id=excluded.last_edited_by_user_id, source_change_id=excluded.source_change_id`,
          ).bind(
            ledger.id,
            sid,
            p.type ?? 'expense',
            toFloat(p.amount, 0),
            iso(p.happenedAt, now),
            nullableStr(p.note),
            nullableStr(p.categoryId),
            nullableStr(p.categoryName),
            nullableStr(p.categoryKind),
            nullableStr(p.accountId),
            nullableStr(p.accountName),
            nullableStr(p.fromAccountId),
            nullableStr(p.fromAccountName),
            nullableStr(p.toAccountId),
            nullableStr(p.toAccountName),
            nullableStr(p.tags),
            tagIds ? JSON.stringify(tagIds) : null,
            jsonOrNull(p.attachments),
            toInt(p.txIndex, 0),
            nullableStr(p.currencyCode),
            nullableNum(p.nativeAmount),
            sqlBool(p.excludeFromStats),
            sqlBool(p.excludeFromBudget),
            nullableStr(p.createdByUserId) || user.id,
            nullableStr(p.updatedByUserId) || user.id,
            a.changeId,
          ),
        );
      }
    } else if (type === 'budget') {
      if (del) projectionStatements.push(env.DB.prepare(`DELETE FROM read_budgets WHERE ledger_id=? AND sync_id=?`).bind(ledger.id, sid));
      else {
        projectionStatements.push(
          env.DB.prepare(
            `INSERT INTO read_budgets (ledger_id,sync_id,budget_type,category_sync_id,amount,period,start_day,enabled,source_change_id)
             VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(ledger_id,sync_id) DO UPDATE SET budget_type=excluded.budget_type,
               category_sync_id=excluded.category_sync_id, amount=excluded.amount, period=excluded.period,
               start_day=excluded.start_day, enabled=excluded.enabled, source_change_id=excluded.source_change_id`,
          ).bind(
            ledger.id, sid, p.type ?? 'total', nullableStr(p.categoryId), toFloat(p.amount, 0),
            p.period ?? 'monthly', toInt(p.startDay, 1), p.enabled === false ? 0 : 1, a.changeId,
          ),
        );
      }
    } else if (type === 'ledger') {
      if (del) projectionStatements.push(env.DB.prepare(`UPDATE ledgers SET deleted_at=? WHERE id=?`).bind(now, ledger.id));
      else {
        projectionStatements.push(
          env.DB.prepare(`UPDATE ledgers SET name=COALESCE(?,name), currency=COALESCE(?,currency), month_start_day=COALESCE(?,month_start_day), updated_at=? WHERE id=?`).bind(
            nullableStr(p.ledgerName),
            nullableStr(p.currency),
            p.monthStartDay === undefined ? null : toInt(p.monthStartDay, 1),
            now,
            ledger.id,
          ),
        );
      }
    }
  }

  // 6. Projections first, change rows second. If a projection throws, nothing is
  //    recorded as synced and the client's retry is not swallowed as a replay.
  for (let i = 0; i < projectionStatements.length; i += 400) {
    await env.DB.batch(projectionStatements.slice(i, i + 400));
  }
  if (insertStatements.length) await env.DB.batch(insertStatements);
  await run(env.DB, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, now, deviceId);

  // 7. Broadcast after writes are durable.
  const maxCursor = Math.max(...accepted.map((a) => a.changeId));
  for (const externalId of touchedLedgers) {
    const ledger = [...byExternal.values()].find((l) => l.external_id === externalId);
    if (ledger) await broadcastToLedger(env, ledger.id, { type: 'sync_change', ledgerId: externalId, serverCursor: maxCursor, serverTimestamp: now });
  }
  if (userGlobalTouched) {
    await broadcastToUser(env, user.id, { type: 'sync_change', ledgerId: '__user_global__', serverCursor: maxCursor, serverTimestamp: now });
  }
  for (const ev of sharedFanout) {
    const shared = await all<any>(
      env.DB,
      `SELECT l.external_id, m.user_id FROM ledgers l
       JOIN ledger_members m ON m.ledger_id = l.id
       WHERE l.user_id = ? AND l.deleted_at IS NULL AND m.user_id != ?
       GROUP BY l.external_id, m.user_id`,
      user.id,
      user.id,
    );
    for (const row of shared) {
      await broadcastToUser(env, row.user_id, {
        type: 'shared_resource_change',
        ledgerId: row.external_id,
        resourceType: ev.type,
        action: ev.action,
        payload: ev.payload,
      });
    }
  }

  return {
    accepted: accepted.length,
    rejected,
    skipped,
    conflict_count: conflictCount,
    conflict_samples: conflictSamples,
    skip_samples: skippedSamples,
    server_cursor: maxCursor,
    server_timestamp: now,
  };
}

async function maxCursorFor(env: Env, userId: string): Promise<number> {
  const row = await one<{ n: number }>(
    env.DB,
    `SELECT COALESCE(MAX(c.change_id),0) AS n FROM sync_changes c
     WHERE (c.scope='user' AND c.user_id=?)
        OR (c.scope='ledger' AND c.ledger_id IN (SELECT ledger_id FROM ledger_members WHERE user_id=?))`,
    userId,
    userId,
  );
  return Number(row?.n || 0);
}
