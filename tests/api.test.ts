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

  it('serves avatars publicly for <img> tags', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' }));
    const up = await SELF.fetch(`${BASE}/profile/avatar`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    expect(up.status).toBe(200);
    const body = (await up.json()) as any;
    expect(body.avatar_url).toContain('/api/v1/profile/avatar/');
    const url = body.avatar_url.replace('/api/v1', BASE);
    const pub = await SELF.fetch(url);
    expect(pub.status).toBe(200);
    expect(new Uint8Array(await pub.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('imports a CSV in batches and creates missing dictionaries', async () => {
    const before = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    const csv = '日期,类型,金额,分类,账户,备注\n2026-02-01,支出,10,交通,现金,地铁\n2026-02-02,收入,20,工资,现金,工资\n';
    const form = new FormData();
    form.set('file', new File([csv], 'import.csv', { type: 'text/csv' }));
    form.set('target_ledger_id', 'main');
    form.set('tz_offset_minutes', '480');
    const up = await SELF.fetch(`${BASE}/import/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    expect(up.status).toBe(200);
    const job = (await up.json()) as any;
    const preview = await call(`/import/${job.import_token}/preview`, {
      method: 'POST',
      body: JSON.stringify({
        mapping: { ...job.current_mapping, tx_type: '类型', amount: '金额', happened_at: '日期', category_name: '分类', account_name: '账户', note: '备注' },
        target_ledger_id: 'main',
      }),
    }, token);
    expect(preview.status).toBe(200);
    expect(preview.body.stats.total_rows).toBe(2);
    const run = await SELF.fetch(`${BASE}/import/${job.import_token}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(run.status).toBe(200);
    const text = await run.text();
    expect(text).toContain('event: complete');
    expect(text).toContain('"created_tx_count":2');
    const txs = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    expect(txs.body.length).toBe(before.body.length + 2);
  });

  it('serves MCP over stateless HTTP and keeps PATs off the REST API', async () => {
    const created = await call('/profile/pats', { method: 'POST', body: JSON.stringify({ name: 'Claude Desktop', scopes: ['mcp:read', 'mcp:write'], expires_in_days: 90 }) }, token);
    expect(created.status).toBe(201);
    const pat = created.body.token as string;
    expect(pat.startsWith('bcmcp_')).toBe(true);

    const blocked = await call('/read/ledgers', {}, pat);
    expect(blocked.status).toBe(403);

    const mcp = async (payload: any) => {
      const res = await SELF.fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe('2025-03-26');
    expect(init.body.result.serverInfo.name).toBe('BeeCount Cloud');

    const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.body.result.tools.map((t: any) => t.name);
    expect(names).toContain('list_transactions');
    expect(names).toContain('create_transaction');
    expect(names).not.toContain('upload_attachment');

    const before = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    const callRes = await mcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_transaction', arguments: { ledger_id: 'main', tx_type: 'expense', amount: 6.5, category_name: 'Food', account_name: 'Wallet', note: 'coffee via MCP', tags: ['mcp'] } },
    });
    expect(callRes.status).toBe(200);
    const createdTx = JSON.parse(callRes.body.result.content[0].text);
    expect(createdTx.status).toBe('created');
    expect(createdTx.transaction_id).toMatch(/^tx_/);

    const after = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    expect(after.body.length).toBe(before.body.length + 1);
    expect(after.body[0].note).toBe('coffee via MCP');

    const pending = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_transaction', arguments: { sync_id: createdTx.transaction_id } } });
    expect(JSON.parse(pending.body.result.content[0].text).status).toBe('confirmation_required');
    const deleted = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_transaction', arguments: { sync_id: createdTx.transaction_id, confirm: true } } });
    expect(JSON.parse(deleted.body.result.content[0].text).status).toBe('deleted');
    const final = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    expect(final.body.length).toBe(before.body.length);
  });

  it('imports a real .xlsx workbook with date cells', async () => {
    const serial = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
    const inline = (ref: string, value: string) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
    const number = (ref: string, value: number) => `<c r="${ref}"><v>${value}</v></c>`;
    const date = (ref: string, value: number) => `<c r="${ref}" s="1"><v>${value}</v></c>`;
    const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>
      <row r="1">${inline('A1', '日期')}${inline('B1', '类型')}${inline('C1', '金额')}${inline('D1', '分类')}${inline('E1', '账户')}${inline('F1', '备注')}</row>
      <row r="2">${date('A2', serial(2026, 2, 3))}${inline('B2', '支出')}${number('C2', 15.5)}${inline('D2', '交通')}${inline('E2', '现金')}${inline('F2', '地铁')}</row>
      <row r="3">${date('A3', serial(2026, 2, 4))}${inline('B3', '收入')}${number('C3', 30)}${inline('D3', '工资')}${inline('E3', '现金')}${inline('F3', '奖金')}</row>
    </sheetData></worksheet>`;
    const xlsx = buildZip({
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': sheet,
      'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    });
    const before = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    const form = new FormData();
    form.set('file', new File([xlsx], 'import.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    form.set('target_ledger_id', 'main');
    form.set('tz_offset_minutes', '480');
    const up = await SELF.fetch(`${BASE}/import/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    expect(up.status).toBe(200);
    const job = (await up.json()) as any;
    expect(job.headers).toEqual(['日期', '类型', '金额', '分类', '账户', '备注']);
    const preview = await call(`/import/${job.import_token}/preview`, { method: 'POST', body: JSON.stringify({ target_ledger_id: 'main' }) }, token);
    expect(preview.status).toBe(200);
    expect(preview.body.stats.total_rows).toBe(2);
    const execute = await SELF.fetch(`${BASE}/import/${job.import_token}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(execute.status).toBe(200);
    const text = await execute.text();
    expect(text).toContain('"created_tx_count":2');
    const after = await call('/read/ledgers/main/transactions?limit=100', {}, token);
    expect(after.body.length).toBe(before.body.length + 2);
    const imported = after.body.find((t: any) => t.note === '地铁');
    expect(imported.happened_at.slice(0, 10)).toBe('2026-02-03');
  });

  it('applies the mapping confirmed in preview and skips duplicates', async () => {
    const csv = 'col1,col2,col3,col4\n2026-03-01,支出,9.9,零食\n';
    const upload = async () => {
      const form = new FormData();
      form.set('file', new File([csv], 'custom.csv', { type: 'text/csv' }));
      form.set('target_ledger_id', 'main');
      form.set('tz_offset_minutes', '480');
      const res = await SELF.fetch(`${BASE}/import/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    };

    const job = await upload();
    const preview = await call(`/import/${job.import_token}/preview`, {
      method: 'POST',
      body: JSON.stringify({ mapping: { tx_type: 'col2', amount: 'col3', happened_at: 'col1', category_name: 'col4' }, target_ledger_id: 'main' }),
    }, token);
    expect(preview.status).toBe(200);
    expect(preview.body.stats.total_rows).toBe(1);

    const execute = await SELF.fetch(`${BASE}/import/${job.import_token}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(execute.status).toBe(200);
    const text = await execute.text();
    expect(text).toContain('"created_tx_count":1');
    const txs = await call('/read/ledgers/main/transactions?limit=200', {}, token);
    expect(txs.body.some((t: any) => t.category_name === '零食' && Math.abs(t.amount - 9.9) < 0.001)).toBe(true);

    const again = await upload();
    const preview2 = await call(`/import/${again.import_token}/preview`, {
      method: 'POST',
      body: JSON.stringify({ mapping: { tx_type: 'col2', amount: 'col3', happened_at: 'col1', category_name: 'col4' }, target_ledger_id: 'main' }),
    }, token);
    expect(preview2.status).toBe(200);
    const execute2 = await SELF.fetch(`${BASE}/import/${again.import_token}/execute`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const text2 = await execute2.text();
    expect(text2).toContain('"created_tx_count":0');
    expect(text2).toContain('"skipped_count":1');
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


/** Build a stored (uncompressed) ZIP archive; the XLSX reader accepts it. */
function buildZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, locals.length, true);
  ev.setUint16(10, locals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
