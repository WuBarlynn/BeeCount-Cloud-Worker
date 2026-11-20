import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const BASE = 'https://example.com/api/v1';

async function call(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type') && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const res = await SELF.fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const db = () => env.DB as D1Database;

describe('admin data cleanup', () => {
  let token = '';
  let userId = '';

  it('sets up an admin with a ledger, category, transaction and budget', async () => {
    const reg = await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'cleanup@example.com', password: 'secret123', client_type: 'web', device_name: 'Vitest', platform: 'web' }),
    });
    expect(reg.status).toBe(200);
    token = reg.body.access_token;
    userId = reg.body.user.id;

    expect((await call('/write/ledgers', { method: 'POST', body: JSON.stringify({ ledger_id: 'main', ledger_name: 'Main', currency: 'CNY' }) }, token)).status).toBe(200);
    expect((await call('/write/ledgers/main/accounts', { method: 'POST', body: JSON.stringify({ base_change_id: 0, name: 'Wallet' }) }, token)).status).toBe(200);
    const cat = await call('/write/ledgers/main/categories', { method: 'POST', body: JSON.stringify({ base_change_id: 0, name: 'Food', kind: 'expense' }) }, token);
    expect(cat.status).toBe(200);
    const categoryId = cat.body.entity_id;

    const tx = await call('/write/ledgers/main/transactions', {
      method: 'POST',
      body: JSON.stringify({ base_change_id: 0, tx_type: 'expense', amount: 12.34, happened_at: '2026-01-02T03:04:05Z', note: 'lunch', category_id: categoryId, category_name: 'Food', category_kind: 'expense', account_name: 'Wallet' }),
    }, token);
    expect(tx.status).toBe(200);

    const budget = await call('/write/ledgers/main/budgets', {
      method: 'POST',
      body: JSON.stringify({ base_change_id: 0, type: 'category', category_id: categoryId, amount: 500, period: 'monthly', start_day: 1 }),
    }, token);
    expect(budget.status).toBe(200);

    // Simulate the projection left behind after the category was deleted.
    await db().prepare('DELETE FROM user_categories WHERE sync_id = ?').bind(categoryId).run();
    // An attachment row nobody references any more.
    await db().prepare(`INSERT INTO attachments (id, user_id, ledger_id, kind, sha256, file_name, original_name, size, mime_type, r2_key, created_at)
                        VALUES ('att_orphan', ?, 'main', 'transaction', 'deadbeef', 'orphan.png', 'orphan.png', 2048, 'image/png', 'attachments/orphan.png', '2026-01-02T00:00:00Z')`)
      .bind(userId).run();
    // Same attachment must not be flagged again once its transaction references it.
  });

  it('scan finds the orphans and clean removes them via the records payload', async () => {
    const scan = await call('/admin/data-cleanup/scan', {}, token);
    expect(scan.status).toBe(200);
    const records = [...scan.body.db_orphans, ...scan.body.file_orphans, ...scan.body.sync_orphans];
    expect(records.map((r: any) => r.type).sort()).toEqual(['attachment_no_ref', 'budget_missing_category', 'tx_missing_category']);
    expect(scan.body.total_count).toBe(3);

    // Exactly what the console sends: the selected record objects.
    const clean = await call('/admin/data-cleanup/clean', {
      method: 'POST',
      body: JSON.stringify({ records }),
    }, token);
    expect(clean.status).toBe(200);
    expect(clean.body.failures).toEqual([]);
    expect(clean.body.success_count).toBe(3);

    const again = await call('/admin/data-cleanup/scan', {}, token);
    expect(again.body.total_count).toBe(0);

    const tx = await db().prepare(`SELECT category_sync_id, category_name FROM read_tx WHERE sync_id = ?`).bind(records.find((r: any) => r.type === 'tx_missing_category').sync_id).first<any>();
    expect(tx?.category_sync_id ?? null).toBeNull();
    const budget = await db().prepare(`SELECT category_sync_id FROM read_budgets`).first<any>();
    expect(budget?.category_sync_id ?? null).toBeNull();
    const att = await db().prepare(`SELECT id FROM attachments WHERE id = 'att_orphan'`).first<any>();
    expect(att).toBeNull();
  });

  it('still accepts the legacy keys payload', async () => {
    await db().prepare(`INSERT INTO attachments (id, user_id, ledger_id, kind, sha256, file_name, original_name, size, mime_type, r2_key, created_at)
                        VALUES ('att_orphan2', ?, 'main', 'transaction', 'cafebabe', 'orphan2.png', 'orphan2.png', 1024, 'image/png', 'attachments/orphan2.png', '2026-01-02T00:00:00Z')`)
      .bind(userId).run();
    const clean = await call('/admin/data-cleanup/clean', {
      method: 'POST',
      body: JSON.stringify({ keys: ['attachment_no_ref:att_orphan2'] }),
    }, token);
    expect(clean.body.success_count).toBe(1);
    expect(clean.body.failures).toEqual([]);
  });
});
