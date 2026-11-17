import { SELF, env } from 'cloudflare:test';
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

/**
 * Mirrors what the mobile client pushes for a whole ledger: mixed batch of
 * user-global entities (account) and ledger-scoped ones (budget, transaction).
 */
describe('mobile push of accounts, budgets and transactions', () => {
  it('projects every entity type in one mixed batch', async () => {
    const reg = await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'mixed@example.com', password: 'secret123', client_type: 'app', device_name: 'Phone', platform: 'ios' }),
    });
    expect(reg.status).toBe(200);
    const token = reg.body.access_token as string;
    const device = reg.body.device_id as string;

    const changes = [
      {
        ledger_id: '0',
        entity_type: 'account',
        entity_sync_id: 'acc-1',
        action: 'upsert',
        payload: { syncId: 'acc-1', name: '招商银行', type: 'bank', currency: 'CNY', initialBalance: 100, sortOrder: 0, hidden: false },
        updated_at: '2026-11-17T14:00:00.000Z',
      },
      {
        ledger_id: 'ledger-a',
        entity_type: 'budget',
        entity_sync_id: 'bud-1',
        action: 'upsert',
        payload: { syncId: 'bud-1', type: 'total', amount: 3000, period: 'monthly', startDay: 1, enabled: true },
        updated_at: '2026-11-17T14:00:01.000Z',
      },
      {
        ledger_id: 'ledger-a',
        entity_type: 'budget',
        entity_sync_id: 'bud-2',
        action: 'upsert',
        payload: { syncId: 'bud-2', type: 'category', categoryId: 'cat-1', amount: 800, period: 'monthly', startDay: 1, enabled: true },
        updated_at: '2026-11-17T14:00:01.500Z',
      },
      {
        ledger_id: 'ledger-a',
        entity_type: 'transaction',
        entity_sync_id: 'tx-1',
        action: 'upsert',
        payload: {
          syncId: 'tx-1',
          type: 'expense',
          amount: 12.5,
          happenedAt: '2026-11-17T12:00:00.000Z',
          note: '午饭',
          categoryId: 'cat-1',
          categoryName: '餐饮',
          categoryKind: 'expense',
          accountId: 'acc-1',
          accountName: '招商银行',
        },
        updated_at: '2026-11-17T14:00:02.000Z',
      },
    ];

    const push = await call('/sync/push', { method: 'POST', body: JSON.stringify({ device_id: device, changes }) }, token);
    expect(push.status).toBe(200);
    expect(push.body.accepted).toBe(4);

    const accounts = await call('/read/ledgers/ledger-a/accounts', {}, token);
    expect(accounts.status).toBe(200);
    expect(accounts.body.map((a: any) => a.name)).toContain('招商银行');

    const budgets = await call('/read/ledgers/ledger-a/budgets', {}, token);
    expect(budgets.status).toBe(200);
    expect(budgets.body.length).toBe(2);
    expect(budgets.body.find((b: any) => b.type === 'total')?.amount).toBe(3000);

    const tx = await call('/read/ledgers/ledger-a/transactions?limit=10', {}, token);
    expect(tx.body.length).toBe(1);
    expect(tx.body[0].account_name).toBe('招商银行');

    const pull = await call('/sync/pull?since=0', {}, token);
    expect(pull.body.changes.some((c: any) => c.entity_type === 'budget')).toBe(true);
  });
});

describe('push resilience', () => {
  async function newUser(email: string) {
    const reg = await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'secret123', client_type: 'app', device_name: 'Phone', platform: 'ios' }),
    });
    expect(reg.status).toBe(200);
    return { token: reg.body.access_token as string, device: reg.body.device_id as string };
  }

  it('re-projects a replayed change whose projection row was lost', async () => {
    const { env } = await import('cloudflare:test');
    const { token, device } = await newUser('replay@example.com');
    const change = {
      ledger_id: 'ledger-replay',
      entity_type: 'budget',
      entity_sync_id: 'bud-replay',
      action: 'upsert',
      payload: { syncId: 'bud-replay', type: 'total', amount: 500, period: 'monthly', startDay: 1, enabled: true },
      updated_at: '2026-11-17T15:00:00.000Z',
    };
    const first = await call('/sync/push', { method: 'POST', body: JSON.stringify({ device_id: device, changes: [change] }) }, token);
    expect(first.body.accepted).toBe(1);

    // Simulate a projection that never landed (or was wiped).
    await env.DB.prepare(`DELETE FROM read_budgets WHERE sync_id = 'bud-replay'`).run();

    const replay = await call('/sync/push', { method: 'POST', body: JSON.stringify({ device_id: device, changes: [change] }) }, token);
    expect(replay.status).toBe(200);

    const budgets = await call('/read/ledgers/ledger-replay/budgets', {}, token);
    expect(budgets.body.map((b: any) => b.id)).toContain('bud-replay');
  });

  it('falls back to the only ledger when ledger_id is missing', async () => {
    const { token, device } = await newUser('fallback@example.com');
    const push = await call('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        device_id: device,
        changes: [
          {
            ledger_id: 'only-ledger',
            entity_type: 'ledger',
            entity_sync_id: 'only-ledger',
            action: 'upsert',
            payload: { ledgerName: 'Only', currency: 'CNY' },
            updated_at: '2026-11-17T15:01:00.000Z',
          },
          {
            entity_type: 'budget',
            entity_sync_id: 'bud-noledger',
            action: 'upsert',
            payload: { syncId: 'bud-noledger', type: 'total', amount: 1200, period: 'monthly', startDay: 1, enabled: true },
            updated_at: '2026-11-17T15:01:01.000Z',
          },
        ],
      }),
    }, token);
    expect(push.status).toBe(200);
    expect(push.body.accepted).toBe(2);
    expect(push.body.skipped).toBe(0);

    const budgets = await call('/read/ledgers/only-ledger/budgets', {}, token);
    expect(budgets.body.some((b: any) => b.amount === 1200)).toBe(true);
  });

  it('reports skipped changes instead of dropping them silently', async () => {
    const { token, device } = await newUser('skip@example.com');
    await call('/write/ledgers', { method: 'POST', body: JSON.stringify({ ledger_id: 'a', ledger_name: 'A' }) }, token);
    await call('/write/ledgers', { method: 'POST', body: JSON.stringify({ ledger_id: 'b', ledger_name: 'B' }) }, token);
    const push = await call('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        device_id: device,
        changes: [
          {
            entity_type: 'budget',
            entity_sync_id: 'bud-orphan',
            action: 'upsert',
            payload: { syncId: 'bud-orphan', type: 'total', amount: 10 },
            updated_at: '2026-11-17T15:02:00.000Z',
          },
        ],
      }),
    }, token);
    expect(push.status).toBe(200);
    expect(push.body.skipped).toBe(1);
    expect(push.body.skip_samples[0].reason).toBe('missing_ledger_id');
  });

  it('resolves a transaction ledger from payload.ledgerSyncId when the envelope carries 0', async () => {
    const { token, device } = await newUser('acct-tx@example.com');
    const push = await call('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        device_id: device,
        changes: [
          {
            ledger_id: 'ledger-acct',
            entity_type: 'ledger',
            entity_sync_id: 'ledger-acct',
            action: 'upsert',
            payload: { ledgerName: '账户账本', currency: 'CNY' },
            updated_at: '2026-11-17T15:03:00.000Z',
          },
          {
            ledger_id: '0',
            entity_type: 'account',
            entity_sync_id: 'acc-meal',
            action: 'upsert',
            payload: { syncId: 'acc-meal', name: '遇见小面储值', type: 'other', currency: 'CNY', initialBalance: 100, hidden: false },
            updated_at: '2026-11-17T15:03:01.000Z',
          },
          {
            // Legacy mobile bug: a transaction recorded from an account screen
            // arrives with the account's local ledger id (0) instead of the
            // real one; the payload still names the ledger.
            ledger_id: '0',
            entity_type: 'transaction',
            entity_sync_id: 'tx-acct',
            action: 'upsert',
            payload: {
              syncId: 'tx-acct',
              type: 'expense',
              amount: 15.9,
              happenedAt: '2026-11-17T11:31:00.000Z',
              categoryName: '餐饮',
              categoryKind: 'expense',
              accountId: 'acc-meal',
              accountName: '',
              ledgerSyncId: 'ledger-acct',
            },
            updated_at: '2026-11-17T15:03:02.000Z',
          },
        ],
      }),
    }, token);
    expect(push.status).toBe(200);
    expect(push.body.accepted).toBe(3);
    expect(push.body.skipped).toBe(0);

    const tx = await call('/read/ledgers/ledger-acct/transactions?limit=10', {}, token);
    expect(tx.body.length).toBe(1);
    expect(tx.body[0].amount).toBe(15.9);
    // The app sends accountId only; the name is resolved from the account projection.
    expect(tx.body[0].account_name).toBe('遇见小面储值');
  });

  it('backfills a transaction that only the full-ledger snapshot carries', async () => {
    const { token, device } = await newUser('snapshot@example.com');
    const item = {
      syncId: 'tx-only-in-snapshot',
      type: 'expense',
      amount: 15.9,
      happenedAt: '2026-11-17T11:31:50.000Z',
      note: null,
      currencyCode: 'CNY',
      nativeAmount: 15.9,
      categoryId: 'cat-meal',
      categoryName: '餐饮',
      categoryKind: 'expense',
      accountId: 'acc-meal',
      accountName: '遇见小面储值',
    };
    const push = await call('/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        device_id: device,
        changes: [
          {
            ledger_id: 'ledger-snap',
            entity_type: 'ledger',
            entity_sync_id: 'ledger-snap',
            action: 'upsert',
            payload: { ledgerName: '快照账本', currency: 'CNY' },
            updated_at: '2026-11-17T15:04:00.000Z',
          },
          {
            ledger_id: 'ledger-snap',
            entity_type: 'ledger_snapshot',
            entity_sync_id: 'ledger-snap',
            action: 'upsert',
            payload: { content: JSON.stringify({ version: 6, count: 1, items: [item] }), metadata: { type: 'full_push' } },
            updated_at: '2026-11-17T15:04:01.000Z',
          },
        ],
      }),
    }, token);
    expect(push.status).toBe(200);

    const tx = await call('/read/ledgers/ledger-snap/transactions?limit=10', {}, token);
    expect(tx.body.map((t: any) => t.id)).toContain('tx-only-in-snapshot');
    expect(tx.body.find((t: any) => t.id === 'tx-only-in-snapshot').amount).toBe(15.9);

    // The backfilled row is a real change, so other devices receive it on pull.
    const pull = await call('/sync/pull?since=0', {}, token);
    expect(pull.body.changes.some((c: any) => c.entity_sync_id === 'tx-only-in-snapshot')).toBe(true);
  });
});
