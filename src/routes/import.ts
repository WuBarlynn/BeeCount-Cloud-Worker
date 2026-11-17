import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one, run } from '../lib/db';
import { appendChange, broadcastToLedger } from '../lib/changes';
import { HttpError, json, nowIso, parseJson, toFloat, toInt, uuid } from '../lib/util';
import { requireLedger } from '../lib/ledger';
import { parseCsv } from '../lib/csv';
import { applyLedgerChange, applyUserChange, type ChangeInput } from '../lib/projection';

export const importRoutes = new Hono<AppContext>();

importRoutes.use('*', authMiddleware());
importRoutes.use('*', requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE));

const MAX_ROWS = 50_000;
const MAX_EXECUTE_TX = 2000;

const HEADER_HINTS: Record<string, string[]> = {
  tx_type: ['type', 'tx_type', '交易类型', '收/支', '收支', '类型', '方向'],
  amount: ['amount', '金额', '交易金额', 'money'],
  happened_at: ['date', 'time', 'happened_at', '交易时间', '时间', '日期', '记账时间'],
  category_name: ['category', 'category_name', '分类', '交易分类'],
  subcategory_name: ['subcategory', 'subcategory_name', '二级分类', '子分类'],
  account_name: ['account', 'account_name', '账户', '支付账户', '付款方式'],
  from_account_name: ['from_account', 'from_account_name', '转出账户', '转出'],
  to_account_name: ['to_account', 'to_account_name', '转入账户', '转入'],
  note: ['note', '备注', '说明', '商品说明', 'description', 'memo'],
  currency: ['currency', 'currency_code', '币种'],
  tags: ['tags', '标签'],
};

const MAPPING_KEYS = Object.keys(HEADER_HINTS) as (keyof typeof HEADER_HINTS)[];

function suggestMapping(headers: string[]) {
  const mapping: Record<string, any> = {
    tx_type: null,
    amount: null,
    happened_at: null,
    category_name: null,
    subcategory_name: null,
    account_name: null,
    from_account_name: null,
    to_account_name: null,
    note: null,
    currency: null,
    tags: [],
    datetime_format: null,
    strip_currency_symbols: true,
    expense_is_negative: false,
    tz_offset_minutes: 0,
  };
  for (const key of MAPPING_KEYS) {
    if (key === 'tags') continue;
    const hints = HEADER_HINTS[key];
    const hit = headers.find((h) => hints.some((x) => h.toLowerCase() === x.toLowerCase() || h.includes(x)));
    mapping[key] = hit ?? null;
  }
  const tagHeader = headers.find((h) => HEADER_HINTS.tags.some((x) => h.toLowerCase().includes(x)));
  if (tagHeader) mapping.tags = [tagHeader];
  return mapping;
}

function normalizeType(raw: string, expenseIsNegative: boolean, amount: number): 'expense' | 'income' | 'transfer' | null {
  const v = (raw || '').trim().toLowerCase();
  if (['expense', '支出', '消费', '支', '-'].includes(v)) return 'expense';
  if (['income', '收入', '收', '+', '入'].includes(v)) return 'income';
  if (['transfer', '转账', '转'].includes(v)) return 'transfer';
  if (!v) {
    if (expenseIsNegative && Number.isFinite(amount)) return amount < 0 ? 'expense' : 'income';
    return null;
  }
  if (v.includes('支出') || v.includes('expense') || v.includes('消费')) return 'expense';
  if (v.includes('收入') || v.includes('income')) return 'income';
  if (v.includes('转账') || v.includes('transfer')) return 'transfer';
  return null;
}

function parseAmount(raw: string, stripSymbols: boolean): number {
  let s = String(raw || '').replace(/,/g, '').trim();
  if (!s) return NaN;
  if (stripSymbols) s = s.replace(/[^\d.\-+]/g, '');
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseDate(raw: string, tzOffsetMinutes: number): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const v = s.replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
  const m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, ys, mos, ds, hs, mins, ss] = m;
  const ms = Date.UTC(Number(ys), Number(mos) - 1, Number(ds), Number(hs || 0), Number(mins || 0), Number(ss || 0)) - tzOffsetMinutes * 60_000;
  return new Date(ms).toISOString();
}

type MappedTx = {
  tx_type: 'expense' | 'income' | 'transfer';
  amount: number;
  happened_at: string;
  note: string | null;
  category_name: string | null;
  category_kind: string | null;
  account_name: string | null;
  from_account_name: string | null;
  to_account_name: string | null;
  tags: string[];
  currency_code: string | null;
  row_number: number;
};

function mapRows(rows: Record<string, string>[], mapping: Record<string, any>) {
  const txs: MappedTx[] = [];
  const errors: any[] = [];
  const required = ['tx_type', 'amount', 'happened_at', 'category_name'];
  const missing = required.filter((k) => !mapping[k]);
  if (missing.length) {
    errors.push({ code: 'PARSE_MAPPING_INCOMPLETE', row_number: 0, message: `required mapping fields missing: ${missing.join(', ')}`, field_name: null });
    return { txs, errors };
  }
  const tz = toInt(mapping.tz_offset_minutes, 0);
  rows.forEach((row, idx) => {
    const rowNumber = idx + 2;
    let type = normalizeType(row[mapping.tx_type] || '', !!mapping.expense_is_negative, parseAmount(row[mapping.amount] || '', true));
    if (!type) {
      errors.push({ code: 'PARSE_INVALID_FIELD', row_number: rowNumber, message: `unrecognized tx_type ${JSON.stringify(row[mapping.tx_type] || '')}`, field_name: 'tx_type' });
      return;
    }
    let amount = parseAmount(row[mapping.amount] || '', mapping.strip_currency_symbols !== false);
    if (!Number.isFinite(amount)) {
      errors.push({ code: 'PARSE_INVALID_FIELD', row_number: rowNumber, message: 'amount is not a number', field_name: 'amount' });
      return;
    }
    if (amount < 0 && !mapping.expense_is_negative) {
      amount = -amount;
      if (type !== 'transfer') type = 'expense';
    }
    const happenedAt = parseDate(row[mapping.happened_at] || '', tz);
    if (!happenedAt) {
      errors.push({ code: 'PARSE_INVALID_FIELD', row_number: rowNumber, message: `could not parse datetime ${JSON.stringify(row[mapping.happened_at] || '')}`, field_name: 'happened_at' });
      return;
    }
    const opt = (key: string) => (key && row[key] ? row[key].trim() || null : null);
    const tags = (Array.isArray(mapping.tags) ? mapping.tags : []).flatMap((col: string) => String(row[col] || '').split(/[,;|]/).map((v) => v.trim()).filter(Boolean));
    txs.push({
      tx_type: type,
      amount: Math.abs(amount),
      happened_at: happenedAt,
      note: opt(mapping.note),
      category_name: opt(mapping.category_name),
      category_kind: type === 'transfer' ? 'transfer' : type,
      account_name: opt(mapping.account_name),
      from_account_name: opt(mapping.from_account_name),
      to_account_name: opt(mapping.to_account_name),
      tags: [...new Set(tags)],
      currency_code: opt(mapping.currency)?.toUpperCase() ?? null,
      row_number: rowNumber,
    });
  });
  return { txs, errors };
}

function summarize(txs: MappedTx[], errors: any[], dedupSkipped: number) {
  let income = 0;
  let expense = 0;
  let transfer = 0;
  let incomeTotal = 0;
  let expenseTotal = 0;
  const times = txs.map((t) => t.happened_at).sort();
  for (const t of txs) {
    if (t.tx_type === 'income') {
      income++;
      incomeTotal += t.amount;
    } else if (t.tx_type === 'transfer') transfer++;
    else {
      expense++;
      expenseTotal += t.amount;
    }
  }
  return {
    total_rows: txs.length + errors.length,
    time_range_start: times[0] ?? null,
    time_range_end: times[times.length - 1] ?? null,
    total_signed_amount: (incomeTotal - expenseTotal).toFixed(2),
    by_type: {
      expense_count: expense,
      expense_total: expenseTotal.toFixed(2),
      income_count: income,
      income_total: incomeTotal.toFixed(2),
      transfer_count: transfer,
    },
    accounts: { new_names: [], matched_names: [] },
    categories: { new_names: [], matched_names: [] },
    tags: { new_names: [], matched_names: [] },
    skipped_dedup: dedupSkipped,
    parse_errors: errors.slice(0, 50),
    parse_errors_total: errors.length,
    parse_warnings: [],
    parse_warnings_total: 0,
  };
}

function summaryPayload(job: any, mapping: Record<string, any>, txs: MappedTx[], errors: any[], dedupSkipped: number) {
  const rows = parseJson<any[]>(job.rows_json, []);
  const headers = parseJson<string[]>(job.headers_json, []);
  return {
    import_token: job.token,
    expires_at: job.expires_at,
    source_format: 'generic',
    headers,
    suggested_mapping: suggestMapping(headers),
    current_mapping: mapping,
    target_ledger_id: job.ledger_id ?? null,
    dedup_strategy: 'skip_duplicates',
    auto_tag_names: [],
    stats: summarize(txs, errors, dedupSkipped),
    sample_rows: rows.slice(0, 5),
    sample_transactions: txs.slice(0, 10).map((t) => ({
      tx_type: t.tx_type,
      amount: t.amount.toFixed(2),
      happened_at: t.happened_at,
      note: t.note,
      category_name: t.category_name,
      parent_category_name: null,
      account_name: t.account_name,
      from_account_name: t.from_account_name,
      to_account_name: t.to_account_name,
      tag_names: t.tags,
      source_row_number: t.row_number,
    })),
  };
}

async function loadJob(c: any, token: string) {
  const job = await one<any>(c.env.DB, `SELECT * FROM import_jobs WHERE token = ? AND user_id = ?`, token, c.get('auth').user.id);
  if (!job) throw new HttpError(404, 'Import job not found');
  if (new Date(job.expires_at).getTime() < Date.now()) throw new HttpError(410, 'Import job expired');
  return job;
}

function jobLedger(c: any, job: any) {
  return requireLedger(c.env, c.get('auth').user.id, job.ledger_id, ['owner', 'editor']);
}

importRoutes.post('/upload', async (c) => {
  const auth = c.get('auth');
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'file is required');
  if (!file.size) throw new HttpError(400, 'Import file is empty');
  if (file.size > 10 * 1024 * 1024) throw new HttpError(413, 'Import file too large');
  const name = file.name || 'import.csv';
  if (/\.(xlsx|xls)$/i.test(name)) {
    throw new HttpError(422, 'Excel import needs a server-side parser; export the sheet as CSV (UTF-8) and upload that instead.');
  }
  const text = await file.text();
  const table = parseCsv(text);
  if (!table.headers.length) throw new HttpError(422, 'Could not read any columns from the file');
  if (table.rows.length > MAX_ROWS) throw new HttpError(413, `Too many rows (${table.rows.length} > ${MAX_ROWS})`);

  const ledgers = await all<any>(c.env.DB, `SELECT l.* FROM ledgers l JOIN ledger_members m ON m.ledger_id=l.id WHERE m.user_id=? AND l.deleted_at IS NULL ORDER BY l.created_at DESC`, auth.user.id);
  const requested = String(form.get('target_ledger_id') || '');
  const target = requested || ledgers[0]?.external_id;
  if (!target) throw new HttpError(400, 'Create a ledger before importing');

  const token = uuid().replace(/-/g, '');
  const now = nowIso();
  const expires = new Date(Date.now() + 2 * 3600_000).toISOString();
  await run(
    c.env.DB,
    `INSERT INTO import_jobs (token, user_id, ledger_id, file_name, headers_json, rows_json, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    token,
    auth.user.id,
    target,
    name,
    JSON.stringify(table.headers),
    JSON.stringify(table.rows),
    now,
    expires,
  );
  const job = await one<any>(c.env.DB, `SELECT * FROM import_jobs WHERE token = ?`, token);
  const mapping = { ...suggestMapping(table.headers), tz_offset_minutes: toInt(form.get('tz_offset_minutes'), 0) };
  return json(summaryPayload(job, mapping, [], [], 0));
});

importRoutes.post('/:token/preview', async (c) => {
  const job = await loadJob(c, c.req.param('token')!);
  await jobLedger(c, job);
  const body = (await c.req.json().catch(() => ({}))) as any;
  const headers = parseJson<string[]>(job.headers_json, []);
  const mapping = { ...suggestMapping(headers), ...(body.mapping || {}) };
  const rows = parseJson<Record<string, string>[]>(job.rows_json, []);
  const { txs, errors } = mapRows(rows, mapping);
  if (body.target_ledger_id) {
    await jobLedger(c, { ...job, ledger_id: body.target_ledger_id });
    job.ledger_id = body.target_ledger_id;
    await run(c.env.DB, `UPDATE import_jobs SET ledger_id = ? WHERE token = ?`, body.target_ledger_id, job.token);
  }
  return json(summaryPayload(job, mapping, txs, errors, 0));
});

importRoutes.delete('/:token', async (c) => {
  const job = await loadJob(c, c.req.param('token')!);
  await jobLedger(c, job);
  await run(c.env.DB, `DELETE FROM import_jobs WHERE token = ?`, job.token);
  return json({ ok: true });
});

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

importRoutes.post('/:token/execute', async (c) => {
  const auth = c.get('auth');
  const job = await loadJob(c, c.req.param('token')!);
  const ledger = await jobLedger(c, job);
  const headers = parseJson<string[]>(job.headers_json, []);
  const rows = parseJson<Record<string, string>[]>(job.rows_json, []);
  const mapping = suggestMapping(headers);
  const { txs, errors } = mapRows(rows, mapping);
  if (errors.length) {
    return new Response(sse('error', errors[0]), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }
  if (txs.length > MAX_EXECUTE_TX) {
    return new Response(sse('error', { code: 'IMPORT_TOO_LARGE', row_number: 0, message: `This free build imports up to ${MAX_EXECUTE_TX} rows at a time; split the file.`, field_name: null }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }

  const device = c.req.header('x-device-id') || 'web-console';
  const now = nowIso();

  // Create any missing accounts / categories / tags first so transactions can
  // reference them by name, mirroring the web UI.
  const categoryNames = [...new Set(txs.map((t) => t.category_name).filter(Boolean))] as string[];
  const accountNames = new Set<string>();
  const tagNames = new Set<string>();
  for (const t of txs) {
    for (const n of [t.account_name, t.from_account_name, t.to_account_name]) if (n) accountNames.add(n);
    for (const n of t.tags) tagNames.add(n);
  }
  const existingCat = new Map((await all<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id = ?`, auth.user.id)).map((r) => [`${r.name}|${r.kind}`, r]));
  const existingAcc = new Set((await all<any>(c.env.DB, `SELECT name FROM user_accounts WHERE user_id = ?`, auth.user.id)).map((r) => String(r.name).toLowerCase()));
  const existingTag = new Set((await all<any>(c.env.DB, `SELECT name FROM user_tags WHERE user_id = ?`, auth.user.id)).map((r) => String(r.name).toLowerCase()));

  const emitUser = async (entityType: string, sid: string, payload: Record<string, any>) => {
    const changeId = await appendChange(c.env, { userId: auth.user.id, ledgerId: null, scope: 'user', entityType, entitySyncId: sid, action: 'upsert', payload, deviceId: device, updatedByUserId: auth.user.id });
    const input: ChangeInput = { changeId, entityType, entitySyncId: sid, action: 'upsert', payload, updatedAt: now, actorUserId: auth.user.id, deviceId: device };
    await applyUserChange(c.env, auth.user.id, input);
    return changeId;
  };

  for (const name of accountNames) {
    if (existingAcc.has(name.toLowerCase())) continue;
    const sid = `acc_${crypto.randomUUID().replace(/-/g, '')}`;
    await emitUser('account', sid, { syncId: sid, name, type: null, currency: null, initialBalance: 0 });
    existingAcc.add(name.toLowerCase());
  }
  for (const name of categoryNames) {
    const kind = txs.find((t) => t.category_name === name)!.category_kind || 'expense';
    if (existingCat.has(`${name}|${kind}`)) continue;
    const sid = `cat_${crypto.randomUUID().replace(/-/g, '')}`;
    await emitUser('category', sid, { syncId: sid, name, kind, level: 1, sortOrder: null, icon: null, iconType: null });
    existingCat.set(`${name}|${kind}`, { sync_id: sid, name, kind });
  }
  for (const name of tagNames) {
    if (existingTag.has(name.toLowerCase())) continue;
    const sid = `tag_${crypto.randomUUID().replace(/-/g, '')}`;
    await emitUser('tag', sid, { syncId: sid, name, color: null });
    existingTag.add(name.toLowerCase());
  }

  const nextIndexRow = await one<{ n: number }>(c.env.DB, `SELECT COALESCE(MAX(tx_index),0) AS n FROM read_tx WHERE ledger_id = ?`, ledger.id);
  let txIndex = Number(nextIndexRow?.n || 0);
  let created = 0;
  let lastChangeId = 0;
  const accLookup = new Map((await all<any>(c.env.DB, `SELECT sync_id, name FROM user_accounts WHERE user_id = ?`, auth.user.id)).map((r) => [String(r.name).toLowerCase(), r.sync_id]));
  const catLookup = new Map((await all<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id = ?`, auth.user.id)).map((r) => [`${r.name}|${r.kind}`, r.sync_id]));
  const tagLookup = new Map((await all<any>(c.env.DB, `SELECT sync_id, name FROM user_tags WHERE user_id = ?`, auth.user.id)).map((r) => [String(r.name).toLowerCase(), r.sync_id]));

  for (const t of txs) {
    const sid = `tx_${crypto.randomUUID().replace(/-/g, '')}`;
    const payload: Record<string, any> = {
      syncId: sid,
      type: t.tx_type,
      amount: t.amount,
      happenedAt: t.happened_at,
      txIndex: ++txIndex,
      excludeFromStats: false,
      excludeFromBudget: false,
      createdByUserId: auth.user.id,
      updatedByUserId: auth.user.id,
    };
    if (t.note) payload.note = t.note;
    if (t.category_name) {
      payload.categoryName = t.category_name;
      payload.categoryKind = t.category_kind;
      const catId = catLookup.get(`${t.category_name}|${t.category_kind}`);
      if (catId) payload.categoryId = catId;
    }
    const accId = t.account_name ? accLookup.get(t.account_name.toLowerCase()) : null;
    if (t.account_name) payload.accountName = t.account_name;
    if (accId) payload.accountId = accId;
    if (t.from_account_name) payload.fromAccountName = t.from_account_name;
    if (t.to_account_name) payload.toAccountName = t.to_account_name;
    if (t.tags.length) {
      payload.tags = t.tags.join(',');
      payload.tagIds = t.tags.map((n) => tagLookup.get(n.toLowerCase())).filter(Boolean);
    }
    if (t.currency_code) payload.currencyCode = t.currency_code;

    lastChangeId = await appendChange(c.env, {
      userId: ledger.user_id,
      ledgerId: ledger.id,
      scope: 'ledger',
      entityType: 'transaction',
      entitySyncId: sid,
      action: 'upsert',
      payload,
      deviceId: device,
      updatedByUserId: auth.user.id,
    });
    const input: ChangeInput = { changeId: lastChangeId, entityType: 'transaction', entitySyncId: sid, action: 'upsert', payload, updatedAt: now, actorUserId: auth.user.id, deviceId: device };
    await applyLedgerChange(c.env, ledger, input);
    created++;
  }

  await broadcastToLedger(c.env, ledger.id, { type: 'sync_change', ledgerId: ledger.external_id, serverCursor: lastChangeId, serverTimestamp: nowIso() });
  await run(c.env.DB, `DELETE FROM import_jobs WHERE token = ?`, job.token);

  const body =
    sse('stage', { stage: 'transactions', done: created, total: txs.length, skipped: 0 }) +
    sse('complete', { created_tx_count: created, skipped_count: 0, new_change_id: lastChangeId });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
});
