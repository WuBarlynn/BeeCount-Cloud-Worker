import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one, run } from '../lib/db';
import { appendChange, broadcastToLedger, broadcastToUser } from '../lib/changes';
import { HttpError, json, nowIso, parseJson, toFloat, toInt, uuid } from '../lib/util';
import { createLedger, getLedgerByExternal, requireLedger, type LedgerRow } from '../lib/ledger';
import { applyLedgerChange, applyUserChange, type ChangeInput } from '../lib/projection';
import { sha256Hex } from '../lib/util';

export const writeRoutes = new Hono<AppContext>();

writeRoutes.use('*', authMiddleware());
const writeScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE);
writeRoutes.use('*', writeScope);

const WRITE_ROLES = ['owner', 'editor'];

function newSyncId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function bodyOf(raw: any): Record<string, any> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

async function readBody(c: any): Promise<Record<string, any>> {
  const text = await c.req.raw.text();
  if (!text) return {};
  try {
    return bodyOf(JSON.parse(text));
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
}

function deviceIdOf(c: any): string {
  return c.req.header('x-device-id') || 'web-console';
}

function commitMeta(ledgerExternalId: string, baseChangeId: number, newChangeId: number, entityId: string | null) {
  return {
    ledger_id: ledgerExternalId,
    base_change_id: baseChangeId,
    new_change_id: newChangeId,
    server_timestamp: nowIso(),
    idempotency_replayed: false,
    entity_id: entityId,
  };
}

/* -------------------------------- idempotency ------------------------------- */
async function idempotencyLookup(c: any, payload: Record<string, any>): Promise<any | null> {
  const key = c.req.header('idempotency-key');
  if (!key) return null;
  const device = deviceIdOf(c);
  const hash = await sha256Hex(JSON.stringify({ method: c.req.method, path: new URL(c.req.url).pathname, payload }));
  const row = await one<any>(
    c.env.DB,
    `SELECT request_hash, response_json FROM sync_push_idempotency WHERE user_id=? AND device_id=? AND idempotency_key=? AND expires_at > ?`,
    c.get('auth').user.id,
    device,
    key,
    nowIso(),
  );
  if (!row) return null;
  if (row.request_hash !== hash) throw new HttpError(409, 'Idempotency key reused with different payload');
  return { ...parseJson(row.response_json, {}), idempotency_replayed: true };
}

async function idempotencyStore(c: any, payload: Record<string, any>, response: any): Promise<void> {
  const key = c.req.header('idempotency-key');
  if (!key) return;
  const device = deviceIdOf(c);
  const hash = await sha256Hex(JSON.stringify({ method: c.req.method, path: new URL(c.req.url).pathname, payload }));
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  await run(
    c.env.DB,
    `INSERT OR REPLACE INTO sync_push_idempotency
      (user_id, device_id, idempotency_key, request_hash, response_json, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    c.get('auth').user.id,
    device,
    key,
    hash,
    JSON.stringify(response),
    expires,
    nowIso(),
  );
}

/* ------------------------------ change emission ----------------------------- */
async function emitUser(
  env: AppContext['Bindings'],
  userId: string,
  entityType: string,
  entitySyncId: string,
  action: 'upsert' | 'delete',
  payload: Record<string, any>,
  deviceId: string,
): Promise<number> {
  const changeId = await appendChange(env, {
    userId,
    ledgerId: null,
    scope: 'user',
    entityType,
    entitySyncId,
    action,
    payload,
    deviceId,
    updatedByUserId: userId,
  });
  const input: ChangeInput = { changeId, entityType, entitySyncId, action, payload, updatedAt: nowIso(), actorUserId: userId, deviceId };
  await applyUserChange(env, userId, input);
  await broadcastToUser(env, userId, { type: 'sync_change', ledgerId: '__user_global__', serverCursor: changeId, serverTimestamp: nowIso() });
  if (entityType === 'account' || entityType === 'category' || entityType === 'tag') {
    await broadcastSharedResource(env, userId, entityType, action, payload);
  }
  return changeId;
}

async function emitLedger(
  env: AppContext['Bindings'],
  ledger: LedgerRow,
  actorUserId: string,
  entityType: string,
  entitySyncId: string,
  action: 'upsert' | 'delete',
  payload: Record<string, any>,
  deviceId: string,
): Promise<number> {
  const changeId = await appendChange(env, {
    userId: ledger.user_id,
    ledgerId: ledger.id,
    scope: 'ledger',
    entityType,
    entitySyncId,
    action,
    payload,
    deviceId,
    updatedByUserId: actorUserId,
  });
  const input: ChangeInput = { changeId, entityType, entitySyncId, action, payload, updatedAt: nowIso(), actorUserId, deviceId };
  await applyLedgerChange(env, ledger, input);
  await broadcastToLedger(env, ledger.id, { type: 'sync_change', ledgerId: ledger.external_id, serverCursor: changeId, serverTimestamp: nowIso() });
  return changeId;
}

/**
 * Shared-ledger editors keep mirror copies of the owner's accounts/categories/
 * tags. Upstream pushes a `shared_resource_change` event to every non-owner
 * member of every shared ledger the owner has, so pickers refresh without a
 * restart. Only owners fan out; editors own no resources others mirror.
 */
async function broadcastSharedResource(
  env: AppContext['Bindings'],
  ownerUserId: string,
  resourceType: string,
  action: 'upsert' | 'delete',
  payload: Record<string, any>,
): Promise<void> {
  const shared = await all<any>(
    env.DB,
    `SELECT l.id, l.external_id FROM ledgers l
     JOIN ledger_members m ON m.ledger_id = l.id
     WHERE l.user_id = ? AND l.deleted_at IS NULL
     GROUP BY l.id, l.external_id
     HAVING COUNT(m.user_id) > 1`,
    ownerUserId,
  );
  if (!shared.length) return;
  for (const ledger of shared) {
    const members = await all<any>(
      env.DB,
      `SELECT user_id, role FROM ledger_members WHERE ledger_id = ? AND user_id != ?`,
      ledger.id,
      ownerUserId,
    );
    for (const m of members) {
      await broadcastToUser(env, m.user_id, {
        type: 'shared_resource_change',
        ledgerId: ledger.external_id,
        resourceType,
        action,
        payload,
      });
    }
  }
}

/* ---------------------------------- ledgers --------------------------------- */
writeRoutes.post('/ledgers', async (c) => {
  const body = await readBody(c);
  const replay = await idempotencyLookup(c, body);
  if (replay) return json(replay);
  const auth = c.get('auth');
  const externalId = String(body.ledger_id || `ledger_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`).trim();
  const name = String(body.ledger_name || '').trim();
  if (!name) throw new HttpError(422, 'Ledger name is required');
  if (await one(c.env.DB, `SELECT id FROM ledgers WHERE user_id = ? AND external_id = ?`, auth.user.id, externalId)) {
    throw new HttpError(409, 'Ledger already exists');
  }
  const ledger = await createLedger(c.env, auth.user.id, {
    externalId,
    name: name.slice(0, 255),
    currency: String(body.currency || 'CNY').trim().toUpperCase().slice(0, 16) || 'CNY',
    monthStartDay: Math.max(1, Math.min(28, toInt(body.month_start_day, 1))),
  });
  const changeId = await emitLedger(
    c.env,
    ledger,
    auth.user.id,
    'ledger',
    externalId,
    'upsert',
    { ledgerName: ledger.name, currency: ledger.currency, monthStartDay: ledger.month_start_day },
    deviceIdOf(c),
  );
  const res = commitMeta(externalId, 0, changeId, externalId);
  await idempotencyStore(c, body, res);
  return json(res);
});

writeRoutes.patch('/ledgers/:id/meta', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, ['owner']);
  const body = await readBody(c);
  const baseChangeId = toInt(body.base_change_id, 0);
  const name = body.ledger_name !== undefined ? String(body.ledger_name || '').trim() : ledger.name;
  if (!name) throw new HttpError(422, 'Ledger name is required');
  const currency = body.currency !== undefined ? String(body.currency || 'CNY').trim().toUpperCase().slice(0, 16) : ledger.currency;
  const monthStartDay =
    body.month_start_day !== undefined ? Math.max(1, Math.min(28, toInt(body.month_start_day, 1))) : ledger.month_start_day;
  const payload = { ledgerName: name, currency, monthStartDay };
  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'ledger', externalId, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(externalId, baseChangeId, changeId, externalId));
});

writeRoutes.delete('/ledgers/:id', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, ['owner']);
  await run(c.env.DB, `UPDATE ledgers SET deleted_at = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), ledger.id);
  const changeId = await appendChange(c.env, {
    userId: ledger.user_id,
    ledgerId: ledger.id,
    scope: 'ledger',
    entityType: 'ledger',
    entitySyncId: externalId,
    action: 'delete',
    payload: {},
    deviceId: deviceIdOf(c),
    updatedByUserId: auth.user.id,
  });
  await broadcastToLedger(c.env, ledger.id, { type: 'sync_change', ledgerId: externalId, serverCursor: changeId, serverTimestamp: nowIso() });
  return json(commitMeta(externalId, 0, changeId, null));
});

/* -------------------------------- transactions ------------------------------- */
async function nextTxIndex(env: AppContext['Bindings'], ledgerId: string): Promise<number> {
  const row = await one<{ n: number }>(env.DB, `SELECT COALESCE(MAX(tx_index),0) AS n FROM read_tx WHERE ledger_id = ?`, ledgerId);
  return Number(row?.n || 0) + 1;
}

function tagCsvFrom(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    const parts = raw.map((v) => String(v).trim()).filter(Boolean);
    return parts.length ? [...new Set(parts)].join(',') : null;
  }
  const parts = String(raw)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(',') : null;
}

async function txPayloadFromRow(env: AppContext['Bindings'], row: any, ledger: LedgerRow): Promise<Record<string, any>> {
  const payload: Record<string, any> = {
    syncId: row.sync_id,
    type: row.tx_type,
    amount: row.amount,
    happenedAt: row.happened_at,
    txIndex: row.tx_index,
    excludeFromStats: !!row.exclude_from_stats,
    excludeFromBudget: !!row.exclude_from_budget,
  };
  if (row.note != null) payload.note = row.note;
  if (row.category_sync_id) payload.categoryId = row.category_sync_id;
  if (row.category_name) payload.categoryName = row.category_name;
  if (row.category_kind) payload.categoryKind = row.category_kind;
  if (row.account_sync_id) payload.accountId = row.account_sync_id;
  if (row.account_name) payload.accountName = row.account_name;
  if (row.from_account_sync_id) payload.fromAccountId = row.from_account_sync_id;
  if (row.from_account_name) payload.fromAccountName = row.from_account_name;
  if (row.to_account_sync_id) payload.toAccountId = row.to_account_sync_id;
  if (row.to_account_name) payload.toAccountName = row.to_account_name;
  if (row.tags_csv) payload.tags = row.tags_csv;
  const tagIds = parseJson<string[]>(row.tag_sync_ids_json, []);
  if (tagIds.length) payload.tagIds = tagIds;
  const attachments = parseJson<any[]>(row.attachments_json, []);
  if (attachments.length) payload.attachments = attachments;
  if (row.currency_code) payload.currencyCode = row.currency_code;
  if (row.native_amount != null) payload.nativeAmount = row.native_amount;
  if (row.created_by_user_id) payload.createdByUserId = row.created_by_user_id;
  if (row.last_edited_by_user_id) payload.updatedByUserId = row.last_edited_by_user_id;
  return payload;
}

function applyTxPatch(payload: Record<string, any>, body: Record<string, any>, current?: any): Record<string, any> {
  const out = { ...payload };
  if (body.tx_type !== undefined) {
    const t = String(body.tx_type);
    if (!['expense', 'income', 'transfer'].includes(t)) throw new HttpError(422, 'write validation failed: invalid transaction type');
    out.type = t;
  }
  if (body.amount !== undefined) {
    const amount = toFloat(body.amount, 0);
    if (out.nativeAmount != null && out.amount) out.nativeAmount = Math.round(((amount * toFloat(out.nativeAmount, 0)) / toFloat(out.amount, 0)) * 100) / 100;
    out.amount = amount;
  }
  if (body.native_amount !== undefined && body.native_amount !== null) out.nativeAmount = toFloat(body.native_amount, 0);
  if (body.currency_code !== undefined && body.currency_code !== null) out.currencyCode = String(body.currency_code).toUpperCase();
  if (body.happened_at !== undefined) out.happenedAt = String(body.happened_at);
  const map: Record<string, string> = {
    note: 'note',
    category_name: 'categoryName',
    category_kind: 'categoryKind',
    category_id: 'categoryId',
    account_name: 'accountName',
    account_id: 'accountId',
    from_account_name: 'fromAccountName',
    from_account_id: 'fromAccountId',
    to_account_name: 'toAccountName',
    to_account_id: 'toAccountId',
  };
  for (const [k, key] of Object.entries(map)) {
    if (body[k] === undefined) continue;
    const v = strOrNull(body[k]);
    if (v === null) delete out[key];
    else out[key] = v;
  }
  if (body.tags !== undefined) {
    const csv = tagCsvFrom(body.tags);
    if (csv) out.tags = csv;
    else delete out.tags;
  }
  if (body.tag_ids !== undefined) {
    const ids = Array.isArray(body.tag_ids) ? [...new Set(body.tag_ids.map((x: any) => String(x).trim()).filter(Boolean))] : [];
    if (ids.length) out.tagIds = ids;
    else delete out.tagIds;
  }
  if (body.attachments !== undefined) {
    if (Array.isArray(body.attachments)) out.attachments = body.attachments;
    else delete out.attachments;
  }
  if (body.exclude_from_stats !== undefined && body.exclude_from_stats !== null) out.excludeFromStats = !!body.exclude_from_stats;
  if (body.exclude_from_budget !== undefined && body.exclude_from_budget !== null) out.excludeFromBudget = !!body.exclude_from_budget;
  return out;
}

writeRoutes.post('/ledgers/:id/transactions', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, WRITE_ROLES);
  const body = await readBody(c);
  const replay = await idempotencyLookup(c, body);
  if (replay) return json(replay);

  const baseChangeId = toInt(body.base_change_id, 0);
  const txId = newSyncId('tx');
  const payload = applyTxPatch({ syncId: txId }, body);
  payload.amount = toFloat(body.amount, 0);
  payload.type = String(body.tx_type || 'expense');
  if (!['expense', 'income', 'transfer'].includes(payload.type)) throw new HttpError(422, 'write validation failed: invalid transaction type');
  payload.happenedAt = body.happened_at ? String(body.happened_at) : nowIso();
  payload.createdByUserId = auth.user.id;
  payload.updatedByUserId = auth.user.id;
  payload.txIndex = await nextTxIndex(c.env, ledger.id);
  if (body.exclude_from_stats === undefined) payload.excludeFromStats = false;
  if (body.exclude_from_budget === undefined) payload.excludeFromBudget = false;

  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'transaction', txId, 'upsert', payload, deviceIdOf(c));
  const res = commitMeta(externalId, baseChangeId, changeId, txId);
  await idempotencyStore(c, body, res);
  return json(res);
});

writeRoutes.patch('/ledgers/:id/transactions/:txId', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, WRITE_ROLES);
  const txId = c.req.param('txId');
  const row = await one<any>(c.env.DB, `SELECT * FROM read_tx WHERE ledger_id = ? AND sync_id = ?`, ledger.id, txId);
  if (!row) throw new HttpError(404, 'Transaction not found');
  const body = await readBody(c);
  const baseChangeId = toInt(body.base_change_id, 0);
  if (body.expected_revision !== undefined && body.expected_revision !== null && Number(row.source_change_id) !== Number(body.expected_revision)) {
    throw new HttpError(409, 'REVISION_CONFLICT: transaction changed since it was read');
  }
  const payload = applyTxPatch(await txPayloadFromRow(c.env, row, ledger), body);
  payload.updatedByUserId = auth.user.id;
  if (!payload.createdByUserId) payload.createdByUserId = row.created_by_user_id || auth.user.id;
  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'transaction', txId, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(externalId, baseChangeId, changeId, txId));
});

writeRoutes.delete('/ledgers/:id/transactions/:txId', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, WRITE_ROLES);
  const txId = c.req.param('txId');
  const row = await one<any>(c.env.DB, `SELECT * FROM read_tx WHERE ledger_id = ? AND sync_id = ?`, ledger.id, txId);
  if (!row) throw new HttpError(404, 'Transaction not found');
  const body = await readBody(c);
  const baseChangeId = toInt(body.base_change_id, 0);
  if (body.expected_revision !== undefined && body.expected_revision !== null && Number(row.source_change_id) !== Number(body.expected_revision)) {
    throw new HttpError(409, 'REVISION_CONFLICT: transaction changed since it was read');
  }
  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'transaction', txId, 'delete', {}, deviceIdOf(c));
  return json(commitMeta(externalId, baseChangeId, changeId, txId));
});

writeRoutes.post('/ledgers/:id/transactions/batch', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, WRITE_ROLES);
  const body = await readBody(c);
  const items = Array.isArray(body.transactions) ? body.transactions : [];
  if (!items.length || items.length > 50) throw new HttpError(422, 'transactions must contain 1..50 items');
  const baseChangeId = toInt(body.base_change_id, 0);
  const created: string[] = [];
  let newChangeId = 0;
  let index = await nextTxIndex(c.env, ledger.id);
  for (const item of items) {
    const txId = newSyncId('tx');
    const payload = applyTxPatch({ syncId: txId }, item);
    payload.amount = toFloat(item.amount, 0);
    payload.type = String(item.tx_type || 'expense');
    if (!['expense', 'income', 'transfer'].includes(payload.type)) throw new HttpError(422, 'write validation failed: invalid transaction type');
    payload.happenedAt = item.happened_at ? String(item.happened_at) : nowIso();
    payload.createdByUserId = auth.user.id;
    payload.updatedByUserId = auth.user.id;
    payload.txIndex = index++;
    payload.excludeFromStats = !!item.exclude_from_stats;
    payload.excludeFromBudget = !!item.exclude_from_budget;
    newChangeId = await emitLedger(c.env, ledger, auth.user.id, 'transaction', txId, 'upsert', payload, deviceIdOf(c));
    created.push(txId);
  }
  return json({
    ledger_id: externalId,
    base_change_id: baseChangeId,
    new_change_id: newChangeId,
    server_timestamp: nowIso(),
    created_sync_ids: created,
    attachment_id: null,
  });
});

writeRoutes.post('/ledgers/:id/transactions/batch/delete', async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id');
  const ledger = await requireLedger(c.env, auth.user.id, externalId, WRITE_ROLES);
  const body = await readBody(c);
  const txIds = Array.isArray(body.tx_ids) ? body.tx_ids.map(String) : [];
  if (!txIds.length || txIds.length > 200) throw new HttpError(422, 'tx_ids must contain 1..200 items');
  const deleted: string[] = [];
  const failed: any[] = [];
  let newChangeId = 0;
  for (const txId of txIds) {
    const row = await one<any>(c.env.DB, `SELECT sync_id FROM read_tx WHERE ledger_id = ? AND sync_id = ?`, ledger.id, txId);
    if (!row) {
      failed.push({ tx_id: txId, reason: 'not_found', message: null });
      continue;
    }
    newChangeId = await emitLedger(c.env, ledger, auth.user.id, 'transaction', txId, 'delete', {}, deviceIdOf(c));
    deleted.push(txId);
  }
  return json({
    ledger_id: externalId,
    base_change_id: toInt(body.base_change_id, 0),
    new_change_id: newChangeId,
    server_timestamp: nowIso(),
    deleted_tx_ids: deleted,
    failed,
  });
});

/* --------------------------------- accounts --------------------------------- */
async function accountPayload(env: AppContext['Bindings'], userId: string, sid: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const row = await one<any>(env.DB, `SELECT * FROM user_accounts WHERE user_id = ? AND sync_id = ?`, userId, sid);
  const p: Record<string, any> = {
    syncId: sid,
    name: row?.name ?? '',
  };
  if (row?.account_type) p.type = row.account_type;
  if (row?.currency) p.currency = row.currency;
  if (row?.initial_balance != null) p.initialBalance = row.initial_balance;
  if (row?.note != null) p.note = row.note;
  if (row?.credit_limit != null) p.creditLimit = row.credit_limit;
  if (row?.billing_day != null) p.billingDay = row.billing_day;
  if (row?.payment_due_day != null) p.paymentDueDay = row.payment_due_day;
  if (row?.bank_name) p.bankName = row.bank_name;
  if (row?.card_last_four) p.cardLastFour = row.card_last_four;
  if (row) p.hidden = !!row.hidden;

  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new HttpError(422, 'write validation failed: name is required');
    p.name = name;
  }
  if (patch.account_type !== undefined) p.type = strOrNull(patch.account_type);
  if (patch.currency !== undefined) p.currency = strOrNull(patch.currency);
  if (patch.initial_balance !== undefined) p.initialBalance = patch.initial_balance === null ? null : toFloat(patch.initial_balance, 0);
  if (patch.note !== undefined) p.note = strOrNull(patch.note);
  if (patch.credit_limit !== undefined) p.creditLimit = patch.credit_limit === null ? null : toFloat(patch.credit_limit, 0);
  if (patch.billing_day !== undefined) p.billingDay = patch.billing_day === null ? null : toInt(patch.billing_day, 0);
  if (patch.payment_due_day !== undefined) p.paymentDueDay = patch.payment_due_day === null ? null : toInt(patch.payment_due_day, 0);
  if (patch.bank_name !== undefined) p.bankName = strOrNull(patch.bank_name);
  if (patch.card_last_four !== undefined) p.cardLastFour = strOrNull(patch.card_last_four);
  if (patch.hidden !== undefined && patch.hidden !== null) p.hidden = !!patch.hidden;
  return p;
}

writeRoutes.post('/ledgers/:id/accounts', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const body = await readBody(c);
  const replay = await idempotencyLookup(c, body);
  if (replay) return json(replay);
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(422, 'write validation failed: name is required');
  const dup = await all<any>(c.env.DB, `SELECT name FROM user_accounts WHERE user_id = ?`, auth.user.id);
  if (dup.some((r) => String(r.name).toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'write validation failed: duplicated account name');
  const sid = newSyncId('acc');
  const payload = await accountPayload(c.env, auth.user.id, sid, { ...body, name });
  payload.createdByUserId = auth.user.id;
  payload.updatedByUserId = auth.user.id;
  const changeId = await emitUser(c.env, auth.user.id, 'account', sid, 'upsert', payload, deviceIdOf(c));
  const res = commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid);
  await idempotencyStore(c, body, res);
  return json(res);
});

writeRoutes.patch('/ledgers/:id/accounts/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id = ? AND sync_id = ?`, auth.user.id, sid);
  if (!row) throw new HttpError(404, 'Account not found');
  const body = await readBody(c);
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    const dup = await all<any>(c.env.DB, `SELECT sync_id, name FROM user_accounts WHERE user_id = ?`, auth.user.id);
    if (dup.some((r) => r.sync_id !== sid && String(r.name).toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'write validation failed: duplicated account name');
  }
  const payload = await accountPayload(c.env, auth.user.id, sid, body);
  payload.updatedByUserId = auth.user.id;
  const changeId = await emitUser(c.env, auth.user.id, 'account', sid, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

writeRoutes.delete('/ledgers/:id/accounts/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id = ? AND sync_id = ?`, auth.user.id, sid);
  if (!row) throw new HttpError(404, 'Account not found');
  const linked = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM read_tx WHERE account_sync_id = ? OR from_account_sync_id = ? OR to_account_sync_id = ?`,
    sid,
    sid,
    sid,
  );
  if (Number(linked?.n || 0) > 0) throw new HttpError(400, `write validation failed: account has linked transactions; reassign or delete the ${linked?.n} transactions first`);
  const body = await readBody(c);
  const changeId = await emitUser(c.env, auth.user.id, 'account', sid, 'delete', {}, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

/* -------------------------------- categories -------------------------------- */
async function categoryPayload(env: AppContext['Bindings'], userId: string, sid: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const row = await one<any>(env.DB, `SELECT * FROM user_categories WHERE user_id = ? AND sync_id = ?`, userId, sid);
  const p: Record<string, any> = { syncId: sid, name: row?.name ?? '', kind: row?.kind ?? 'expense' };
  if (row?.level != null) p.level = row.level;
  if (row?.sort_order != null) p.sortOrder = row.sort_order;
  if (row?.icon) p.icon = row.icon;
  if (row?.icon_type) p.iconType = row.icon_type;
  if (row?.custom_icon_path) p.customIconPath = row.custom_icon_path;
  if (row?.icon_cloud_file_id) p.iconCloudFileId = row.icon_cloud_file_id;
  if (row?.icon_cloud_sha256) p.iconCloudSha256 = row.icon_cloud_sha256;
  if (row?.parent_name) p.parentName = row.parent_name;
  if (row?.parent_sync_id) p.parentSyncId = row.parent_sync_id;

  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) throw new HttpError(422, 'write validation failed: name is required');
    p.name = name;
  }
  if (patch.kind !== undefined) {
    const kind = String(patch.kind);
    if (!['expense', 'income', 'transfer'].includes(kind)) throw new HttpError(422, 'write validation failed: invalid category kind');
    p.kind = kind;
  }
  for (const [k, key] of [
    ['level', 'level'],
    ['sort_order', 'sortOrder'],
    ['icon', 'icon'],
    ['icon_type', 'iconType'],
    ['custom_icon_path', 'customIconPath'],
    ['icon_cloud_file_id', 'iconCloudFileId'],
    ['icon_cloud_sha256', 'iconCloudSha256'],
  ] as const) {
    if (patch[k] !== undefined) {
      if (patch[k] === null) delete (p as any)[key];
      else (p as any)[key] = patch[k];
    }
  }
  const parentTouched = patch.parent_sync_id !== undefined || patch.parent_name !== undefined;
  if (parentTouched) {
    let parentId = strOrNull(patch.parent_sync_id);
    let parentName = strOrNull(patch.parent_name);
    if (!parentId && parentName) {
      const cand = await all<any>(
        env.DB,
        `SELECT sync_id, name FROM user_categories WHERE user_id = ? AND kind = ? AND (level IS NULL OR level = 1) AND (parent_sync_id IS NULL OR parent_sync_id = '')`,
        userId,
        p.kind,
      );
      const matches = cand.filter((r) => r.sync_id !== sid && String(r.name).trim() === parentName);
      if (matches.length === 1) parentId = matches[0].sync_id;
    }
    if (parentId || parentName) {
      if (parentId) {
        const parent = await one<any>(env.DB, `SELECT sync_id, name FROM user_categories WHERE user_id = ? AND sync_id = ?`, userId, parentId);
        if (!parent) throw new HttpError(400, 'write validation failed: invalid category parent');
        p.parentSyncId = parent.sync_id;
        p.parentName = parent.name;
      } else {
        p.parentName = parentName;
      }
      p.level = 2;
    } else {
      delete p.parentSyncId;
      delete p.parentName;
      if (p.level === 2) throw new HttpError(400, 'write validation failed: child category requires a parent');
    }
  }
  return p;
}

writeRoutes.post('/ledgers/:id/categories', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const body = await readBody(c);
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(422, 'write validation failed: name is required');
  const kind = String(body.kind || 'expense');
  const dup = await all<any>(c.env.DB, `SELECT name, kind, level FROM user_categories WHERE user_id = ?`, auth.user.id);
  if (dup.some((r) => String(r.name).toLowerCase() === name.toLowerCase() && r.kind === kind && (r.level ?? 1) === 1 && !(body.level))) {
    throw new HttpError(400, 'write validation failed: duplicated category');
  }
  const sid = newSyncId('cat');
  const payload = await categoryPayload(c.env, auth.user.id, sid, { ...body, name, kind });
  payload.createdByUserId = auth.user.id;
  payload.updatedByUserId = auth.user.id;
  const changeId = await emitUser(c.env, auth.user.id, 'category', sid, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

writeRoutes.patch('/ledgers/:id/categories/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id = ? AND sync_id = ?`, auth.user.id, sid);
  if (!row) throw new HttpError(404, 'Category not found');
  const body = await readBody(c);
  const payload = await categoryPayload(c.env, auth.user.id, sid, body);
  const dup = await all<any>(c.env.DB, `SELECT sync_id, name, kind FROM user_categories WHERE user_id = ?`, auth.user.id);
  if (dup.some((r) => r.sync_id !== sid && String(r.name).toLowerCase() === String(payload.name).toLowerCase() && r.kind === payload.kind)) {
    throw new HttpError(400, 'write validation failed: duplicated category');
  }
  payload.updatedByUserId = auth.user.id;
  const changeId = await emitUser(c.env, auth.user.id, 'category', sid, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

writeRoutes.delete('/ledgers/:id/categories/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id = ? AND sync_id = ?`, auth.user.id, sid);
  if (!row) throw new HttpError(404, 'Category not found');
  const child = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM user_categories WHERE user_id = ? AND parent_sync_id = ?`, auth.user.id, sid);
  if (Number(child?.n || 0) > 0) throw new HttpError(400, `write validation failed: category has ${child?.n} child categories`);
  const linked = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM read_tx WHERE category_sync_id = ?`, sid);
  if (Number(linked?.n || 0) > 0) throw new HttpError(400, `write validation failed: category has ${linked?.n} transactions`);
  const body = await readBody(c);
  const changeId = await emitUser(c.env, auth.user.id, 'category', sid, 'delete', {}, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

/* ----------------------------------- tags ----------------------------------- */
writeRoutes.post('/ledgers/:id/tags', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const body = await readBody(c);
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(422, 'write validation failed: name is required');
  const dup = await all<any>(c.env.DB, `SELECT name FROM user_tags WHERE user_id = ?`, auth.user.id);
  if (dup.some((r) => String(r.name).toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'write validation failed: duplicated tag');
  const sid = newSyncId('tag');
  const payload: Record<string, any> = { syncId: sid, name, color: body.color ?? null, createdByUserId: auth.user.id, updatedByUserId: auth.user.id };
  const changeId = await emitUser(c.env, auth.user.id, 'tag', sid, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

writeRoutes.patch('/ledgers/:id/tags/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM user_tags WHERE user_id = ? AND sync_id = ?`, auth.user.id, sid);
  if (!row) throw new HttpError(404, 'Tag not found');
  const body = await readBody(c);
  const name = body.name !== undefined ? String(body.name || '').trim() : row.name;
  if (!name) throw new HttpError(422, 'write validation failed: name is required');
  const dup = await all<any>(c.env.DB, `SELECT sync_id, name FROM user_tags WHERE user_id = ?`, auth.user.id);
  if (dup.some((r) => r.sync_id !== sid && String(r.name).toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'write validation failed: duplicated tag');
  const payload = { syncId: sid, name, color: body.color !== undefined ? body.color : row.color, updatedByUserId: auth.user.id };
  const changeId = await emitUser(c.env, auth.user.id, 'tag', sid, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

writeRoutes.delete('/ledgers/:id/tags/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM user_tags WHERE user_id = ? AND sync_id = ?`, auth.user.id, sid);
  if (!row) throw new HttpError(404, 'Tag not found');
  const body = await readBody(c);
  const changeId = await emitUser(c.env, auth.user.id, 'tag', sid, 'delete', {}, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

/* ---------------------------------- budgets --------------------------------- */
async function budgetPayload(env: AppContext['Bindings'], ledger: LedgerRow, sid: string, patch: Record<string, any>): Promise<Record<string, any>> {
  const row = await one<any>(env.DB, `SELECT * FROM read_budgets WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
  const p: Record<string, any> = {
    syncId: sid,
    ledgerSyncId: ledger.external_id,
    type: row?.budget_type ?? 'total',
    amount: row?.amount ?? 0,
    period: row?.period ?? 'monthly',
    startDay: row?.start_day ?? 1,
    enabled: row ? !!row.enabled : true,
  };
  if (row?.category_sync_id) p.categoryId = row.category_sync_id;
  if (patch.amount !== undefined) p.amount = toFloat(patch.amount, 0);
  if (patch.period !== undefined) p.period = ['monthly', 'weekly', 'yearly'].includes(String(patch.period)) ? String(patch.period) : 'monthly';
  if (patch.start_day !== undefined) p.startDay = Math.max(1, Math.min(28, toInt(patch.start_day, 1)));
  if (patch.enabled !== undefined) p.enabled = !!patch.enabled;
  return p;
}

writeRoutes.post('/ledgers/:id/budgets', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const body = await readBody(c);
  const replay = await idempotencyLookup(c, body);
  if (replay) return json(replay);
  const type = body.type === 'category' ? 'category' : 'total';
  const amount = toFloat(body.amount, 0);
  if (amount <= 0) throw new HttpError(422, 'write validation failed: budget amount must be > 0');
  const categoryId = type === 'category' ? strOrNull(body.category_id) : null;
  if (type === 'category' && !categoryId) throw new HttpError(422, 'write validation failed: category budget requires category_id');
  const existing = await all<any>(c.env.DB, `SELECT * FROM read_budgets WHERE ledger_id = ?`, ledger.id);
  if (type === 'total' && existing.some((b) => (b.budget_type || 'total') === 'total')) throw new HttpError(400, 'write validation failed: total budget already exists');
  if (type === 'category' && existing.some((b) => b.budget_type === 'category' && b.category_sync_id === categoryId)) throw new HttpError(400, 'write validation failed: category budget already exists');
  const sid = newSyncId('bgt');
  const payload: Record<string, any> = {
    syncId: sid,
    ledgerSyncId: ledger.external_id,
    type,
    amount,
    period: ['monthly', 'weekly', 'yearly'].includes(String(body.period)) ? String(body.period) : 'monthly',
    startDay: Math.max(1, Math.min(28, toInt(body.start_day, 1))),
    enabled: body.enabled === undefined ? true : !!body.enabled,
    createdByUserId: auth.user.id,
    updatedByUserId: auth.user.id,
  };
  if (categoryId) payload.categoryId = categoryId;
  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'budget', sid, 'upsert', payload, deviceIdOf(c));
  const res = commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid);
  await idempotencyStore(c, body, res);
  return json(res);
});

writeRoutes.patch('/ledgers/:id/budgets/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM read_budgets WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
  if (!row) throw new HttpError(404, 'Budget not found');
  const body = await readBody(c);
  if (body.amount !== undefined && toFloat(body.amount, 0) <= 0) throw new HttpError(422, 'write validation failed: budget amount must be > 0');
  const payload = await budgetPayload(c.env, ledger, sid, body);
  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'budget', sid, 'upsert', payload, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

writeRoutes.delete('/ledgers/:id/budgets/:sid', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id'), WRITE_ROLES);
  const sid = c.req.param('sid');
  const row = await one<any>(c.env.DB, `SELECT * FROM read_budgets WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
  if (!row) throw new HttpError(404, 'Budget not found');
  const body = await readBody(c);
  const changeId = await emitLedger(c.env, ledger, auth.user.id, 'budget', sid, 'delete', {}, deviceIdOf(c));
  return json(commitMeta(ledger.external_id, toInt(body.base_change_id, 0), changeId, sid));
});

/* -------------------------- exchange rate overrides ------------------------- */
writeRoutes.put('/exchange-rate-overrides', async (c) => {
  const auth = c.get('auth');
  const body = await readBody(c);
  const base = String(body.base_currency || '').trim().toUpperCase();
  const quote = String(body.quote_currency || '').trim().toUpperCase();
  const rate = toFloat(body.rate, 0);
  if (!base || !quote || rate <= 0) throw new HttpError(422, 'base_currency, quote_currency and rate are required');
  const sid = newSyncId('rate');
  const payload = { syncId: sid, baseCurrency: base, quoteCurrency: quote, rate, updatedAt: nowIso(), createdByUserId: auth.user.id, updatedByUserId: auth.user.id };
  const changeId = await emitUser(c.env, auth.user.id, 'exchange_rate_override', sid, 'upsert', payload, deviceIdOf(c));
  return json({ sync_id: sid, new_change_id: changeId, server_timestamp: nowIso() });
});

writeRoutes.delete('/exchange-rate-overrides', async (c) => {
  const auth = c.get('auth');
  const base = String(c.req.query('base_currency') || '').trim().toUpperCase();
  const quote = String(c.req.query('quote_currency') || '').trim().toUpperCase();
  if (!base || !quote) throw new HttpError(422, 'base_currency and quote_currency are required');
  const row = await one<any>(c.env.DB, `SELECT * FROM exchange_rate_overrides WHERE user_id=? AND base_currency=? AND quote_currency=?`, auth.user.id, base, quote);
  if (!row) return json({ ok: true, deleted: false });
  const payload = { baseCurrency: base, quoteCurrency: quote };
  const changeId = await emitUser(c.env, auth.user.id, 'exchange_rate_override', row.sync_id || newSyncId('rate'), 'delete', payload, deviceIdOf(c));
  return json({ ok: true, deleted: true, new_change_id: changeId });
});
