import { parseJson } from './util';

export function mapTx(row: any, extra: Record<string, any> = {}): Record<string, any> {
  const tagIds = parseJson<string[]>(row.tag_sync_ids_json, []);
  return {
    id: row.sync_id,
    tx_index: row.tx_index ?? 0,
    tx_type: row.tx_type,
    amount: row.amount ?? 0,
    happened_at: row.happened_at,
    note: row.note ?? null,
    category_name: row.category_name ?? null,
    category_kind: row.category_kind ?? null,
    category_id: row.category_sync_id ?? null,
    account_name: row.account_name ?? null,
    account_id: row.account_sync_id ?? null,
    from_account_name: row.from_account_name ?? null,
    from_account_id: row.from_account_sync_id ?? null,
    to_account_name: row.to_account_name ?? null,
    to_account_id: row.to_account_sync_id ?? null,
    tags: row.tags_csv ?? null,
    tags_list: row.tags_csv ? String(row.tags_csv).split(',').filter(Boolean) : [],
    tag_ids: Array.isArray(tagIds) ? tagIds : [],
    attachments: parseJson<any[]>(row.attachments_json, []).length ? parseJson<any[]>(row.attachments_json, []) : null,
    exclude_from_stats: !!row.exclude_from_stats,
    exclude_from_budget: !!row.exclude_from_budget,
    currency_code: row.currency_code ?? null,
    native_amount: row.native_amount ?? null,
    last_change_id: row.source_change_id ?? 0,
    created_by_user_id: row.created_by_user_id ?? null,
    last_edited_by_user_id: row.last_edited_by_user_id ?? null,
    ...extra,
  };
}

export function mapAccount(row: any, extra: Record<string, any> = {}): Record<string, any> {
  return {
    id: row.sync_id,
    name: row.name,
    account_type: row.account_type ?? null,
    currency: row.currency ?? null,
    initial_balance: row.initial_balance ?? null,
    note: row.note ?? null,
    credit_limit: row.credit_limit ?? null,
    billing_day: row.billing_day ?? null,
    payment_due_day: row.payment_due_day ?? null,
    bank_name: row.bank_name ?? null,
    card_last_four: row.card_last_four ?? null,
    hidden: !!row.hidden,
    last_change_id: row.source_change_id ?? 0,
    ...extra,
  };
}

export function mapCategory(row: any, extra: Record<string, any> = {}): Record<string, any> {
  return {
    id: row.sync_id,
    name: row.name,
    kind: row.kind ?? 'expense',
    level: row.level ?? null,
    sort_order: row.sort_order ?? null,
    icon: row.icon ?? null,
    icon_type: row.icon_type ?? null,
    custom_icon_path: row.custom_icon_path ?? null,
    icon_cloud_file_id: row.icon_cloud_file_id ?? null,
    icon_cloud_sha256: row.icon_cloud_sha256 ?? null,
    parent_name: row.parent_name ?? null,
    parent_sync_id: row.parent_sync_id ?? null,
    last_change_id: row.source_change_id ?? 0,
    ...extra,
  };
}

export function mapTag(row: any, extra: Record<string, any> = {}): Record<string, any> {
  return {
    id: row.sync_id,
    name: row.name,
    color: row.color ?? null,
    last_change_id: row.source_change_id ?? 0,
    ...extra,
  };
}

export function mapBudget(row: any, categoryName: string | null, extra: Record<string, any> = {}): Record<string, any> {
  return {
    id: row.sync_id,
    type: row.budget_type || 'total',
    category_id: row.category_sync_id ?? null,
    category_name: categoryName,
    amount: row.amount ?? 0,
    period: row.period || 'monthly',
    start_day: row.start_day ?? 1,
    enabled: !!row.enabled,
    last_change_id: row.source_change_id ?? 0,
    ...extra,
  };
}

export function mapLedger(row: any, stats: { tx: number; income: number; expense: number; balance: number }, extra: Record<string, any> = {}): Record<string, any> {
  return {
    ledger_id: row.external_id,
    ledger_name: row.name || row.external_id,
    currency: row.currency || 'CNY',
    month_start_day: row.month_start_day || 1,
    transaction_count: stats.tx,
    income_total: stats.income,
    expense_total: stats.expense,
    balance: stats.balance,
    exported_at: row.exported_at ?? null,
    updated_at: row.updated_at,
    role: row.role || 'owner',
    ...extra,
  };
}
