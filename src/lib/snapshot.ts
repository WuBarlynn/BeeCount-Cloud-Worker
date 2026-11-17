import type { Env } from '../env';
import type { LedgerRow } from './ledger';
import { all } from './db';

export async function buildSnapshot(env: Env, ledger: LedgerRow): Promise<Record<string, any>> {
  const items = (
    await all<any>(
      env.DB,
      `SELECT * FROM read_tx WHERE ledger_id = ? ORDER BY happened_at DESC, tx_index DESC`,
      ledger.id,
    )
  ).map((row) => {
    const item: Record<string, any> = {
      syncId: row.sync_id,
      type: row.tx_type,
      amount: row.amount,
      happenedAt: row.happened_at,
      excludeFromStats: !!row.exclude_from_stats,
      excludeFromBudget: !!row.exclude_from_budget,
    };
    if (row.note != null) item.note = row.note;
    if (row.category_sync_id) item.categoryId = row.category_sync_id;
    if (row.category_name) item.categoryName = row.category_name;
    if (row.category_kind) item.categoryKind = row.category_kind;
    if (row.account_sync_id) item.accountId = row.account_sync_id;
    if (row.account_name) item.accountName = row.account_name;
    if (row.from_account_sync_id) item.fromAccountId = row.from_account_sync_id;
    if (row.from_account_name) item.fromAccountName = row.from_account_name;
    if (row.to_account_sync_id) item.toAccountId = row.to_account_sync_id;
    if (row.to_account_name) item.toAccountName = row.to_account_name;
    if (row.tags_csv) item.tags = row.tags_csv;
    if (row.tag_sync_ids_json) {
      try {
        const ids = JSON.parse(row.tag_sync_ids_json);
        if (Array.isArray(ids) && ids.length) item.tagIds = ids;
      } catch {
        /* ignore */
      }
    }
    if (row.attachments_json) {
      try {
        const atts = JSON.parse(row.attachments_json);
        if (Array.isArray(atts) && atts.length) item.attachments = atts;
      } catch {
        /* ignore */
      }
    }
    if (row.tx_index) item.txIndex = row.tx_index;
    if (row.created_by_user_id) item.createdByUserId = row.created_by_user_id;
    if (row.currency_code) item.currencyCode = row.currency_code;
    if (row.native_amount != null) item.nativeAmount = row.native_amount;
    return item;
  });

  const accounts = (
    await all<any>(env.DB, `SELECT * FROM user_accounts WHERE user_id = ? ORDER BY name`, ledger.user_id)
  ).map((row) => {
    const acc: Record<string, any> = { syncId: row.sync_id, name: row.name || '' };
    if (row.account_type) acc.type = row.account_type;
    if (row.currency) acc.currency = row.currency;
    if (row.initial_balance != null) acc.initialBalance = row.initial_balance;
    if (row.note) acc.note = row.note;
    if (row.credit_limit != null) acc.creditLimit = row.credit_limit;
    if (row.billing_day != null) acc.billingDay = row.billing_day;
    if (row.payment_due_day != null) acc.paymentDueDay = row.payment_due_day;
    if (row.bank_name) acc.bankName = row.bank_name;
    if (row.card_last_four) acc.cardLastFour = row.card_last_four;
    acc.hidden = !!row.hidden;
    return acc;
  });

  const categories = (
    await all<any>(
      env.DB,
      `SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC`,
      ledger.user_id,
    )
  ).map((row) => {
    const cat: Record<string, any> = { syncId: row.sync_id, name: row.name || '' };
    if (row.kind) cat.kind = row.kind;
    if (row.level != null) cat.level = row.level;
    if (row.sort_order != null) cat.sortOrder = row.sort_order;
    if (row.icon) cat.icon = row.icon;
    if (row.icon_type) cat.iconType = row.icon_type;
    if (row.custom_icon_path) cat.customIconPath = row.custom_icon_path;
    if (row.icon_cloud_file_id) cat.iconCloudFileId = row.icon_cloud_file_id;
    if (row.icon_cloud_sha256) cat.iconCloudSha256 = row.icon_cloud_sha256;
    if (row.parent_name) cat.parentName = row.parent_name;
    if (row.parent_sync_id) cat.parentSyncId = row.parent_sync_id;
    return cat;
  });

  const tags = (
    await all<any>(env.DB, `SELECT * FROM user_tags WHERE user_id = ? ORDER BY name ASC`, ledger.user_id)
  ).map((row) => {
    const tag: Record<string, any> = { syncId: row.sync_id, name: row.name || '' };
    if (row.color) tag.color = row.color;
    return tag;
  });

  const budgets = (
    await all<any>(
      env.DB,
      `SELECT * FROM read_budgets WHERE ledger_id = ? ORDER BY budget_type, category_sync_id`,
      ledger.id,
    )
  ).map((row) => {
    const b: Record<string, any> = { syncId: row.sync_id, ledgerSyncId: ledger.external_id };
    if (row.budget_type) b.type = row.budget_type;
    if (row.category_sync_id) b.categoryId = row.category_sync_id;
    if (row.amount != null) b.amount = row.amount;
    if (row.period) b.period = row.period;
    if (row.start_day != null) b.startDay = row.start_day;
    b.enabled = !!row.enabled;
    return b;
  });

  return {
    ledgerSyncId: ledger.external_id,
    ledgerName: ledger.name || ledger.external_id,
    currency: ledger.currency || 'CNY',
    monthStartDay: ledger.month_start_day || 1,
    count: items.length,
    items,
    accounts,
    categories,
    tags,
    budgets,
  };
}
