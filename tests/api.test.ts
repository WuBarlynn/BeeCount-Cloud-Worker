import { SELF } from 'cloudflare:test';
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

describe('BeeCount Cloud Worker API', () => {
  let token = '';
  let device = '';

  it('registers the first user as admin and returns a session', async () => {
    const res = await call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'secret123', client_type: 'web', device_name: 'Vitest', platform: 'web' }),
    });
    expect(res.status).toBe(200);
    expect(res.body.user.is_admin).toBe(true);
    token = res.body.access_token;
    device = res.body.device_id;
    expect(token).toBeTruthy();
  });

  it('rejects writes without a token', async () => {
    const res = await call('/write/ledgers', { method: 'POST', body: JSON.stringify({ ledger_name: 'X' }) });
    expect(res.status).toBe(401);
  });

  it('creates a ledger and returns commit metadata', async () => {
    const res = await call('/write/ledgers', { method: 'POST', body: JSON.stringify({ ledger_id: 'main', ledger_name: 'Main', currency: 'CNY' }) }, token);
    expect(res.status).toBe(200);
    expect(res.body.ledger_id).toBe('main');
    expect(res.body.new_change_id).toBeGreaterThan(0);
  });

  it('creates an account, category and transaction, then reads them back', async () => {
    const acc = await call('/write/ledgers/main/accounts', { method: 'POST', body: JSON.stringify({ base_change_id: 0, name: 'Wallet' }) }, token);
    expect(acc.status).toBe(200);
    const cat = await call('/write/ledgers/main/categories', { method: 'POST', body: JSON.stringify({ base_change_id: 0, name: 'Food', kind: 'expense' }) }, token);
    expect(cat.status).toBe(200);
    const tx = await call('/write/ledgers/main/transactions', {
      method: 'POST',
      headers: { 'x-device-id': device },
      body: JSON.stringify({ base_change_id: 0, tx_type: 'expense', amount: 12.34, happened_at: '2026-01-02T03:04:05Z', note: 'lunch', category_name: 'Food', category_kind: 'expense', account_name: 'Wallet' }),
    }, token);
    expect(tx.status).toBe(200);
    expect(tx.body.entity_id).toMatch(/^tx_/);

    const read = await call('/read/ledgers/main/transactions?limit=10', {}, token);
    expect(read.status).toBe(200);
    expect(read.body.length).toBe(1);
    expect(read.body[0].amount).toBeCloseTo(12.34);
    expect(read.body[0].note).toBe('lunch');
  });

  it('returns a sync snapshot that mobile clients can consume', async () => {
    const full = await call('/sync/full?ledger_id=main', {}, token);
    expect(full.status).toBe(200);
    const snapshot = JSON.parse(full.body.snapshot.payload.content);
    expect(snapshot.ledgerSyncId).toBe('main');
    expect(snapshot.items.length).toBe(1);
    expect(snapshot.accounts.length).toBe(1);
    expect(snapshot.categories.length).toBe(1);
  });

  it('applies a mobile push and hides it from the pushing device', async () => {
    const push = await call('/sync/push', {
      method: 'POST',
      headers: { 'x-device-id': device },
      body: JSON.stringify({
        device_id: device,
        changes: [
          {
            ledger_id: 'main',
            entity_type: 'transaction',
            entity_sync_id: 'tx_mobile_1',
            action: 'upsert',
            payload: { type: 'income', amount: 5, happenedAt: '2026-01-03T00:00:00Z', note: 'refund' },
            updated_at: '2026-01-03T00:00:01Z',
          },
        ],
      }),
    }, token);
    expect(push.status).toBe(200);
    expect(push.body.accepted).toBe(1);

    const sameDevice = await call(`/sync/pull?since=0&device_id=${device}`, {}, token);
    expect(sameDevice.body.changes.every((c: any) => c.updated_by_device_id !== device)).toBe(true);

    const otherDevice = await call('/sync/pull?since=0', {}, token);
    expect(otherDevice.body.changes.some((c: any) => c.entity_sync_id === 'tx_mobile_1')).toBe(true);
  });

  it('rejects stale LWW pushes', async () => {
    const body = {
      device_id: device,
      changes: [
        {
          ledger_id: 'main',
          entity_type: 'transaction',
          entity_sync_id: 'tx_mobile_1',
          action: 'upsert',
          payload: { type: 'income', amount: 1 },
          updated_at: '2020-01-01T00:00:00Z',
        },
      ],
    };
    const res = await call('/sync/push', { method: 'POST', headers: { 'x-device-id': device }, body: JSON.stringify(body) }, token);
    expect(res.status).toBe(200);
    expect(res.body.rejected).toBe(1);
    expect(res.body.conflict_count).toBe(1);
  });

  it('uploads an attachment and serves it back', async () => {
    const form = new FormData();
    form.set('ledger_id', 'main');
    form.set('file', new File([new Uint8Array([1, 2, 3, 4])], 'tiny.bin', { type: 'application/octet-stream' }));
    const up = await SELF.fetch(`${BASE}/attachments/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    expect(up.status).toBe(200);
    const uploaded = (await up.json()) as any;
    const down = await SELF.fetch(`${BASE}/attachments/${uploaded.file_id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(down.status).toBe(200);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('shares a ledger through an invite', async () => {
    const reg = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email: 'editor@example.com', password: 'secret123', client_type: 'web' }) });
    const editorToken = reg.body.access_token;
    const invite = await call('/ledgers/main/invites', { method: 'POST', body: JSON.stringify({ expires_in_hours: 24 }) }, token);
    expect(invite.status).toBe(201);
    const preview = await call(`/invites/${invite.body.code}/preview`, { method: 'POST' }, editorToken);
    expect(preview.status).toBe(200);
    const accept = await call(`/invites/${invite.body.code}/accept`, { method: 'POST' }, editorToken);
    expect(accept.status).toBe(200);
    expect(accept.body.member_count).toBe(2);
    const members = await call('/ledgers/main/members', {}, token);
    expect(members.body.length).toBe(2);
    const resources = await call('/ledgers/main/shared-resources', {}, editorToken);
    expect(resources.status).toBe(200);
    expect(resources.body.accounts.length).toBe(1);
  });

  it('supports 2FA enrolment and challenge login', async () => {
    const setupRes = await call('/auth/2fa/setup', { method: 'POST', body: '{}' }, token);
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.secret.length).toBe(32);
    const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'owner@example.com', password: 'secret123', client_type: 'web' }) });
    // not enabled yet: normal token
    expect(login.body.requires_2fa).toBe(false);
  });
});
