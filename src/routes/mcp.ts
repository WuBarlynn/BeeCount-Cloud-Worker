/**
 * MCP server over Streamable HTTP (stateless).
 *
 * Endpoint: POST /api/v1/mcp with `Authorization: Bearer bcmcp_…`.
 * Only personal access tokens are accepted, matching the upstream security
 * model: a PAT can never call the normal REST API, and a session token can
 * never call MCP.
 *
 * The transport is intentionally stateless: no session id, no SSE stream, no
 * persistent process. `initialize` answers immediately, notifications return
 * 202, and every `tools/call` is a self-contained request.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import type { AuthInfo } from '../env';
import { authMiddleware } from '../lib/auth';
import { all, one } from '../lib/db';
import { HttpError, nowIso, toFloat, toInt } from '../lib/util';
import { listAccessibleLedgers, requireLedger, type LedgerRow } from '../lib/ledger';
import { mapAccount, mapBudget, mapCategory, mapLedger, mapTag, mapTx } from '../lib/mappers';
import {
  applyTxPatch,
  budgetPayload,
  categoryPayload,
  emitLedger,
  emitUser,
  newSyncId,
  nextTxIndex,
  txPayloadFromRow,
} from './write';

export const mcpRoutes = new Hono<AppContext>();

mcpRoutes.use('*', authMiddleware());
mcpRoutes.use('*', async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.via !== 'pat') {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'A BeeCount personal access token (bcmcp_…) is required.' } }, 401);
  }
  const scopes = auth.scopes;
  if (!scopes.includes('mcp:read') && !scopes.includes('mcp:write')) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: 'This token has no MCP scope.' } }, 403);
  }
  await next();
});

type ToolScope = 'read' | 'write';

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  scope: ToolScope;
  run: (env: AppContext['Bindings'], auth: AuthInfo, args: Record<string, any>) => Promise<any>;
};

class ToolError extends Error {}

const obj = (properties: Record<string, any>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const s = (description: string) => ({ type: 'string', description });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });

function strArg(args: Record<string, any>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${key} is required`);
  return value.trim();
}

function optStr(args: Record<string, any>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim();
}

function isoDayEnd(value: string): string {
  return value.length <= 10 ? `${value}T23:59:59.999Z` : value;
}

async function resolveLedger(
  env: AppContext['Bindings'],
  userId: string,
  externalId: string | null,
  roles: string[] = ['owner', 'editor', 'viewer'],
): Promise<LedgerRow> {
  const ledgers = await listAccessibleLedgers(env, userId);
  if (!ledgers.length) throw new ToolError('No ledger is available for this account.');
  if (!externalId) return ledgers[0];
  const found = ledgers.find((l) => l.external_id === externalId);
  if (!found) throw new ToolError(`Ledger "${externalId}" was not found.`);
  if (!roles.includes(found.role || 'viewer')) throw new ToolError('You do not have write access to this ledger.');
  return found;
}

async function ledgerTotals(env: AppContext['Bindings'], ledgerIds: string[]) {
  if (!ledgerIds.length) return new Map<string, { tx: number; income: number; expense: number; balance: number }>();
  const ph = ledgerIds.map(() => '?').join(',');
  const rows = await all<any>(
    env.DB,
    `SELECT ledger_id,
       COUNT(*) AS tx,
       COALESCE(SUM(CASE WHEN tx_type='income' AND exclude_from_stats=0 THEN COALESCE(native_amount,amount) ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN tx_type='expense' AND exclude_from_stats=0 THEN COALESCE(native_amount,amount) ELSE 0 END),0) AS expense,
       COALESCE(SUM(CASE WHEN tx_type='income' THEN COALESCE(native_amount,amount) WHEN tx_type='expense' THEN -COALESCE(native_amount,amount) ELSE 0 END),0) AS balance
     FROM read_tx WHERE ledger_id IN (${ph}) GROUP BY ledger_id`,
    ...ledgerIds,
  );
  return new Map(
    rows.map((r) => [
      String(r.ledger_id),
      { tx: Number(r.tx || 0), income: Number(r.income || 0), expense: Number(r.expense || 0), balance: Number(r.balance || 0) },
    ]),
  );
}

async function findOwnedTx(
  env: AppContext['Bindings'],
  userId: string,
  syncId: string,
  ledgerExternalId?: string | null,
): Promise<{ row: any; ledger: LedgerRow }> {
  const ledgers = await listAccessibleLedgers(env, userId);
  if (!ledgers.length) throw new ToolError('No ledger is available for this account.');
  const ids = ledgers.map((l) => l.id);
  const ph = ids.map(() => '?').join(',');
  const row = await one<any>(env.DB, `SELECT * FROM read_tx WHERE sync_id = ? AND ledger_id IN (${ph})`, syncId, ...ids);
  if (!row) throw new ToolError(`Transaction "${syncId}" was not found.`);
  const ledger = ledgers.find((l) => l.id === row.ledger_id);
  if (!ledger) throw new ToolError('Transaction not found.');
  if (ledgerExternalId && ledger.external_id !== ledgerExternalId) throw new ToolError('Transaction does not belong to that ledger.');
  if (ledger.role !== 'owner' && ledger.role !== 'editor') throw new ToolError('You do not have write access to this ledger.');
  return { row, ledger };
}

function txForTool(row: any, ledger: LedgerRow) {
  return { ...mapTx(row), ledger_id: ledger.external_id, ledger_name: ledger.name };
}

/* --------------------------------- read tools -------------------------------- */

const readTools: Tool[] = [
  {
    name: 'list_ledgers',
    description: 'List every ledger this account can access, with transaction totals and the role of the current user.',
    inputSchema: obj({}),
    scope: 'read',
    async run(env, auth) {
      const ledgers = await listAccessibleLedgers(env, auth.user.id);
      const totals = await ledgerTotals(env, ledgers.map((l) => l.id));
      return ledgers.map((l) => mapLedger(l, totals.get(l.id) || { tx: 0, income: 0, expense: 0, balance: 0 }, { role: l.role || 'owner' }));
    },
  },
  {
    name: 'get_active_ledger',
    description: 'Return the default ledger for this account (the most recently created one).',
    inputSchema: obj({}),
    scope: 'read',
    async run(env, auth) {
      const ledgers = await listAccessibleLedgers(env, auth.user.id);
      if (!ledgers.length) throw new ToolError('No ledger is available for this account.');
      const totals = await ledgerTotals(env, ledgers.map((l) => l.id));
      return mapLedger(ledgers[0], totals.get(ledgers[0].id) || { tx: 0, income: 0, expense: 0, balance: 0 }, { role: ledgers[0].role || 'owner' });
    },
  },
  {
    name: 'list_transactions',
    description: 'List transactions in one ledger, newest first. Supports date range, type, category, account and free-text filters.',
    inputSchema: obj({
      ledger_id: s('Ledger id from list_ledgers. Defaults to the active ledger.'),
      date_from: s('Inclusive start date, YYYY-MM-DD or ISO 8601.'),
      date_to: s('Inclusive end date, YYYY-MM-DD or ISO 8601.'),
      tx_type: s('expense, income or transfer.'),
      category: s('Category name (partial match).'),
      account: s('Account name (partial match).'),
      q: s('Free text across note, category, account, tags and amount.'),
      limit: n('Maximum rows, 1-500. Default 100.'),
      offset: n('Rows to skip. Default 0.'),
    }),
    scope: 'read',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'));
      const where = ['ledger_id = ?'];
      const binds: unknown[] = [ledger.id];
      if (args.date_from) {
        where.push('happened_at >= ?');
        binds.push(String(args.date_from));
      }
      if (args.date_to) {
        where.push('happened_at <= ?');
        binds.push(isoDayEnd(String(args.date_to)));
      }
      if (args.tx_type) {
        where.push('tx_type = ?');
        binds.push(String(args.tx_type));
      }
      if (args.category) {
        where.push('category_name LIKE ?');
        binds.push(`%${args.category}%`);
      }
      if (args.account) {
        where.push('(account_name LIKE ? OR from_account_name LIKE ? OR to_account_name LIKE ?)');
        binds.push(`%${args.account}%`, `%${args.account}%`, `%${args.account}%`);
      }
      if (args.q) {
        where.push('(note LIKE ? OR category_name LIKE ? OR account_name LIKE ? OR tags_csv LIKE ? OR CAST(amount AS TEXT) LIKE ?)');
        const like = `%${args.q}%`;
        binds.push(like, like, like, like, like);
      }
      const limit = Math.max(1, Math.min(500, toInt(args.limit, 100)));
      const offset = Math.max(0, toInt(args.offset, 0));
      const rows = await all<any>(
        env.DB,
        `SELECT * FROM read_tx WHERE ${where.join(' AND ')} ORDER BY happened_at DESC, tx_index DESC LIMIT ? OFFSET ?`,
        ...binds,
        limit,
        offset,
      );
      return { ledger_id: ledger.external_id, count: rows.length, transactions: rows.map((r) => mapTx(r, { ledger_id: ledger.external_id })) };
    },
  },
  {
    name: 'get_transaction',
    description: 'Fetch one transaction by its sync id.',
    inputSchema: obj({ sync_id: s('Transaction id, e.g. tx_…'), ledger_id: s('Optional ledger id to disambiguate.') }, ['sync_id']),
    scope: 'read',
    async run(env, auth, args) {
      const syncId = strArg(args, 'sync_id');
      const { row, ledger } = await findOwnedTx(env, auth.user.id, syncId, optStr(args, 'ledger_id'));
      return txForTool(row, ledger);
    },
  },
  {
    name: 'list_categories',
    description: 'List expense/income/transfer categories, including parents and children.',
    inputSchema: obj({ ledger_id: s('Optional ledger id; categories belong to the ledger owner.') }),
    scope: 'read',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'));
      const rows = await all<any>(env.DB, `SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC`, ledger.user_id);
      return rows.map((r) => mapCategory(r, { ledger_id: ledger.external_id }));
    },
  },
  {
    name: 'list_accounts',
    description: 'List payment accounts, wallets, cards and their balances metadata.',
    inputSchema: obj({ ledger_id: s('Optional ledger id; accounts belong to the ledger owner.') }),
    scope: 'read',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'));
      const rows = await all<any>(env.DB, `SELECT * FROM user_accounts WHERE user_id = ? ORDER BY name`, ledger.user_id);
      return rows.map((r) => mapAccount(r, { ledger_id: ledger.external_id }));
    },
  },
  {
    name: 'list_tags',
    description: 'List tags available to this account.',
    inputSchema: obj({ ledger_id: s('Optional ledger id.') }),
    scope: 'read',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'));
      const rows = await all<any>(env.DB, `SELECT * FROM user_tags WHERE user_id = ? ORDER BY name`, ledger.user_id);
      return rows.map((r) => mapTag(r));
    },
  },
  {
    name: 'list_budgets',
    description: 'List budgets for a ledger with the amount spent in the current calendar month.',
    inputSchema: obj({ ledger_id: s('Ledger id. Defaults to the active ledger.') }),
    scope: 'read',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'));
      const rows = await all<any>(env.DB, `SELECT * FROM read_budgets WHERE ledger_id = ?`, ledger.id);
      const cats = await all<any>(env.DB, `SELECT sync_id, name, parent_sync_id FROM user_categories WHERE user_id = ?`, ledger.user_id);
      const names = new Map(cats.map((c) => [c.sync_id, c.name]));
      const children = new Map<string, string[]>();
      for (const c of cats) {
        if (!c.parent_sync_id) continue;
        if (!children.has(c.parent_sync_id)) children.set(c.parent_sync_id, []);
        children.get(c.parent_sync_id)!.push(c.sync_id);
      }
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const txs = await all<any>(
        env.DB,
        `SELECT category_sync_id, COALESCE(native_amount,amount) AS amount FROM read_tx
         WHERE ledger_id = ? AND tx_type = 'expense' AND exclude_from_budget = 0 AND happened_at >= ?`,
        ledger.id,
        start.toISOString(),
      );
      const dedup = new Map<string, any>();
      for (const r of rows) {
        const key = `${r.budget_type || 'total'}|${r.category_sync_id || ''}`;
        const cur = dedup.get(key);
        if (!cur || String(cur.sync_id) < String(r.sync_id)) dedup.set(key, r);
      }
      return [...dedup.values()].map((r) => {
        const type = r.budget_type || 'total';
        let used = 0;
        if (type === 'total') used = txs.reduce((sum, t) => sum + Number(t.amount || 0), 0);
        else if (r.category_sync_id) {
          const ids = new Set([r.category_sync_id, ...(children.get(r.category_sync_id) || [])]);
          used = txs.filter((t) => ids.has(t.category_sync_id)).reduce((sum, t) => sum + Number(t.amount || 0), 0);
        }
        return { ...mapBudget(r, r.category_sync_id ? names.get(r.category_sync_id) ?? null : null), ledger_id: ledger.external_id, spent_this_month: Math.round(used * 100) / 100 };
      });
    },
  },
  {
    name: 'get_ledger_stats',
    description: 'Counts of transactions, attachments, budgets, accounts, categories and tags for a ledger.',
    inputSchema: obj({ ledger_id: s('Ledger id. Defaults to the active ledger.') }),
    scope: 'read',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'));
      const totals = await ledgerTotals(env, [ledger.id]);
      const t = totals.get(ledger.id) ?? { tx: 0, income: 0, expense: 0, balance: 0 };
      const counts = await all<any>(
        env.DB,
        `SELECT
          (SELECT COUNT(*) FROM attachments WHERE ledger_id = ? AND kind='transaction') AS attachment_count,
          (SELECT COUNT(*) FROM read_budgets WHERE ledger_id = ?) AS budget_count,
          (SELECT COUNT(*) FROM user_accounts WHERE user_id = ?) AS account_count,
          (SELECT COUNT(*) FROM user_categories WHERE user_id = ?) AS category_count,
          (SELECT COUNT(*) FROM user_tags WHERE user_id = ?) AS tag_count`,
        ledger.id,
        ledger.id,
        ledger.user_id,
        ledger.user_id,
        ledger.user_id,
      );
      return { ledger_id: ledger.external_id, transaction_count: t.tx, income_total: t.income, expense_total: t.expense, balance: t.balance, ...counts[0] };
    },
  },
  {
    name: 'get_analytics_summary',
    description: 'Income, expense, balance and the top expense categories for a month, a year or all time.',
    inputSchema: obj({
      ledger_id: s('Optional ledger id. Omit to aggregate every accessible ledger.'),
      scope: { type: 'string', enum: ['month', 'year', 'all'], description: 'Period granularity. Default month.' },
      period: s('YYYY-MM for month scope or YYYY for year scope. Defaults to now.'),
      limit: n('Number of top categories, 1-20. Default 5.'),
    }),
    scope: 'read',
    async run(env, auth, args) {
      const ledgers = optStr(args, 'ledger_id')
        ? [await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'))]
        : await listAccessibleLedgers(env, auth.user.id);
      if (!ledgers.length) return { summary: { income: 0, expense: 0, balance: 0, transaction_count: 0 }, categories: [], period: null };
      const scope = ['month', 'year', 'all'].includes(String(args.scope)) ? String(args.scope) : 'month';
      let start: string | null = null;
      let end: string | null = null;
      const now = new Date();
      if (scope === 'month') {
        const period = /^\d{4}-\d{2}$/.test(String(args.period || '')) ? String(args.period) : now.toISOString().slice(0, 7);
        const [year, month] = period.split('-').map(Number);
        start = new Date(Date.UTC(year, month - 1, 1)).toISOString();
        end = new Date(Date.UTC(year, month, 1)).toISOString();
      } else if (scope === 'year') {
        const year = /^\d{4}$/.test(String(args.period || '')) ? Number(args.period) : now.getUTCFullYear();
        start = new Date(Date.UTC(year, 0, 1)).toISOString();
        end = new Date(Date.UTC(year + 1, 0, 1)).toISOString();
      }
      const ids = ledgers.map((l) => l.id);
      const ph = ids.map(() => '?').join(',');
      const where = [`ledger_id IN (${ph})`, 'exclude_from_stats = 0'];
      const binds: unknown[] = [...ids];
      if (start) {
        where.push('happened_at >= ?');
        binds.push(start);
      }
      if (end) {
        where.push('happened_at < ?');
        binds.push(end);
      }
      const rows = await all<any>(
        env.DB,
        `SELECT tx_type, COALESCE(native_amount,amount) AS amount, category_name FROM read_tx WHERE ${where.join(' AND ')} LIMIT 50000`,
        ...binds,
      );
      let income = 0;
      let expense = 0;
      const cats = new Map<string, number>();
      for (const r of rows) {
        const amount = Number(r.amount || 0);
        if (r.tx_type === 'income') income += amount;
        else if (r.tx_type === 'expense') {
          expense += amount;
          const name = String(r.category_name || '').trim() || 'Uncategorized';
          cats.set(name, (cats.get(name) || 0) + amount);
        }
      }
      const limit = Math.max(1, Math.min(20, toInt(args.limit, 5)));
      const categories = [...cats.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, amount]) => ({ name, amount: Math.round(amount * 100) / 100 }));
      return {
        scope,
        period: start ? { start, end } : null,
        ledger_ids: ledgers.map((l) => l.external_id),
        summary: {
          income: Math.round(income * 100) / 100,
          expense: Math.round(expense * 100) / 100,
          balance: Math.round((income - expense) * 100) / 100,
          transaction_count: rows.length,
        },
        categories,
      };
    },
  },
  {
    name: 'search',
    description: 'Free-text search across transactions in every accessible ledger.',
    inputSchema: obj({ q: s('Search text.'), limit: n('Maximum rows, 1-200. Default 50.') }, ['q']),
    scope: 'read',
    async run(env, auth, args) {
      const q = strArg(args, 'q');
      const limit = Math.max(1, Math.min(200, toInt(args.limit, 50)));
      const ledgers = await listAccessibleLedgers(env, auth.user.id);
      if (!ledgers.length) return [];
      const ids = ledgers.map((l) => l.id);
      const ph = ids.map(() => '?').join(',');
      const like = `%${q}%`;
      const rows = await all<any>(
        env.DB,
        `SELECT * FROM read_tx WHERE ledger_id IN (${ph})
          AND (note LIKE ? OR category_name LIKE ? OR account_name LIKE ? OR tags_csv LIKE ? OR CAST(amount AS TEXT) LIKE ?)
         ORDER BY happened_at DESC LIMIT ?`,
        ...ids,
        like,
        like,
        like,
        like,
        like,
        limit,
      );
      const external = new Map(ledgers.map((l) => [l.id, l.external_id]));
      return rows.map((r) => mapTx(r, { ledger_id: external.get(r.ledger_id) || null }));
    },
  },
];

/* -------------------------------- write tools -------------------------------- */

async function createTx(
  env: AppContext['Bindings'],
  userId: string,
  ledger: LedgerRow,
  args: Record<string, any>,
): Promise<{ transaction_id: string; change_id: number }> {
  const amount = toFloat(args.amount, 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new ToolError('amount must be a positive number');
  const type = String(args.tx_type || 'expense');
  if (!['expense', 'income', 'transfer'].includes(type)) throw new ToolError('tx_type must be expense, income or transfer');
  const txId = newSyncId('tx');
  const payload = applyTxPatch({ syncId: txId }, args);
  payload.amount = amount;
  payload.type = type;
  payload.happenedAt = args.happened_at ? String(args.happened_at) : nowIso();
  payload.createdByUserId = userId;
  payload.updatedByUserId = userId;
  payload.txIndex = await nextTxIndex(env, ledger.id);
  if (args.exclude_from_stats === undefined) payload.excludeFromStats = false;
  if (args.exclude_from_budget === undefined) payload.excludeFromBudget = false;
  const changeId = await emitLedger(env, ledger, userId, 'transaction', txId, 'upsert', payload, 'mcp');
  return { transaction_id: txId, change_id: changeId };
}

const writeTools: Tool[] = [
  {
    name: 'create_transaction',
    description: 'Create one transaction. A category or account that does not exist is still recorded by name (the app shows it as an unmatched name).',
    inputSchema: obj(
      {
        ledger_id: s('Ledger id. Defaults to the active ledger.'),
        tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'], description: 'Transaction type.' },
        amount: n('Positive amount in the ledger currency.'),
        happened_at: s('ISO 8601 time. Defaults to now.'),
        note: s('Note or merchant.'),
        category_name: s('Category name.'),
        category_kind: s('expense or income. Defaults to the transaction type.'),
        account_name: s('Account name for expense/income.'),
        from_account_name: s('Source account for transfers.'),
        to_account_name: s('Destination account for transfers.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names.' },
        currency_code: s('ISO currency code when it differs from the ledger currency.'),
        native_amount: n('Amount in the original currency.'),
        exclude_from_stats: b('Exclude from analytics.'),
        exclude_from_budget: b('Exclude from budget usage.'),
      },
      ['amount'],
    ),
    scope: 'write',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'), ['owner', 'editor']);
      const created = await createTx(env, auth.user.id, ledger, args);
      return { ...created, ledger_id: ledger.external_id, status: 'created' };
    },
  },
  {
    name: 'create_transactions',
    description: 'Create up to 5 transactions in one call. Each item accepts the same fields as create_transaction.',
    inputSchema: obj(
      {
        ledger_id: s('Ledger id. Defaults to the active ledger.'),
        transactions: { type: 'array', items: { type: 'object' }, description: 'Transaction objects.' },
      },
      ['transactions'],
    ),
    scope: 'write',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'), ['owner', 'editor']);
      const items = Array.isArray(args.transactions) ? args.transactions : [];
      if (!items.length) throw new ToolError('transactions must contain at least one item');
      if (items.length > 5) throw new ToolError('At most 5 transactions per call on the free plan; split the batch.');
      const created: any[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') throw new ToolError('each transaction must be an object');
        const result = await createTx(env, auth.user.id, ledger, item);
        created.push(result.transaction_id);
      }
      return { ledger_id: ledger.external_id, created, count: created.length };
    },
  },
  {
    name: 'update_transaction',
    description: 'Update fields of an existing transaction. Only the fields you pass are changed.',
    inputSchema: obj(
      {
        sync_id: s('Transaction id, e.g. tx_…'),
        ledger_id: s('Optional ledger id.'),
        tx_type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
        amount: n('New positive amount.'),
        happened_at: s('New ISO 8601 time.'),
        note: s('New note.'),
        category_name: s('New category name.'),
        category_kind: s('expense or income.'),
        account_name: s('New account name.'),
        tags: { type: 'array', items: { type: 'string' } },
        exclude_from_stats: b('Exclude from analytics.'),
        exclude_from_budget: b('Exclude from budget usage.'),
      },
      ['sync_id'],
    ),
    scope: 'write',
    async run(env, auth, args) {
      const syncId = strArg(args, 'sync_id');
      const { row, ledger } = await findOwnedTx(env, auth.user.id, syncId, optStr(args, 'ledger_id'));
      if (args.amount !== undefined && toFloat(args.amount, 0) <= 0) throw new ToolError('amount must be a positive number');
      const payload = applyTxPatch(await txPayloadFromRow(env, row, ledger), args);
      payload.updatedByUserId = auth.user.id;
      if (!payload.createdByUserId) payload.createdByUserId = row.created_by_user_id || auth.user.id;
      const changeId = await emitLedger(env, ledger, auth.user.id, 'transaction', syncId, 'upsert', payload, 'mcp');
      return { transaction_id: syncId, change_id: changeId, ledger_id: ledger.external_id, status: 'updated' };
    },
  },
  {
    name: 'delete_transaction',
    description: 'Delete a transaction. Requires confirm=true after the user explicitly agrees.',
    inputSchema: obj({ sync_id: s('Transaction id, e.g. tx_…'), ledger_id: s('Optional ledger id.'), confirm: b('Must be true to actually delete.') }, [
      'sync_id',
    ]),
    scope: 'write',
    async run(env, auth, args) {
      const syncId = strArg(args, 'sync_id');
      if (args.confirm !== true) {
        return {
          status: 'confirmation_required',
          transaction_id: syncId,
          message: 'Show this transaction to the user and ask them to confirm. Call again with confirm=true only after they agree.',
        };
      }
      const { ledger } = await findOwnedTx(env, auth.user.id, syncId, optStr(args, 'ledger_id'));
      const changeId = await emitLedger(env, ledger, auth.user.id, 'transaction', syncId, 'delete', {}, 'mcp');
      return { transaction_id: syncId, change_id: changeId, ledger_id: ledger.external_id, status: 'deleted' };
    },
  },
  {
    name: 'create_category',
    description: 'Create a category (optionally a child of an existing one).',
    inputSchema: obj(
      {
        ledger_id: s('Optional ledger id, used to check write access.'),
        name: s('Category name.'),
        kind: { type: 'string', enum: ['expense', 'income', 'transfer'], description: 'Defaults to expense.' },
        parent_name: s('Parent category name for a second-level category.'),
      },
      ['name'],
    ),
    scope: 'write',
    async run(env, auth, args) {
      const ledger = await resolveLedger(env, auth.user.id, optStr(args, 'ledger_id'), ['owner', 'editor']);
      const name = strArg(args, 'name');
      const kind = ['expense', 'income', 'transfer'].includes(String(args.kind)) ? String(args.kind) : 'expense';
      const dup = await all<any>(env.DB, `SELECT name, kind, level FROM user_categories WHERE user_id = ?`, auth.user.id);
      if (dup.some((r) => String(r.name).toLowerCase() === name.toLowerCase() && r.kind === kind && (r.level ?? 1) === 1 && !args.parent_name)) {
        throw new ToolError('A category with that name already exists.');
      }
      const sid = newSyncId('cat');
      const payload = await categoryPayload(env, auth.user.id, sid, { ...args, name, kind });
      payload.createdByUserId = auth.user.id;
      payload.updatedByUserId = auth.user.id;
      const changeId = await emitUser(env, auth.user.id, 'category', sid, 'upsert', payload, 'mcp');
      return { category_id: sid, change_id: changeId, name, kind, status: 'created' };
    },
  },
  {
    name: 'update_budget',
    description: 'Change the amount (or period/enabled state) of an existing budget.',
    inputSchema: obj(
      {
        budget_id: s('Budget id from list_budgets.'),
        amount: n('New positive budget amount.'),
        period: { type: 'string', enum: ['monthly', 'weekly', 'yearly'] },
        start_day: n('Budget start day, 1-28.'),
        enabled: b('Turn the budget on or off.'),
      },
      ['budget_id'],
    ),
    scope: 'write',
    async run(env, auth, args) {
      const budgetId = strArg(args, 'budget_id');
      if (args.amount !== undefined && toFloat(args.amount, 0) <= 0) throw new ToolError('amount must be a positive number');
      const ledgers = await listAccessibleLedgers(env, auth.user.id);
      const ids = ledgers.map((l) => l.id);
      if (!ids.length) throw new ToolError('No ledger is available for this account.');
      const ph = ids.map(() => '?').join(',');
      const row = await one<any>(env.DB, `SELECT * FROM read_budgets WHERE sync_id = ? AND ledger_id IN (${ph})`, budgetId, ...ids);
      if (!row) throw new ToolError(`Budget "${budgetId}" was not found.`);
      const candidate = ledgers.find((l) => l.id === row.ledger_id);
      if (!candidate) throw new ToolError('Budget not found.');
      const ledger = await resolveLedger(env, auth.user.id, candidate.external_id, ['owner', 'editor']);
      const payload = await budgetPayload(env, ledger, budgetId, args);
      const changeId = await emitLedger(env, ledger, auth.user.id, 'budget', budgetId, 'upsert', payload, 'mcp');
      return { budget_id: budgetId, change_id: changeId, ledger_id: ledger.external_id, status: 'updated' };
    },
  },
];

const tools: Tool[] = [...readTools, ...writeTools];

function canCall(auth: AuthInfo, tool: Tool): boolean {
  if (tool.scope === 'write') return auth.scopes.includes('mcp:write');
  return auth.scopes.includes('mcp:read') || auth.scopes.includes('mcp:write');
}

function toolDescriptor(tool: Tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

const PROTOCOL_VERSION = '2025-03-26';

function rpcResult(id: any, result: any) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

mcpRoutes.post('/', async (c) => {
  const auth = c.get('auth');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400);
  }
  const requests = Array.isArray(body) ? body : [body];
  if (!requests.length) return c.json(rpcError(null, -32600, 'Invalid Request'), 400);

  const responses: any[] = [];
  for (const request of requests) {
    if (!request || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      responses.push(rpcError(request?.id ?? null, -32600, 'Invalid Request'));
      continue;
    }
    const id = request.id;
    const isNotification = id === undefined || id === null;

    if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') {
      continue;
    }
    if (request.method === 'initialize') {
      const requested = request.params?.protocolVersion;
      responses.push(
        rpcResult(id, {
          protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: c.env.APP_NAME || 'BeeCount Cloud', version: c.env.APP_VERSION || '1.9.0-worker.1' },
          instructions:
            'BeeCount bookkeeping. Read tools list ledgers and transactions; write tools require the mcp:write scope. Ask the user before deleting anything.',
        }),
      );
      continue;
    }
    if (request.method === 'ping') {
      responses.push(rpcResult(id, {}));
      continue;
    }
    if (request.method === 'tools/list') {
      responses.push(rpcResult(id, { tools: tools.filter((tool) => canCall(auth, tool)).map(toolDescriptor) }));
      continue;
    }
    if (request.method === 'tools/call') {
      const name = request.params?.name;
      const tool = tools.find((x) => x.name === name);
      if (!tool) {
        responses.push(rpcError(id, -32602, `Unknown tool: ${name}`));
        continue;
      }
      if (!canCall(auth, tool)) {
        responses.push(rpcError(id, -32003, `This token is missing the required scope: ${tool.scope === 'write' ? 'mcp:write' : 'mcp:read'}`));
        continue;
      }
      try {
        const args = request.params?.arguments && typeof request.params.arguments === 'object' ? request.params.arguments : {};
        const result = await tool.run(c.env, auth, args);
        responses.push(
          rpcResult(id, {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
            isError: false,
          }),
        );
      } catch (e) {
        const message = e instanceof HttpError ? (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)) : (e as Error)?.message || String(e);
        responses.push(
          rpcResult(id, {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          }),
        );
      }
      continue;
    }
    if (isNotification) continue;
    responses.push(rpcError(id, -32601, `Method not found: ${request.method}`));
  }

  if (!responses.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? responses : responses[0]);
});

mcpRoutes.get('/', (c) => c.text('POST JSON-RPC requests to this endpoint. This server is stateless and does not expose an SSE stream.', 405, { allow: 'POST' }));
mcpRoutes.delete('/', (c) => c.text('Method Not Allowed', 405, { allow: 'POST' }));
