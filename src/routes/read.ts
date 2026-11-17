import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, SCOPE_OPS_WRITE, requireScopes } from '../lib/auth';
import { HttpError, csvEscape, localDateKey, monthKey, parseJson, toFloat, toInt } from '../lib/util';
import { all, one } from '../lib/db';
import { listAccessibleLedgers, requireLedger, type LedgerRow } from '../lib/ledger';
import { mapAccount, mapBudget, mapCategory, mapLedger, mapTag, mapTx } from '../lib/mappers';

export const readRoutes = new Hono<AppContext>();

readRoutes.use('*', authMiddleware());

const readScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, SCOPE_OPS_WRITE);
readRoutes.use('*', readScope);

type Totals = { tx: number; income: number; expense: number; balance: number };
const EMPTY_TOTALS: Totals = { tx: 0, income: 0, expense: 0, balance: 0 };

async function ledgerTotals(env: AppContext['Bindings'], ledgerId: string): Promise<Totals> {
  const row = await one<any>(
    env.DB,
    `SELECT COUNT(*) AS tx,
       COALESCE(SUM(CASE WHEN tx_type='income' AND exclude_from_stats=0 THEN COALESCE(native_amount,amount) ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN tx_type='expense' AND exclude_from_stats=0 THEN COALESCE(native_amount,amount) ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN tx_type='income' THEN COALESCE(native_amount,amount) WHEN tx_type='expense' THEN -COALESCE(native_amount,amount) ELSE 0 END),0) AS balance
     FROM read_tx WHERE ledger_id = ?`,
    ledgerId,
  );
  return { tx: Number(row?.tx || 0), income: Number(row?.income || 0), expense: Number(row?.expense || 0), balance: Number(row?.balance || 0) };
}

async function visibleLedgers(c: any, ledgerExternalId?: string | null, userIdFilter?: string | null): Promise<LedgerRow[]> {
  const allL = await listAccessibleLedgers(c.env, c.get('auth').user.id);
  let rows = ledgerExternalId ? allL.filter((l) => l.external_id === ledgerExternalId) : allL;
  if (userIdFilter) {
    const found: LedgerRow[] = [];
    for (const l of rows) {
      const r = await one<any>(
        c.env.DB,
        `SELECT 1 AS x FROM read_tx WHERE ledger_id = ? AND created_by_user_id = ? LIMIT 1`,
        l.id,
        userIdFilter,
      );
      if (r) found.push(l);
    }
    rows = found;
  }
  return rows;
}

function profileExtras(row: any, users: Map<string, any>): Record<string, any> {
  const uid = row.created_by_user_id || row.last_edited_by_user_id;
  const u = uid ? users.get(uid) : null;
  return {
    created_by_email: u?.email ?? null,
    created_by_display_name: u?.display_name ?? null,
    created_by_avatar_url: u ? `/api/v1/profile/avatar/${u.id}` : null,
    created_by_avatar_version: u?.avatar_version ?? 0,
    last_edited_by_email: null,
    last_edited_by_display_name: null,
    last_edited_by_avatar_url: null,
    last_edited_by_avatar_version: null,
  };
}

async function userMap(env: AppContext['Bindings'], ids: string[]): Promise<Map<string, any>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const ph = unique.map(() => '?').join(',');
  const rows = await all<any>(
    env.DB,
    `SELECT u.id,u.email,p.display_name,p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id IN (${ph})`,
    ...unique,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/* ------------------------------------------------------------------ */
/* Ledgers                                                             */
/* ------------------------------------------------------------------ */

readRoutes.get('/ledgers', async (c) => {
  const ledgers = await listAccessibleLedgers(c.env, c.get('auth').user.id);
  const out: any[] = [];
  for (const l of ledgers) {
    const stats = await ledgerTotals(c.env, l.id);
    const members = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM ledger_members WHERE ledger_id=?`, l.id);
    const memberCount = Number(members?.n || 0);
    out.push(
      mapLedger(l, stats, { is_shared: memberCount > 1, member_count: memberCount }),
    );
  }
  return c.json(out);
});

readRoutes.get('/ledgers/:id', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const stats = await ledgerTotals(c.env, l.id);
  const latest = await one<{ n: number }>(c.env.DB, `SELECT COALESCE(MAX(change_id),0) AS n FROM sync_changes WHERE ledger_id=?`, l.id);
  const members = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM ledger_members WHERE ledger_id=?`, l.id);
  const memberCount = Number(members?.n || 0);
  return c.json(
    mapLedger(l, stats, {
      source_change_id: Number(latest?.n || 0),
      is_shared: memberCount > 1,
      member_count: memberCount,
    }),
  );
});

readRoutes.get('/ledgers/:id/transactions', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const limit = Math.max(1, Math.min(5000, toInt(c.req.query('limit'), 500)));
  const q = (c.req.query('q') || '').trim();
  const txType = c.req.query('tx_type');
  const where: string[] = ['ledger_id = ?'];
  const binds: unknown[] = [l.id];
  if (txType) {
    where.push('tx_type = ?');
    binds.push(txType);
  }
  if (q) {
    where.push(`(note LIKE ? OR category_name LIKE ? OR account_name LIKE ? OR tags_csv LIKE ? OR CAST(amount AS TEXT) LIKE ?)`);
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }
  const rows = await all<any>(
    c.env.DB,
    `SELECT * FROM read_tx WHERE ${where.join(' AND ')} ORDER BY happened_at DESC, tx_index DESC LIMIT ?`,
    ...binds,
    limit,
  );
  const users = await userMap(c.env, rows.flatMap((r) => [r.created_by_user_id, r.last_edited_by_user_id]));
  return c.json(rows.map((r) => mapTx(r, profileExtras(r, users))));
});

readRoutes.get('/ledgers/:id/accounts', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const rows = await all<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id=? ORDER BY name`, l.user_id);
  return c.json(rows.map((r) => mapAccount(r, { ledger_id: null, ledger_name: null })));
});

readRoutes.get('/ledgers/:id/categories', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const rows = await all<any>(
    c.env.DB,
    `SELECT * FROM user_categories WHERE user_id=? ORDER BY sort_order ASC, name ASC`,
    l.user_id,
  );
  return c.json(rows.map((r) => mapCategory(r, { ledger_id: null, ledger_name: null })));
});

readRoutes.get('/ledgers/:id/tags', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const rows = await all<any>(c.env.DB, `SELECT * FROM user_tags WHERE user_id=? ORDER BY name`, l.user_id);
  return c.json(rows.map((r) => mapTag(r, { ledger_id: null, ledger_name: null })));
});

readRoutes.get('/ledgers/:id/budgets', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const rows = await all<any>(c.env.DB, `SELECT * FROM read_budgets WHERE ledger_id=?`, l.id);
  const cats = await all<any>(c.env.DB, `SELECT sync_id,name FROM user_categories WHERE user_id=?`, l.user_id);
  const catMap = new Map(cats.map((r) => [r.sync_id, r.name]));
  const dedup = new Map<string, any>();
  for (const r of rows) {
    const key = `${r.budget_type || 'total'}|${r.category_sync_id || ''}`;
    const cur = dedup.get(key);
    if (!cur || String(cur.sync_id) < String(r.sync_id)) dedup.set(key, r);
  }
  const out = [...dedup.values()]
    .filter((r) => (r.budget_type || 'total') !== 'category' || r.category_sync_id)
    .map((r) => mapBudget(r, r.category_sync_id ? catMap.get(r.category_sync_id) ?? null : null, { ledger_id: l.external_id, ledger_name: l.name }));
  return c.json(out);
});

readRoutes.get('/ledgers/:id/budgets/usage', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const rows = await all<any>(c.env.DB, `SELECT * FROM read_budgets WHERE ledger_id=?`, l.id);
  const cats = await all<any>(c.env.DB, `SELECT sync_id,parent_sync_id FROM user_categories WHERE user_id=?`, l.user_id);
  const children = new Map<string, string[]>();
  for (const cat of cats) {
    if (!cat.parent_sync_id) continue;
    if (!children.has(cat.parent_sync_id)) children.set(cat.parent_sync_id, []);
    children.get(cat.parent_sync_id)!.push(cat.sync_id);
  }
  const { start, end } = budgetPeriod(new Date(), l.month_start_day || 1, c.req.query('tz_offset_minutes'));
  const txs = await all<any>(
    c.env.DB,
    `SELECT category_sync_id, COALESCE(native_amount,amount) AS amount FROM read_tx
     WHERE ledger_id=? AND tx_type='expense' AND exclude_from_budget=0 AND happened_at>=? AND happened_at<?`,
    l.id,
    start,
    end,
  );
  const dedup = new Map<string, any>();
  for (const r of rows) {
    const key = `${r.budget_type || 'total'}|${r.category_sync_id || ''}`;
    const cur = dedup.get(key);
    if (!cur || String(cur.sync_id) < String(r.sync_id)) dedup.set(key, r);
  }
  const items: any[] = [];
  for (const b of dedup.values()) {
    let used = 0;
    if ((b.budget_type || 'total') === 'total') {
      used = txs.reduce((s, t) => s + Number(t.amount || 0), 0);
    } else if (b.category_sync_id) {
      const ids = new Set<string>([b.category_sync_id, ...(children.get(b.category_sync_id) || [])]);
      used = txs.filter((t) => ids.has(t.category_sync_id)).reduce((s, t) => s + Number(t.amount || 0), 0);
    }
    items.push({ budget_id: b.sync_id, used: Math.round(used * 100) / 100 });
  }
  return c.json({ items });
});

readRoutes.get('/ledgers/:id/stats', async (c) => {
  const l = await requireLedger(c.env, c.get('auth').user.id, c.req.param('id'));
  const count = async (sql: string, ...binds: unknown[]) =>
    Number((await one<{ n: number }>(c.env.DB, sql, ...binds))?.n || 0);
  const ledgerIds = (await listAccessibleLedgers(c.env, c.get('auth').user.id)).map((x) => x.id);
  const inClause = ledgerIds.length ? ledgerIds.map(() => '?').join(',') : `''`;
  return c.json({
    transaction_count: await count(`SELECT COUNT(*) AS n FROM read_tx WHERE ledger_id=?`, l.id),
    transaction_total: await count(`SELECT COUNT(*) AS n FROM read_tx WHERE ledger_id IN (${inClause})`, ...ledgerIds),
    attachment_count: await count(`SELECT COUNT(*) AS n FROM attachments WHERE ledger_id=? AND kind='transaction'`, l.id),
    attachment_total: await count(
      `SELECT COUNT(*) AS n FROM attachments WHERE kind='transaction' AND ledger_id IN (${inClause})`,
      ...ledgerIds,
    ),
    category_attachment_total: await count(
      `SELECT COUNT(*) AS n FROM attachments WHERE user_id=? AND kind='category_icon'`,
      c.get('auth').user.id,
    ),
    budget_count: await count(`SELECT COUNT(*) AS n FROM read_budgets WHERE ledger_id=?`, l.id),
    budget_total: await count(`SELECT COUNT(*) AS n FROM read_budgets WHERE ledger_id IN (${inClause})`, ...ledgerIds),
    account_count: await count(`SELECT COUNT(*) AS n FROM user_accounts WHERE user_id=?`, l.user_id),
    account_total: await count(`SELECT COUNT(*) AS n FROM user_accounts WHERE user_id=?`, l.user_id),
    category_count: await count(`SELECT COUNT(*) AS n FROM user_categories WHERE user_id=?`, l.user_id),
    category_total: await count(`SELECT COUNT(*) AS n FROM user_categories WHERE user_id=?`, l.user_id),
    tag_count: await count(`SELECT COUNT(*) AS n FROM user_tags WHERE user_id=?`, l.user_id),
    tag_total: await count(`SELECT COUNT(*) AS n FROM user_tags WHERE user_id=?`, l.user_id),
  });
});

readRoutes.get('/summary', async (c) => {
  const external = c.req.query('ledger_id') || '';
  const l = await requireLedger(c.env, c.get('auth').user.id, external);
  const stats = await ledgerTotals(c.env, l.id);
  const latest = await one<any>(
    c.env.DB,
    `SELECT happened_at FROM read_tx WHERE ledger_id=? ORDER BY happened_at DESC LIMIT 1`,
    l.id,
  );
  return c.json({
    ledger_id: external,
    transaction_count: stats.tx,
    income_total: stats.income,
    expense_total: stats.expense,
    balance: stats.balance,
    latest_happened_at: latest?.happened_at ?? null,
  });
});

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

type TxFilters = {
  ledgerId?: string | null;
  userId?: string | null;
  q?: string;
  txType?: string;
  accountName?: string;
  txSyncId?: string;
  tagSyncId?: string;
  categorySyncId?: string;
  accountSyncId?: string;
  amountMin?: number;
  amountMax?: number;
  dateFrom?: string;
  dateTo?: string;
};

async function queryWorkspaceTransactions(c: any, f: TxFilters, limit: number, offset: number) {
  const ledgers = await visibleLedgers(c, f.ledgerId, f.userId);
  if (!ledgers.length) return { rows: [], total: 0, ledgers };
  const ids = ledgers.map((l) => l.id);
  const inClause = ids.map(() => '?').join(',');
  const where: string[] = [`ledger_id IN (${inClause})`];
  const binds: unknown[] = [...ids];
  if (f.txType) {
    where.push('tx_type = ?');
    binds.push(f.txType);
  }
  if (f.q) {
    where.push('(note LIKE ? OR category_name LIKE ? OR account_name LIKE ? OR tags_csv LIKE ? OR CAST(amount AS TEXT) LIKE ?)');
    const like = `%${f.q}%`;
    binds.push(like, like, like, like, like);
  }
  if (f.accountName) {
    where.push('(account_name = ? OR from_account_name = ? OR to_account_name = ?)');
    binds.push(f.accountName, f.accountName, f.accountName);
  }
  if (f.txSyncId) {
    where.push('sync_id = ?');
    binds.push(f.txSyncId);
  }
  if (f.categorySyncId) {
    where.push('category_sync_id = ?');
    binds.push(f.categorySyncId);
  }
  if (f.accountSyncId) {
    where.push('(account_sync_id = ? OR from_account_sync_id = ? OR to_account_sync_id = ?)');
    binds.push(f.accountSyncId, f.accountSyncId, f.accountSyncId);
  }
  if (f.tagSyncId) {
    where.push(`tag_sync_ids_json LIKE ?`);
    binds.push(`%${f.tagSyncId}%`);
  }
  if (Number.isFinite(f.amountMin)) {
    where.push('ABS(amount) >= ?');
    binds.push(f.amountMin);
  }
  if (Number.isFinite(f.amountMax)) {
    where.push('ABS(amount) <= ?');
    binds.push(f.amountMax);
  }
  if (f.dateFrom) {
    where.push('happened_at >= ?');
    binds.push(f.dateFrom);
  }
  if (f.dateTo) {
    where.push('happened_at < ?');
    binds.push(f.dateTo);
  }
  const whereSql = where.join(' AND ');
  const totalRow = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM read_tx WHERE ${whereSql}`, ...binds);
  const rows = await all<any>(
    c.env.DB,
    `SELECT * FROM read_tx WHERE ${whereSql} ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    offset,
  );
  return { rows, total: Number(totalRow?.n || 0), ledgers };
}

function txFilters(c: any): TxFilters {
  const q = c.req.query();
  return {
    ledgerId: q.ledger_id || null,
    userId: q.user_id || null,
    q: q.q || '',
    txType: q.tx_type || '',
    accountName: q.account_name || '',
    txSyncId: q.tx_sync_id || '',
    tagSyncId: q.tag_sync_id || '',
    categorySyncId: q.category_sync_id || '',
    accountSyncId: q.account_sync_id || '',
    amountMin: q.amount_min != null ? toFloat(q.amount_min, NaN) : undefined,
    amountMax: q.amount_max != null ? toFloat(q.amount_max, NaN) : undefined,
    dateFrom: q.date_from || '',
    dateTo: q.date_to || '',
  };
}

readRoutes.get('/workspace/transactions', async (c) => {
  const limit = Math.max(1, Math.min(1000, toInt(c.req.query('limit'), 100)));
  const offset = Math.max(0, toInt(c.req.query('offset'), 0));
  const { rows, total, ledgers } = await queryWorkspaceTransactions(c, txFilters(c), limit, offset);
  const ledgerMap = new Map(ledgers.map((l) => [l.id, l]));
  const users = await userMap(c.env, rows.flatMap((r) => [r.created_by_user_id, r.last_edited_by_user_id]));
  const items = rows.map((r) => {
    const l = ledgerMap.get(r.ledger_id);
    return mapTx(r, {
      ledger_id: l?.external_id ?? null,
      ledger_name: l?.name ?? null,
      ...profileExtras(r, users),
    });
  });
  return c.json({ items, total, limit, offset });
});

readRoutes.get('/workspace/transactions.csv', async (c) => {
  const { rows, ledgers } = await queryWorkspaceTransactions(c, txFilters(c), 100000, 0);
  const ledgerMap = new Map(ledgers.map((l) => [l.id, l]));
  const tz = toInt(c.req.query('tz_offset_minutes'), 0);
  const lang = (c.req.query('lang') || 'en').toLowerCase();
  const zh = lang.startsWith('zh');
  const header = zh
    ? ['日期', '时间', '类型', '金额', '币种', '分类', '账户', '转出', '转入', '标签', '备注', '账本']
    : ['Date', 'Time', 'Type', 'Amount', 'Currency', 'Category', 'Account', 'From', 'To', 'Tags', 'Note', 'Ledger'];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    const l = ledgerMap.get(r.ledger_id);
    const d = new Date(Date.parse(r.happened_at) + tz * 60000).toISOString();
    lines.push(
      [
        d.slice(0, 10),
        d.slice(11, 16),
        r.tx_type,
        r.amount,
        r.currency_code || l?.currency || '',
        r.category_name || '',
        r.account_name || '',
        r.from_account_name || '',
        r.to_account_name || '',
        r.tags_csv || '',
        r.note || '',
        l?.name || '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  const filename = `beecount-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response('\ufeff' + lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
});

readRoutes.get('/workspace/accounts', async (c) => {
  const ledgerId = c.req.query('ledger_id') || null;
  const ledgers = await visibleLedgers(c, ledgerId, c.req.query('user_id') || null);
  const seen = new Map<string, any>();
  for (const l of ledgers) {
    const rows = await all<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id=?`, l.user_id);
    for (const row of rows) {
      const prev = seen.get(row.sync_id);
      if (!prev || Number(prev.source_change_id) < Number(row.source_change_id)) {
        const agg = await one<any>(
          c.env.DB,
          `SELECT COUNT(*) AS tx_count,
             COALESCE(SUM(CASE WHEN tx_type='income' AND (account_sync_id=? OR to_account_sync_id=?) THEN amount
                               WHEN tx_type='expense' AND (account_sync_id=? OR from_account_sync_id=?) THEN -amount
                               WHEN tx_type='transfer' AND from_account_sync_id=? THEN -amount
                               WHEN tx_type='transfer' AND to_account_sync_id=? THEN amount ELSE 0 END),0) AS delta
           FROM read_tx WHERE ledger_id=? AND (account_sync_id=? OR from_account_sync_id=? OR to_account_sync_id=?)`,
          row.sync_id,
          row.sync_id,
          row.sync_id,
          row.sync_id,
          row.sync_id,
          row.sync_id,
          l.id,
          row.sync_id,
          row.sync_id,
          row.sync_id,
        );
        const balance = Number(row.initial_balance || 0) + Number(agg?.delta || 0);
        seen.set(
          row.sync_id,
          mapAccount(row, {
            ledger_id: l.external_id,
            ledger_name: l.name,
            created_by_user_id: l.user_id,
            created_by_email: null,
            tx_count: Number(agg?.tx_count || 0),
            balance,
          }),
        );
      }
    }
  }
  return c.json([...seen.values()]);
});

readRoutes.get('/workspace/categories', async (c) => {
  const ledgers = await visibleLedgers(c, c.req.query('ledger_id') || null, c.req.query('user_id') || null);
  const seen = new Map<string, any>();
  for (const l of ledgers) {
    const rows = await all<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id=? ORDER BY sort_order, name`, l.user_id);
    for (const row of rows) {
      const prev = seen.get(row.sync_id);
      if (prev && Number(prev.last_change_id) >= Number(row.source_change_id)) continue;
      const cnt = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM read_tx WHERE ledger_id=? AND category_sync_id=?`, l.id, row.sync_id);
      seen.set(
        row.sync_id,
        mapCategory(row, {
          ledger_id: l.external_id,
          ledger_name: l.name,
          created_by_user_id: l.user_id,
          created_by_email: null,
          tx_count: Number(cnt?.n || 0),
        }),
      );
    }
  }
  return c.json([...seen.values()]);
});

readRoutes.get('/workspace/tags', async (c) => {
  const ledgers = await visibleLedgers(c, c.req.query('ledger_id') || null, c.req.query('user_id') || null);
  const seen = new Map<string, any>();
  for (const l of ledgers) {
    const rows = await all<any>(c.env.DB, `SELECT * FROM user_tags WHERE user_id=? ORDER BY name`, l.user_id);
    for (const row of rows) {
      const prev = seen.get(row.sync_id);
      if (prev && Number(prev.last_change_id) >= Number(row.source_change_id)) continue;
      const cnt = await one<{ n: number; exp: number; inc: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN tx_type='expense' THEN amount ELSE 0 END),0) AS exp,
           COALESCE(SUM(CASE WHEN tx_type='income' THEN amount ELSE 0 END),0) AS inc
         FROM read_tx WHERE ledger_id=? AND tag_sync_ids_json LIKE ?`,
        l.id,
        `%${row.sync_id}%`,
      );
      seen.set(
        row.sync_id,
        mapTag(row, {
          ledger_id: l.external_id,
          ledger_name: l.name,
          created_by_user_id: l.user_id,
          created_by_email: null,
          tx_count: Number(cnt?.n || 0),
          expense_total: Number(cnt?.exp || 0),
          income_total: Number(cnt?.inc || 0),
        }),
      );
    }
  }
  return c.json([...seen.values()]);
});

readRoutes.get('/workspace/ledger-counts', async (c) => {
  const ledgers = await visibleLedgers(c, c.req.query('ledger_id') || null, c.req.query('user_id') || null);
  if (!ledgers.length) return c.json({ tx_count: 0, days_since_first_tx: 0, distinct_days: 0, first_tx_at: null });
  const ids = ledgers.map((l) => l.id);
  const ph = ids.map(() => '?').join(',');
  const tz = toInt(c.req.query('tz_offset_minutes'), 0);
  const row = await one<any>(
    c.env.DB,
    `SELECT COUNT(*) AS n, MIN(happened_at) AS first FROM read_tx WHERE ledger_id IN (${ph})`,
    ...ids,
  );
  const rows = await all<any>(c.env.DB, `SELECT happened_at FROM read_tx WHERE ledger_id IN (${ph})`, ...ids);
  const days = new Set(rows.map((r) => localDateKey(r.happened_at, tz)));
  const first = row?.first ? Date.parse(row.first) : null;
  const today = new Date(Date.now() + tz * 60000);
  const todayKey = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const firstLocal = first != null ? new Date(first + tz * 60000) : null;
  const firstKey = firstLocal
    ? Date.UTC(firstLocal.getUTCFullYear(), firstLocal.getUTCMonth(), firstLocal.getUTCDate())
    : null;
  return c.json({
    tx_count: Number(row?.n || 0),
    days_since_first_tx: firstKey != null ? Math.floor((todayKey - firstKey) / 86400000) + 1 : 0,
    distinct_days: days.size,
    first_tx_at: row?.first ?? null,
  });
});

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

function clampMsd(v: number): number {
  return Math.max(1, Math.min(28, v || 1));
}

function analyticsRange(scope: string, period: string | null, tzOffset: number, msd: number) {
  const day = clampMsd(msd);
  if (scope === 'all') return { start: null as string | null, end: null as string | null, period: null as string | null };
  const localNow = new Date(Date.now() + tzOffset * 60000);
  if (scope === 'month') {
    let target = period;
    if (!target) {
      let y = localNow.getUTCFullYear();
      let m = localNow.getUTCMonth() + 1;
      if (localNow.getUTCDate() < day) {
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
      target = `${y}-${String(m).padStart(2, '0')}`;
    }
    const [ys, ms] = target.split('-');
    const y = Number(ys);
    const m = Number(ms);
    if (!y || !m || m < 1 || m > 12) throw new HttpError(400, 'Invalid analytics period');
    const startMs = Date.UTC(y, m - 1, day) - tzOffset * 60000;
    const endMs = (m === 12 ? Date.UTC(y + 1, 0, day) : Date.UTC(y, m, day)) - tzOffset * 60000;
    return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), period: target };
  }
  let target = period;
  if (!target) {
    let y = localNow.getUTCFullYear();
    if (localNow.getUTCMonth() === 0 && localNow.getUTCDate() < day) y -= 1;
    target = String(y);
  }
  const y = Number(target);
  if (!y) throw new HttpError(400, 'Invalid analytics period');
  const startMs = Date.UTC(y, 0, day) - tzOffset * 60000;
  const endMs = Date.UTC(y + 1, 0, day) - tzOffset * 60000;
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), period: target };
}

function bucketFor(scope: string, iso: string, tzOffset: number, msd: number): string {
  if (scope === 'month') return localDateKey(iso, tzOffset);
  return monthKey(iso, tzOffset, clampMsd(msd));
}

readRoutes.get('/workspace/analytics', async (c) => {
  const scope = c.req.query('scope') || 'month';
  const metric = c.req.query('metric') || 'expense';
  const tz = toInt(c.req.query('tz_offset_minutes'), 0);
  const natural = c.req.query('natural_month') === 'true';
  let ledgers = await visibleLedgers(c, c.req.query('ledger_id') || null, c.req.query('user_id') || null);
  const msd = natural || ledgers.length !== 1 ? 1 : ledgers[0].month_start_day || 1;
  const range = analyticsRange(scope, c.req.query('period') || null, tz, msd);
  if (!ledgers.length) {
    return c.json({
      summary: { transaction_count: 0, income_total: 0, expense_total: 0, balance: 0, distinct_days: 0, first_tx_at: null, last_tx_at: null },
      series: [],
      category_ranks: [],
      anomaly_months: [],
      range: { scope, metric, period: range.period, start_at: null, end_at: null },
    });
  }
  const ids = ledgers.map((l) => l.id);
  const ph = ids.map(() => '?').join(',');
  const where = [`ledger_id IN (${ph})`, 'exclude_from_stats=0'];
  const binds: unknown[] = [...ids];
  if (range.start) {
    where.push('happened_at >= ?');
    binds.push(range.start);
  }
  if (range.end) {
    where.push('happened_at < ?');
    binds.push(range.end);
  }
  const rows = await all<any>(
    c.env.DB,
    `SELECT tx_type, COALESCE(native_amount,amount) AS amount, happened_at, category_name FROM read_tx WHERE ${where.join(' AND ')}`,
    ...binds,
  );
  let income = 0;
  let expense = 0;
  let first: string | null = null;
  let last: string | null = null;
  const days = new Set<string>();
  const seriesMap = new Map<string, { expense: number; income: number }>();
  const catMap = new Map<string, { income: number; expense: number; count: number }>();
  const catByBucket = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const amt = Number(r.amount || 0);
    const localDay = localDateKey(r.happened_at, tz);
    days.add(localDay);
    if (!first || r.happened_at < first) first = r.happened_at;
    if (!last || r.happened_at > last) last = r.happened_at;
    const bucket = bucketFor(scope, r.happened_at, tz, msd);
    if (!seriesMap.has(bucket)) seriesMap.set(bucket, { expense: 0, income: 0 });
    const slot = seriesMap.get(bucket)!;
    const cat = (r.category_name || '').trim() || 'Uncategorized';
    if (!catMap.has(cat)) catMap.set(cat, { income: 0, expense: 0, count: 0 });
    const cs = catMap.get(cat)!;
    cs.count += 1;
    if (r.tx_type === 'income') {
      income += amt;
      slot.income += amt;
      cs.income += amt;
    } else if (r.tx_type === 'expense') {
      expense += amt;
      slot.expense += amt;
      cs.expense += amt;
      if (!catByBucket.has(bucket)) catByBucket.set(bucket, new Map());
      const bm = catByBucket.get(bucket)!;
      bm.set(cat, (bm.get(cat) || 0) + amt);
    }
  }
  const series = [...seriesMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([bucket, v]) => ({ bucket, expense: round2(v.expense), income: round2(v.income), balance: round2(v.income - v.expense) }));
  let ranks: any[] = [];
  if (metric !== 'balance') {
    const key = metric === 'income' ? 'income' : 'expense';
    ranks = [...catMap.entries()]
      .map(([name, v]) => ({ category_name: name, total: round2(v[key]), tx_count: v.count }))
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total || a.category_name.localeCompare(b.category_name));
  }
  const anomalyMonths = scope === 'year' ? computeAnomalies(series, catByBucket) : [];
  return c.json({
    summary: {
      transaction_count: rows.length,
      income_total: round2(income),
      expense_total: round2(expense),
      balance: round2(income - expense),
      distinct_days: days.size,
      first_tx_at: first,
      last_tx_at: last,
    },
    series,
    category_ranks: ranks,
    anomaly_months: anomalyMonths,
    range: {
      scope,
      metric,
      period: range.period,
      start_at: range.start,
      end_at: range.end ? new Date(Date.parse(range.end) - 1000).toISOString() : null,
    },
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function computeAnomalies(series: any[], catByBucket: Map<string, Map<string, number>>) {
  const nowMonth = monthKey(new Date().toISOString(), 0, 1);
  const past = series.filter((s) => s.bucket <= nowMonth);
  if (past.length < 3) return [];
  const baseline = median(past.map((s) => s.expense));
  const out: any[] = [];
  if (baseline <= 0) return out;
  for (const s of past) {
    if (!(s.expense > baseline * 1.2 && s.expense - baseline > 200)) continue;
    const cats = [...(catByBucket.get(s.bucket) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 2);
    out.push({
      bucket: s.bucket,
      expense: s.expense,
      baseline: round2(baseline),
      deviation_pct: round2((s.expense - baseline) / baseline),
      top_attributions: cats.map(([name, amount]) => ({ category_name: name, amount: round2(amount), median_others: 0, multiplier: null })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Net worth                                                           */
/* ------------------------------------------------------------------ */

readRoutes.get('/workspace/net-worth-history', async (c) => {
  const tz = toInt(c.req.query('tz_offset_minutes'), 0);
  const ledgers = await visibleLedgers(c, c.req.query('ledger_id') || null, c.req.query('user_id') || null);
  const accountRows = new Map<string, any>();
  for (const l of ledgers) {
    const rows = await all<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id=?`, l.user_id);
    for (const r of rows) accountRows.set(r.sync_id, r);
  }
  const ids = ledgers.map((l) => l.id);
  const ph = ids.map(() => '?').join(',');
  const txs = ids.length
    ? await all<any>(
        c.env.DB,
        `SELECT * FROM read_tx WHERE ledger_id IN (${ph}) ORDER BY happened_at ASC, tx_index ASC`,
        ...ids,
      )
    : [];
  const profile = await one<any>(c.env.DB, `SELECT primary_currency FROM user_profiles WHERE user_id=?`, c.get('auth').user.id);
  const currencies = new Set([...accountRows.values()].map((a) => (a.currency || 'CNY').toUpperCase()));
  const multi = currencies.size > 1;
  const base = (profile?.primary_currency || (multi ? '' : [...currencies][0] || '') || '').toUpperCase();
  const rates = await buildRates(c.env, base);
  const accounts = [...accountRows.values()];
  const init: Record<string, number> = {};
  const bal: Record<string, number> = {};
  for (const a of accounts) {
    init[a.sync_id] = Number(a.initial_balance || 0);
    bal[a.sync_id] = Number(a.initial_balance || 0);
  }
  const months = new Map<string, { assets: number; liabilities: number }>();
  const isLiab = (sid: string) => {
    const a = accountRows.get(sid);
    return a?.account_type === 'credit_card' || a?.account_type === 'loan';
  };
  const convert = (sid: string, amount: number) => {
    const a = accountRows.get(sid);
    const ccy = (a?.currency || base || 'CNY').toUpperCase();
    if (!base) return 0;
    if (ccy === base) return amount;
    return amount * (rates.get(`${ccy}:${base}`) || 0);
  };
  const snapshot = (bucket: string) => {
    let assets = 0;
    let liabilities = 0;
    for (const [sid, v] of Object.entries(bal)) {
      if (!accountRows.has(sid)) continue;
      const val = convert(sid, v);
      if (isLiab(sid)) liabilities += val;
      else assets += val;
    }
    months.set(bucket, { assets: round2(assets), liabilities: round2(liabilities) });
  };
  for (const tx of txs) {
    const amt = Number(tx.amount || 0);
    if (tx.tx_type === 'income' && tx.account_sync_id) bal[tx.account_sync_id] = (bal[tx.account_sync_id] || 0) + amt;
    else if (tx.tx_type === 'expense' && tx.account_sync_id) bal[tx.account_sync_id] = (bal[tx.account_sync_id] || 0) - amt;
    else if (tx.tx_type === 'transfer') {
      if (tx.from_account_sync_id) bal[tx.from_account_sync_id] = (bal[tx.from_account_sync_id] || 0) - amt;
      if (tx.to_account_sync_id) bal[tx.to_account_sync_id] = (bal[tx.to_account_sync_id] || 0) + amt;
    }
    snapshot(monthKey(tx.happened_at, tz, 1));
  }
  snapshot(monthKey(new Date().toISOString(), tz, 1));
  const series = [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([bucket, v]) => ({ bucket, assets: v.assets, liabilities: v.liabilities, net_worth: round2(v.assets - v.liabilities) }));
  return c.json({ series, multi_currency: multi });
});

async function buildRates(env: AppContext['Bindings'], base: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!base) return map;
  const rows = await all<any>(env.DB, `SELECT base_currency,quote_currency,rate FROM exchange_rate_overrides`);
  for (const r of rows) {
    map.set(`${r.base_currency}:${r.quote_currency}`, Number(r.rate));
    if (Number(r.rate) !== 0) map.set(`${r.quote_currency}:${r.base_currency}`, 1 / Number(r.rate));
  }
  // Static fallbacks so a fresh install still shows net worth.
  const usd: Record<string, number> = { USD: 1, CNY: 7.1, EUR: 0.92, JPY: 155, HKD: 7.8, GBP: 0.79, KRW: 1370, CAD: 1.37, AUD: 1.5, SGD: 1.34 };
  if (usd[base]) {
    for (const [ccy, rate] of Object.entries(usd)) map.set(`${ccy}:${base}`, rate / usd[base]);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Exchange rates                                                      */
/* ------------------------------------------------------------------ */

readRoutes.get('/exchange-rate-overrides', async (c) => {
  const rows = await all<any>(c.env.DB, `SELECT * FROM exchange_rate_overrides WHERE user_id=?`, c.get('auth').user.id);
  return c.json(
    rows.map((r) => ({
      base_currency: r.base_currency,
      quote_currency: r.quote_currency,
      rate: r.rate,
      updated_at: r.updated_at,
    })),
  );
});

readRoutes.get('/exchange-rates', async (c) => {
  const base = (c.req.query('base') || 'CNY').toUpperCase();
  const quotes = (c.req.query('quotes') || 'USD,EUR,JPY,HKD,GBP').toUpperCase().split(',').filter(Boolean);
  const rows = await all<any>(c.env.DB, `SELECT * FROM exchange_rate_overrides WHERE user_id=?`, c.get('auth').user.id);
  const overrides = new Map(rows.map((r) => [`${r.base_currency}:${r.quote_currency}`, r.rate]));
  const usd: Record<string, number> = { USD: 1, CNY: 7.1, EUR: 0.92, JPY: 155, HKD: 7.8, GBP: 0.79, KRW: 1370, CAD: 1.37, AUD: 1.5, SGD: 1.34 };
  const rates = quotes.map((q) => ({
    base_currency: base,
    quote_currency: q,
    rate: overrides.get(`${base}:${q}`) ?? (usd[base] && usd[q] ? usd[q] / usd[base] : null),
    source: overrides.has(`${base}:${q}`) ? 'manual' : 'static',
    fetched_at: new Date().toISOString(),
  }));
  return c.json({ base_currency: base, rates });
});

/* ------------------------------------------------------------------ */
/* Attachment gallery                                                  */
/* ------------------------------------------------------------------ */

readRoutes.get('/workspace/attachments', async (c) => {
  const ledgerId = c.req.query('ledger_id') || '';
  const l = await requireLedger(c.env, c.get('auth').user.id, ledgerId);
  const limit = Math.max(1, Math.min(200, toInt(c.req.query('limit'), 30)));
  const offset = Math.max(0, toInt(c.req.query('offset'), 0));
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const category = c.req.query('category_sync_id') || '';
  const from = c.req.query('date_from') || '';
  const to = c.req.query('date_to') || '';
  const rows = await all<any>(c.env.DB, `SELECT * FROM read_tx WHERE ledger_id=? AND attachments_json IS NOT NULL AND attachments_json != '[]'`, l.id);
  const files = await all<any>(c.env.DB, `SELECT * FROM attachments WHERE ledger_id=?`, l.id);
  const fileMap = new Map(files.map((f) => [f.sha256, f]));
  const groups = new Map<string, any>();
  for (const tx of rows) {
    if (category && tx.category_sync_id !== category) continue;
    if (from && tx.happened_at < from) continue;
    if (to && tx.happened_at >= to) continue;
    const atts = parseJson<any[]>(tx.attachments_json, []);
    for (const att of atts) {
      const key = att.cloudFileId || att.cloudSha256 || att.fileName;
      if (!key) continue;
      const f = att.cloudSha256 ? fileMap.get(att.cloudSha256) : null;
      const hay = `${att.originalName || att.fileName || ''} ${tx.note || ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          attachment: att,
          happened_at: tx.happened_at,
          mime_type: f?.mime_type ?? null,
          status: f ? 'ready' : 'missing',
          transactions: [],
        });
      }
      groups.get(key)!.transactions.push({
        id: tx.sync_id,
        ledger_id: l.external_id,
        note: tx.note,
        category_name: tx.category_name,
        category_id: tx.category_sync_id,
        amount: tx.amount,
        tx_type: tx.tx_type,
        currency_code: tx.currency_code,
        native_amount: tx.native_amount,
        happened_at: tx.happened_at,
      });
    }
  }
  const allItems = [...groups.values()].sort((a, b) => (a.happened_at < b.happened_at ? 1 : -1));
  return c.json({
    items: allItems.slice(offset, offset + limit),
    total: allItems.length,
    transaction_total: rows.length,
    limit,
    offset,
  });
});

function budgetPeriod(now: Date, monthStartDay: number, tzRaw?: string) {
  const tz = toInt(tzRaw, 0);
  const local = new Date(now.getTime() + tz * 60000);
  let y = local.getUTCFullYear();
  let m = local.getUTCMonth();
  if (local.getUTCDate() < monthStartDay) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  const start = new Date(Date.UTC(y, m, monthStartDay) - tz * 60000).toISOString();
  const end = new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, monthStartDay) - tz * 60000).toISOString();
  return { start, end };
}
