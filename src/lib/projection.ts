import type { Env } from '../env';
import type { LedgerRow } from './ledger';
import { nowIso, toFloat, toInt, sqlBool } from './util';
import { all, one, run } from './db';

export type ChangeInput = {
  changeId: number;
  entityType: string;
  entitySyncId: string;
  action: 'upsert' | 'delete';
  payload: Record<string, any>;
  updatedAt: string;
  actorUserId: string;
  deviceId?: string | null;
};

const USER_GLOBAL = new Set(['account', 'category', 'tag', 'exchange_rate_override']);

export function isUserGlobal(entityType: string): boolean {
  return USER_GLOBAL.has(entityType);
}

/* ------------------------------------------------------------------ */
/* User-global projections                                             */
/* ------------------------------------------------------------------ */

export async function applyUserChange(env: Env, userId: string, ch: ChangeInput): Promise<void> {
  const sid = ch.entitySyncId;
  if (ch.entityType === 'account') return applyAccount(env, userId, sid, ch);
  if (ch.entityType === 'category') return applyCategory(env, userId, sid, ch);
  if (ch.entityType === 'tag') return applyTag(env, userId, sid, ch);
  if (ch.entityType === 'exchange_rate_override') return applyRateOverride(env, userId, sid, ch);
}

async function applyAccount(env: Env, userId: string, sid: string, ch: ChangeInput): Promise<void> {
  if (ch.action === 'delete') {
    await run(env.DB, `DELETE FROM user_accounts WHERE user_id = ? AND sync_id = ?`, userId, sid);
    return;
  }
  const existing = await one<any>(env.DB, `SELECT * FROM user_accounts WHERE user_id = ? AND sync_id = ?`, userId, sid);
  const p = ch.payload || {};
  const name = p.name ?? existing?.name ?? '';
  if (existing && name && name !== existing.name) {
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(`UPDATE read_tx SET account_name = ? WHERE account_sync_id = ? AND account_name = ?`).bind(
        name,
        sid,
        existing.name,
      ),
      env.DB.prepare(`UPDATE read_tx SET from_account_name = ? WHERE from_account_sync_id = ? AND from_account_name = ?`).bind(
        name,
        sid,
        existing.name,
      ),
      env.DB.prepare(`UPDATE read_tx SET to_account_name = ? WHERE to_account_sync_id = ? AND to_account_name = ?`).bind(
        name,
        sid,
        existing.name,
      ),
    ]);
  }
  await run(
    env.DB,
    `INSERT INTO user_accounts
      (user_id,sync_id,name,account_type,currency,initial_balance,note,credit_limit,billing_day,payment_due_day,bank_name,card_last_four,hidden,source_change_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id,sync_id) DO UPDATE SET
       name=excluded.name, account_type=excluded.account_type, currency=excluded.currency,
       initial_balance=excluded.initial_balance, note=excluded.note, credit_limit=excluded.credit_limit,
       billing_day=excluded.billing_day, payment_due_day=excluded.payment_due_day, bank_name=excluded.bank_name,
       card_last_four=excluded.card_last_four, hidden=excluded.hidden, source_change_id=excluded.source_change_id`,
    userId,
    sid,
    name,
    p.type ?? existing?.account_type ?? null,
    p.currency ?? existing?.currency ?? null,
    p.initialBalance ?? existing?.initial_balance ?? null,
    p.note !== undefined ? p.note : (existing?.note ?? null),
    p.creditLimit !== undefined ? p.creditLimit : (existing?.credit_limit ?? null),
    p.billingDay !== undefined ? p.billingDay : (existing?.billing_day ?? null),
    p.paymentDueDay !== undefined ? p.paymentDueDay : (existing?.payment_due_day ?? null),
    p.bankName !== undefined ? p.bankName : (existing?.bank_name ?? null),
    p.cardLastFour !== undefined ? p.cardLastFour : (existing?.card_last_four ?? null),
    p.hidden !== undefined ? sqlBool(p.hidden) : (existing?.hidden ?? 0),
    ch.changeId,
  );
}

async function applyCategory(env: Env, userId: string, sid: string, ch: ChangeInput): Promise<void> {
  if (ch.action === 'delete') {
    await run(env.DB, `DELETE FROM user_categories WHERE user_id = ? AND sync_id = ?`, userId, sid);
    return;
  }
  const existing = await one<any>(env.DB, `SELECT * FROM user_categories WHERE user_id = ? AND sync_id = ?`, userId, sid);
  const p = ch.payload || {};
  const name = p.name ?? existing?.name ?? '';
  const kind = p.kind ?? existing?.kind ?? null;
  if (existing && name && name !== existing.name) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE read_tx SET category_name = ? WHERE category_sync_id = ? AND category_name = ?`).bind(
        name,
        sid,
        existing.name,
      ),
      env.DB.prepare(`UPDATE read_tx SET category_kind = ? WHERE category_sync_id = ?`).bind(kind, sid),
    ]);
  }
  await run(
    env.DB,
    `INSERT INTO user_categories
      (user_id,sync_id,name,kind,level,sort_order,icon,icon_type,custom_icon_path,icon_cloud_file_id,icon_cloud_sha256,parent_name,parent_sync_id,source_change_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id,sync_id) DO UPDATE SET
       name=excluded.name, kind=excluded.kind, level=excluded.level, sort_order=excluded.sort_order,
       icon=excluded.icon, icon_type=excluded.icon_type, custom_icon_path=excluded.custom_icon_path,
       icon_cloud_file_id=excluded.icon_cloud_file_id, icon_cloud_sha256=excluded.icon_cloud_sha256,
       parent_name=excluded.parent_name, parent_sync_id=excluded.parent_sync_id, source_change_id=excluded.source_change_id`,
    userId,
    sid,
    name,
    kind,
    p.level ?? existing?.level ?? null,
    p.sortOrder ?? existing?.sort_order ?? null,
    p.icon !== undefined ? p.icon : (existing?.icon ?? null),
    p.iconType !== undefined ? p.iconType : (existing?.icon_type ?? null),
    p.customIconPath !== undefined ? p.customIconPath : (existing?.custom_icon_path ?? null),
    p.iconCloudFileId !== undefined ? p.iconCloudFileId : (existing?.icon_cloud_file_id ?? null),
    p.iconCloudSha256 !== undefined ? p.iconCloudSha256 : (existing?.icon_cloud_sha256 ?? null),
    p.parentName !== undefined ? p.parentName : (existing?.parent_name ?? null),
    p.parentSyncId !== undefined ? p.parentSyncId : (existing?.parent_sync_id ?? null),
    ch.changeId,
  );
}

async function applyTag(env: Env, userId: string, sid: string, ch: ChangeInput): Promise<void> {
  if (ch.action === 'delete') {
    await run(env.DB, `DELETE FROM user_tags WHERE user_id = ? AND sync_id = ?`, userId, sid);
    return;
  }
  const existing = await one<any>(env.DB, `SELECT * FROM user_tags WHERE user_id = ? AND sync_id = ?`, userId, sid);
  const p = ch.payload || {};
  const name = p.name ?? existing?.name ?? '';
  await run(
    env.DB,
    `INSERT INTO user_tags (user_id,sync_id,name,color,source_change_id) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id,sync_id) DO UPDATE SET name=excluded.name, color=excluded.color, source_change_id=excluded.source_change_id`,
    userId,
    sid,
    name,
    p.color !== undefined ? p.color : (existing?.color ?? null),
    ch.changeId,
  );
  if (existing && name && name !== existing.name) await rebuildTagNames(env, userId, sid);
}

async function rebuildTagNames(env: Env, userId: string, tagSid: string): Promise<void> {
  const tags = await all<{ sync_id: string; name: string }>(env.DB, `SELECT sync_id, name FROM user_tags WHERE user_id = ?`, userId);
  const map = new Map(tags.map((t) => [t.sync_id, t.name]));
  const rows = await all<{ ledger_id: string; sync_id: string; tag_sync_ids_json: string }>(
    env.DB,
    `SELECT ledger_id, sync_id, tag_sync_ids_json FROM read_tx WHERE tag_sync_ids_json LIKE ?`,
    `%${tagSid}%`,
  );
  for (const row of rows) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(row.tag_sync_ids_json || '[]');
    } catch {
      ids = [];
    }
    if (!Array.isArray(ids) || !ids.includes(tagSid)) continue;
    const csv = ids.map((id) => map.get(id)).filter(Boolean).join(',');
    await run(env.DB, `UPDATE read_tx SET tags_csv = ? WHERE ledger_id = ? AND sync_id = ?`, csv, row.ledger_id, row.sync_id);
  }
}

async function applyRateOverride(env: Env, userId: string, sid: string, ch: ChangeInput): Promise<void> {
  if (ch.action === 'delete') {
    const p = ch.payload || {};
    if (p.baseCurrency && p.quoteCurrency) {
      await run(env.DB, `DELETE FROM exchange_rate_overrides WHERE user_id=? AND base_currency=? AND quote_currency=?`, userId, p.baseCurrency, p.quoteCurrency);
    }
    await run(env.DB, `DELETE FROM exchange_rate_overrides WHERE user_id = ? AND sync_id = ?`, userId, sid);
    return;
  }
  const p = ch.payload || {};
  const existing = await one<any>(env.DB, `SELECT * FROM exchange_rate_overrides WHERE user_id = ? AND sync_id = ?`, userId, sid);
  const base = p.baseCurrency ?? existing?.base_currency;
  const quote = p.quoteCurrency ?? existing?.quote_currency;
  if (!base || !quote) return;
  await run(
    env.DB,
    `INSERT INTO exchange_rate_overrides (user_id,base_currency,quote_currency,rate,sync_id,updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id,base_currency,quote_currency) DO UPDATE SET rate=excluded.rate, sync_id=excluded.sync_id, updated_at=excluded.updated_at`,
    userId,
    base,
    quote,
    toFloat(p.rate, 0),
    sid,
    p.updatedAt || ch.updatedAt,
  );
}

/* ------------------------------------------------------------------ */
/* Ledger-scoped projections                                           */
/* ------------------------------------------------------------------ */

export async function applyLedgerChange(env: Env, ledger: LedgerRow, ch: ChangeInput): Promise<void> {
  if (ch.entityType === 'transaction') return applyTransaction(env, ledger, ch);
  if (ch.entityType === 'budget') return applyBudget(env, ledger, ch);
  if (ch.entityType === 'ledger') return applyLedgerMeta(env, ledger, ch);
}

async function applyLedgerMeta(env: Env, ledger: LedgerRow, ch: ChangeInput): Promise<void> {
  if (ch.action === 'delete') {
    await run(env.DB, `UPDATE ledgers SET deleted_at = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), ledger.id);
    return;
  }
  const p = ch.payload || {};
  const name = typeof p.ledgerName === 'string' && p.ledgerName.trim() ? p.ledgerName.trim() : ledger.name;
  const currency = typeof p.currency === 'string' && p.currency.trim() ? p.currency.trim().slice(0, 16) : ledger.currency;
  const monthStart = Number.isInteger(p.monthStartDay) ? Math.max(1, Math.min(28, p.monthStartDay)) : ledger.month_start_day;
  await run(
    env.DB,
    `UPDATE ledgers SET name = ?, currency = ?, month_start_day = ?, updated_at = ? WHERE id = ?`,
    name,
    currency,
    monthStart,
    nowIso(),
    ledger.id,
  );
}

function txFromRow(row: any, sid: string): Record<string, any> {
  if (!row) return {};
  return {
    syncId: row.sync_id,
    type: row.tx_type,
    amount: row.amount,
    happenedAt: row.happened_at,
    note: row.note,
    categoryId: row.category_sync_id,
    categoryName: row.category_name,
    categoryKind: row.category_kind,
    accountId: row.account_sync_id,
    accountName: row.account_name,
    fromAccountId: row.from_account_sync_id,
    fromAccountName: row.from_account_name,
    toAccountId: row.to_account_sync_id,
    toAccountName: row.to_account_name,
    tags: row.tags_csv,
    tagIds: row.tag_sync_ids_json ? JSON.parse(row.tag_sync_ids_json) : undefined,
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : undefined,
    txIndex: row.tx_index,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.last_edited_by_user_id,
    excludeFromStats: !!row.exclude_from_stats,
    excludeFromBudget: !!row.exclude_from_budget,
    currencyCode: row.currency_code,
    nativeAmount: row.native_amount,
  };
}

async function applyTransaction(env: Env, ledger: LedgerRow, ch: ChangeInput): Promise<void> {
  const sid = ch.entitySyncId;
  if (ch.action === 'delete') {
    await run(env.DB, `DELETE FROM read_tx WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
    return;
  }
  const existingRow = await one<any>(env.DB, `SELECT * FROM read_tx WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
  const prev = txFromRow(existingRow, sid);
  const p = ch.payload || {};

  const hadAmount = p.amount !== undefined && p.amount !== null;
  const amount = hadAmount ? toFloat(p.amount, 0) : toFloat(prev.amount, 0);
  let native = p.nativeAmount !== undefined ? (p.nativeAmount == null ? null : toFloat(p.nativeAmount, 0)) : (prev.nativeAmount ?? null);
  if (hadAmount && (p.nativeAmount === undefined || p.nativeAmount === null) && prev.nativeAmount != null && toFloat(prev.amount, 0) !== 0) {
    native = Math.round((amount * toFloat(prev.nativeAmount, 0) / toFloat(prev.amount, 0)) * 100) / 100;
  }

  const tagIds = p.tagIds !== undefined ? (Array.isArray(p.tagIds) ? p.tagIds : null) : (prev.tagIds ?? null);
  let tagsCsv: string | null = null;
  if (p.tags !== undefined) {
    tagsCsv = Array.isArray(p.tags) ? p.tags.join(',') : (p.tags == null ? null : String(p.tags));
  } else if (p.tagIds !== undefined) {
    if (tagIds?.length) {
      const rows = await all<{ sync_id: string; name: string }>(env.DB, `SELECT sync_id, name FROM user_tags WHERE user_id = ?`, ledger.user_id);
      const map = new Map(rows.map((r) => [r.sync_id, r.name]));
      tagsCsv = tagIds.map((id: string) => map.get(id)).filter(Boolean).join(',');
    } else tagsCsv = null;
  } else {
    tagsCsv = prev.tags ?? null;
  }

  const attachments = p.attachments !== undefined ? (Array.isArray(p.attachments) ? p.attachments : []) : (prev.attachments ?? []);
  let txIndex = p.txIndex !== undefined ? toInt(p.txIndex, 0) : (prev.txIndex ?? null);
  if (txIndex == null || txIndex === 0) {
    const maxRow = await one<{ n: number }>(env.DB, `SELECT COALESCE(MAX(tx_index),0) AS n FROM read_tx WHERE ledger_id = ?`, ledger.id);
    txIndex = Number(maxRow?.n || 0) + 1;
  }

  const happenedAt = p.happenedAt !== undefined ? String(p.happenedAt) : (prev.happenedAt || nowIso());
  const createdBy = prev.createdByUserId || p.createdByUserId || ch.actorUserId;
  const updatedBy = p.updatedByUserId || ch.actorUserId;

  await run(
    env.DB,
    `INSERT INTO read_tx
      (ledger_id,sync_id,tx_type,amount,happened_at,note,category_sync_id,category_name,category_kind,
       account_sync_id,account_name,from_account_sync_id,from_account_name,to_account_sync_id,to_account_name,
       tags_csv,tag_sync_ids_json,attachments_json,tx_index,currency_code,native_amount,
       exclude_from_stats,exclude_from_budget,created_by_user_id,last_edited_by_user_id,source_change_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ledger_id,sync_id) DO UPDATE SET
       tx_type=excluded.tx_type, amount=excluded.amount, happened_at=excluded.happened_at, note=excluded.note,
       category_sync_id=excluded.category_sync_id, category_name=excluded.category_name, category_kind=excluded.category_kind,
       account_sync_id=excluded.account_sync_id, account_name=excluded.account_name,
       from_account_sync_id=excluded.from_account_sync_id, from_account_name=excluded.from_account_name,
       to_account_sync_id=excluded.to_account_sync_id, to_account_name=excluded.to_account_name,
       tags_csv=excluded.tags_csv, tag_sync_ids_json=excluded.tag_sync_ids_json, attachments_json=excluded.attachments_json,
       tx_index=excluded.tx_index, currency_code=excluded.currency_code, native_amount=excluded.native_amount,
       exclude_from_stats=excluded.exclude_from_stats, exclude_from_budget=excluded.exclude_from_budget,
       created_by_user_id=COALESCE(read_tx.created_by_user_id, excluded.created_by_user_id),
       last_edited_by_user_id=excluded.last_edited_by_user_id, source_change_id=excluded.source_change_id`,
    ledger.id,
    sid,
    p.type ?? prev.type ?? 'expense',
    amount,
    happenedAt,
    p.note !== undefined ? p.note : (prev.note ?? null),
    p.categoryId !== undefined ? p.categoryId : (prev.categoryId ?? null),
    p.categoryName !== undefined ? p.categoryName : (prev.categoryName ?? null),
    p.categoryKind !== undefined ? p.categoryKind : (prev.categoryKind ?? null),
    p.accountId !== undefined ? p.accountId : (prev.accountId ?? null),
    p.accountName !== undefined ? p.accountName : (prev.accountName ?? null),
    p.fromAccountId !== undefined ? p.fromAccountId : (prev.fromAccountId ?? null),
    p.fromAccountName !== undefined ? p.fromAccountName : (prev.fromAccountName ?? null),
    p.toAccountId !== undefined ? p.toAccountId : (prev.toAccountId ?? null),
    p.toAccountName !== undefined ? p.toAccountName : (prev.toAccountName ?? null),
    tagsCsv,
    tagIds?.length ? JSON.stringify(tagIds) : null,
    attachments?.length ? JSON.stringify(attachments) : null,
    txIndex,
    p.currencyCode !== undefined ? p.currencyCode : (prev.currencyCode ?? null),
    native,
    p.excludeFromStats !== undefined ? sqlBool(p.excludeFromStats) : sqlBool(prev.excludeFromStats),
    p.excludeFromBudget !== undefined ? sqlBool(p.excludeFromBudget) : sqlBool(prev.excludeFromBudget),
    createdBy,
    updatedBy,
    ch.changeId,
  );
}

async function applyBudget(env: Env, ledger: LedgerRow, ch: ChangeInput): Promise<void> {
  const sid = ch.entitySyncId;
  if (ch.action === 'delete') {
    await run(env.DB, `DELETE FROM read_budgets WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
    return;
  }
  const existing = await one<any>(env.DB, `SELECT * FROM read_budgets WHERE ledger_id = ? AND sync_id = ?`, ledger.id, sid);
  const p = ch.payload || {};
  await run(
    env.DB,
    `INSERT INTO read_budgets (ledger_id,sync_id,budget_type,category_sync_id,amount,period,start_day,enabled,source_change_id)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ledger_id,sync_id) DO UPDATE SET
       budget_type=excluded.budget_type, category_sync_id=excluded.category_sync_id, amount=excluded.amount,
       period=excluded.period, start_day=excluded.start_day, enabled=excluded.enabled, source_change_id=excluded.source_change_id`,
    ledger.id,
    sid,
    p.type ?? existing?.budget_type ?? 'total',
    p.categoryId !== undefined ? p.categoryId : (existing?.category_sync_id ?? null),
    p.amount !== undefined ? toFloat(p.amount, 0) : (existing?.amount ?? 0),
    p.period ?? existing?.period ?? 'monthly',
    p.startDay !== undefined ? toInt(p.startDay, 1) : (existing?.start_day ?? 1),
    p.enabled !== undefined ? sqlBool(p.enabled) : (existing?.enabled ?? 1),
    ch.changeId,
  );
}
