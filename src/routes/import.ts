import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one, reserveChangeIds, run } from '../lib/db';
import { broadcastToLedger } from '../lib/changes';
import { HttpError, json, nowIso, parseJson, toFloat, toInt, uuid } from '../lib/util';
import { requireLedger } from '../lib/ledger';
import { parseCsv, type CsvTable } from '../lib/csv';
import { parseXlsx } from '../lib/xlsx';

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
  const lower = name.toLowerCase();
  if (lower.endsWith('.xls') || lower.endsWith('.xlsb')) {
    throw new HttpError(422, 'Legacy .xls/.xlsb files are not supported; save the sheet as .xlsx or CSV (UTF-8) and upload again.');
  }
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  let table: CsvTable;
  if (lower.endsWith('.xlsx') || (isZip && !lower.endsWith('.csv') && !lower.endsWith('.tsv'))) {
    try {
      table = await parseXlsx(await file.arrayBuffer());
    } catch (e) {
      throw new HttpError(422, `Could not read the Excel workbook: ${(e as Error)?.message || e}`);
    }
  } else {
    table = parseCsv(await file.text());
  }
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
  const dedupStrategy = body.dedup_strategy === 'insert_all' ? 'insert_all' : 'skip_duplicates';
  const autoTags: string[] = Array.isArray(body.auto_tag_names)
    ? [...new Set<string>(body.auto_tag_names.map((x: any) => String(x).trim()).filter(Boolean))]
    : [];
  const { txs, errors } = mapRows(rows, mapping);
  if (autoTags.length) for (const t of txs) t.tags = [...new Set([...t.tags, ...autoTags])];
  if (body.target_ledger_id) {
    await jobLedger(c, { ...job, ledger_id: body.target_ledger_id });
    job.ledger_id = body.target_ledger_id;
  }
  await run(
    c.env.DB,
    `UPDATE import_jobs SET ledger_id = ?, mapping_json = ?, dedup_strategy = ?, auto_tag_names_json = ? WHERE token = ?`,
    job.ledger_id,
    JSON.stringify(mapping),
    dedupStrategy,
    JSON.stringify(autoTags),
    job.token,
  );
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
  const mapping = parseJson<Record<string, any>>(job.mapping_json, suggestMapping(headers));
  const autoTags = parseJson<string[]>(job.auto_tag_names_json, []);
  const dedupStrategy = job.dedup_strategy === 'insert_all' ? 'insert_all' : 'skip_duplicates';
  const mapped = mapRows(rows, mapping);
  let txs = mapped.txs;
  const errors = mapped.errors;
  if (autoTags.length) for (const t of txs) t.tags = [...new Set([...t.tags, ...autoTags])];
  if (errors.length) {
    return new Response(sse('error', errors[0]), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }
  if (txs.length > MAX_EXECUTE_TX) {
    return new Response(sse('error', { code: 'IMPORT_TOO_LARGE', row_number: 0, message: `This build imports up to ${MAX_EXECUTE_TX} rows at a time; split the file.`, field_name: null }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }

  const device = c.req.header('x-device-id') || 'web-console';
  const now = nowIso();

  const txKey = (v: { tx_type: string; amount: number; happened_at: string; note: string | null; category_name: string | null }) =>
    [v.tx_type, Number(v.amount).toFixed(2), v.happened_at, (v.note || '').trim(), (v.category_name || '').trim()].join('|');
  const existingTx = await all<any>(
    c.env.DB,
    `SELECT tx_type, amount, happened_at, note, category_name FROM read_tx WHERE ledger_id = ?`,
    ledger.id,
  );
  const seen = new Set(existingTx.map((r) => txKey(r)));
  let dedupSkipped = 0;
  const accepted: typeof txs = [];
  for (const t of txs) {
    const key = txKey(t);
    if (dedupStrategy !== 'insert_all' && seen.has(key)) {
      dedupSkipped++;
      continue;
    }
    seen.add(key);
    accepted.push(t);
  }
  txs = accepted;

  const existingCats = await all<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id = ?`, auth.user.id);
  const existingAccs = await all<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id = ?`, auth.user.id);
  const existingTags = await all<any>(c.env.DB, `SELECT * FROM user_tags WHERE user_id = ?`, auth.user.id);
  const catLookup = new Map<string, string>(existingCats.map((r) => [`${r.name}|${r.kind}`, r.sync_id]));
  const accLookup = new Map<string, string>(existingAccs.map((r) => [String(r.name).toLowerCase(), r.sync_id]));
  const tagLookup = new Map<string, string>(existingTags.map((r) => [String(r.name).toLowerCase(), r.sync_id]));

  const newAccounts: string[] = [];
  const newCategories: { name: string; kind: string; sid: string }[] = [];
  const newTags: { name: string; sid: string }[] = [];
  for (const t of txs) {
    for (const n of [t.account_name, t.from_account_name, t.to_account_name]) {
      if (!n) continue;
      const key = n.toLowerCase();
      if (accLookup.has(key)) continue;
      const sid = `acc_${crypto.randomUUID().replace(/-/g, '')}`;
      accLookup.set(key, sid);
      newAccounts.push(n);
      (accLookup as any).set(`sid:${sid}`, n);
    }
    if (t.category_name && t.category_kind) {
      const key = `${t.category_name}|${t.category_kind}`;
      if (!catLookup.has(key)) {
        const sid = `cat_${crypto.randomUUID().replace(/-/g, '')}`;
        catLookup.set(key, sid);
        newCategories.push({ name: t.category_name, kind: t.category_kind, sid });
      }
    }
    for (const n of t.tags) {
      const key = n.toLowerCase();
      if (tagLookup.has(key)) continue;
      const sid = `tag_${crypto.randomUUID().replace(/-/g, '')}`;
      tagLookup.set(key, sid);
      newTags.push({ name: n, sid });
    }
  }

  const totalChanges = newAccounts.length + newCategories.length + newTags.length + txs.length;
  const firstChangeId = await reserveChangeIds(c.env.DB, totalChanges);
  let changeId = firstChangeId;

  const statements: D1PreparedStatement[] = [];
  const changeStmt = (scope: 'user' | 'ledger', entityType: string, sid: string, payload: Record<string, any>, id: number) =>
    c.env.DB.prepare(
      `INSERT INTO sync_changes
        (change_id,user_id,ledger_id,scope,entity_type,entity_sync_id,action,payload_json,updated_at,
         updated_by_device_id,updated_by_user_id,created_at)
       VALUES (?,?,?,?,?,?, 'upsert', ?,?,?,?,?)`,
    ).bind(
      id,
      scope === 'user' ? auth.user.id : ledger.user_id,
      scope === 'user' ? null : ledger.id,
      scope,
      entityType,
      sid,
      JSON.stringify(payload),
      now,
      device,
      auth.user.id,
      now,
    );

  // Accounts: map name -> sid from the lookup table.
  for (const name of newAccounts) {
    const sid = accLookup.get(name.toLowerCase())!;
    const payload = { syncId: sid, name, type: null, currency: null, initialBalance: 0 };
    statements.push(changeStmt('user', 'account', sid, payload, changeId++));
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_accounts (user_id,sync_id,name,initial_balance,hidden,source_change_id)
         VALUES (?,?,?,0,0,?) ON CONFLICT(user_id,sync_id) DO UPDATE SET name=excluded.name`,
      ).bind(auth.user.id, sid, name, changeId - 1),
    );
  }
  for (const cat of newCategories) {
    const payload = { syncId: cat.sid, name: cat.name, kind: cat.kind, level: 1, sortOrder: null };
    statements.push(changeStmt('user', 'category', cat.sid, payload, changeId++));
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_categories (user_id,sync_id,name,kind,level,source_change_id)
         VALUES (?,?,?,?,1,?) ON CONFLICT(user_id,sync_id) DO UPDATE SET name=excluded.name`,
      ).bind(auth.user.id, cat.sid, cat.name, cat.kind, changeId - 1),
    );
  }
  for (const tag of newTags) {
    const payload = { syncId: tag.sid, name: tag.name, color: null };
    statements.push(changeStmt('user', 'tag', tag.sid, payload, changeId++));
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO user_tags (user_id,sync_id,name,source_change_id) VALUES (?,?,?,?)
         ON CONFLICT(user_id,sync_id) DO UPDATE SET name=excluded.name`,
      ).bind(auth.user.id, tag.sid, tag.name, changeId - 1),
    );
  }

  let txIndexRow = await one<{ n: number }>(c.env.DB, `SELECT COALESCE(MAX(tx_index),0) AS n FROM read_tx WHERE ledger_id = ?`, ledger.id);
  let txIndex = Number(txIndexRow?.n || 0);
  let created = 0;
  let lastChangeId = changeId - 1;

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
    if (t.account_name) {
      payload.accountName = t.account_name;
      const id = accLookup.get(t.account_name.toLowerCase());
      if (id) payload.accountId = id;
    }
    if (t.from_account_name) payload.fromAccountName = t.from_account_name;
    if (t.to_account_name) payload.toAccountName = t.to_account_name;
    if (t.tags.length) {
      payload.tags = t.tags.join(',');
      payload.tagIds = t.tags.map((n) => tagLookup.get(n.toLowerCase())).filter(Boolean);
    }
    if (t.currency_code) payload.currencyCode = t.currency_code;

    const id = changeId++;
    lastChangeId = id;
    statements.push(changeStmt('ledger', 'transaction', sid, payload, id));
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO read_tx
          (ledger_id,sync_id,tx_type,amount,happened_at,note,category_sync_id,category_name,category_kind,
           account_sync_id,account_name,from_account_name,to_account_name,tags_csv,tag_sync_ids_json,tx_index,
           currency_code,exclude_from_stats,exclude_from_budget,created_by_user_id,last_edited_by_user_id,source_change_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
      ).bind(
        ledger.id,
        sid,
        t.tx_type,
        t.amount,
        t.happened_at,
        t.note,
        payload.categoryId ?? null,
        t.category_name,
        t.category_kind,
        payload.accountId ?? null,
        t.account_name,
        t.from_account_name,
        t.to_account_name,
        payload.tags ?? null,
        payload.tagIds ? JSON.stringify(payload.tagIds) : null,
        payload.txIndex,
        payload.currencyCode ?? null,
        auth.user.id,
        auth.user.id,
        id,
      ),
    );
    created++;
  }

  for (let i = 0; i < statements.length; i += 400) {
    await c.env.DB.batch(statements.slice(i, i + 400));
  }

  await broadcastToLedger(c.env, ledger.id, { type: 'sync_change', ledgerId: ledger.external_id, serverCursor: lastChangeId, serverTimestamp: nowIso() });
  await run(c.env.DB, `DELETE FROM import_jobs WHERE token = ?`, job.token);

  const body =
    sse('stage', { stage: 'transactions', done: created, total: txs.length, skipped: dedupSkipped }) +
    sse('complete', { created_tx_count: created, skipped_count: dedupSkipped, new_change_id: lastChangeId });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' } });
});
