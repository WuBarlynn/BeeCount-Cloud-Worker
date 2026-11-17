import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, createUser, requireAdmin } from '../lib/auth';
import { all, one, run } from '../lib/db';
import { onlineUserCount } from '../lib/changes';
import { buildSnapshot } from '../lib/snapshot';
import { HttpError, json, nowIso, normalizeEmail, parseJson, sha256Hex, toInt, uuid } from '../lib/util';

export const adminRoutes = new Hono<AppContext>();
adminRoutes.use('*', authMiddleware(), requireAdmin());

async function readBody(c: any): Promise<Record<string, any>> {
  const text = await c.req.raw.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
}

const userOut = (r: any) => ({
  id: r.id,
  email: r.email,
  is_admin: !!r.is_admin,
  is_enabled: !!r.is_enabled,
  created_at: r.created_at,
  display_name: r.display_name ?? null,
  avatar_url: r.avatar_file_id ? `/api/v1/profile/avatar/${r.id}?v=${r.avatar_version || 0}` : null,
  avatar_version: Number(r.avatar_version || 0),
});

/* ----------------------------------- users ---------------------------------- */
adminRoutes.get('/users', async (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const status = c.req.query('status') || 'all';
  const limit = Math.min(200, Math.max(1, toInt(c.req.query('limit'), 50)));
  const offset = Math.max(0, toInt(c.req.query('offset'), 0));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push(`LOWER(u.email) LIKE ?`);
    binds.push(`%${q}%`);
  }
  if (status === 'enabled') where.push(`u.is_enabled = 1`);
  if (status === 'disabled') where.push(`u.is_enabled = 0`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM users u ${clause}`, ...binds);
  const rows = await all<any>(
    c.env.DB,
    `SELECT u.*, p.display_name, p.avatar_file_id, p.avatar_version FROM users u
     LEFT JOIN user_profiles p ON p.user_id = u.id ${clause}
     ORDER BY u.created_at ASC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    offset,
  );
  return json({ total: Number(total?.n || 0), items: rows.map(userOut) });
});

adminRoutes.post('/users', async (c) => {
  const body = await readBody(c);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!email.includes('@') || password.length < 6) throw new HttpError(422, 'Valid email and a 6+ character password are required');
  if (await one(c.env.DB, `SELECT id FROM users WHERE email = ?`, email)) throw new HttpError(409, 'Email already exists');
  const user = await createUser(c.env, email, password, !!body.is_admin);
  if (body.is_enabled === false) await run(c.env.DB, `UPDATE users SET is_enabled = 0 WHERE id = ?`, user.id);
  const row = await one<any>(
    c.env.DB,
    `SELECT u.*, p.display_name, p.avatar_file_id, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?`,
    user.id,
  );
  return json(userOut(row), 201);
});

adminRoutes.patch('/users/:id', async (c) => {
  const id = c.req.param('id')!;
  const body = await readBody(c);
  const row = await one<any>(c.env.DB, `SELECT * FROM users WHERE id = ?`, id);
  if (!row) throw new HttpError(404, 'User not found');
  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (!email.includes('@')) throw new HttpError(422, 'Invalid email');
    if (await one(c.env.DB, `SELECT id FROM users WHERE email = ? AND id != ?`, email, id)) throw new HttpError(409, 'Email already exists');
    await run(c.env.DB, `UPDATE users SET email = ?, updated_at = ? WHERE id = ?`, email, nowIso(), id);
  }
  if (body.is_enabled !== undefined) await run(c.env.DB, `UPDATE users SET is_enabled = ?, updated_at = ? WHERE id = ?`, body.is_enabled ? 1 : 0, nowIso(), id);
  if (body.is_admin !== undefined) await run(c.env.DB, `UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?`, body.is_admin ? 1 : 0, nowIso(), id);
  const out = await one<any>(
    c.env.DB,
    `SELECT u.*, p.display_name, p.avatar_file_id, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?`,
    id,
  );
  return json(userOut(out));
});

adminRoutes.delete('/users/:id', async (c) => {
  const id = c.req.param('id')!;
  if (id === c.get('auth').user.id) throw new HttpError(400, 'Cannot delete the signed-in admin');
  const row = await one<any>(c.env.DB, `SELECT * FROM users WHERE id = ?`, id);
  if (!row) throw new HttpError(404, 'User not found');
  // Soft-disable instead of a cascading hard delete: D1 has no foreign keys and
  // the user's ledger history must survive for shared-ledger members.
  await run(c.env.DB, `UPDATE users SET is_enabled = 0, updated_at = ? WHERE id = ?`, nowIso(), id);
  await run(c.env.DB, `UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ?`, nowIso(), id);
  const out = await one<any>(
    c.env.DB,
    `SELECT u.*, p.display_name, p.avatar_file_id, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?`,
    id,
  );
  return json(userOut(out));
});

adminRoutes.post('/users/:id/password', async (c) => {
  const id = c.req.param('id')!;
  const body = await readBody(c);
  const admin = await one<any>(c.env.DB, `SELECT * FROM users WHERE id = ?`, c.get('auth').user.id);
  const { verifyPassword, hashPassword } = await import('../lib/crypto');
  if (!(await verifyPassword(String(body.admin_password || ''), admin?.password_hash || ''))) throw new HttpError(401, 'Admin password is incorrect');
  const next = String(body.new_password || '');
  if (next.length < 6) throw new HttpError(422, 'Password must be at least 6 characters');
  const res = await run(c.env.DB, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, await hashPassword(next), nowIso(), id);
  if ((res.meta?.changes ?? 0) === 0) throw new HttpError(404, 'User not found');
  const out = await one<any>(
    c.env.DB,
    `SELECT u.*, p.display_name, p.avatar_file_id, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id=?`,
    id,
  );
  return json(userOut(out));
});

/* ---------------------------------- devices --------------------------------- */
async function deviceRows(c: any) {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const userId = c.req.query('user_id');
  const onlineOnly = c.req.query('online_only') === 'true';
  const days = toInt(c.req.query('active_within_days'), 30);
  const limit = Math.min(500, Math.max(1, toInt(c.req.query('limit'), 100)));
  const offset = Math.max(0, toInt(c.req.query('offset'), 0));
  const where: string[] = [`d.revoked_at IS NULL`];
  const binds: unknown[] = [];
  if (userId) {
    where.push(`d.user_id = ?`);
    binds.push(userId);
  }
  if (q) {
    where.push(`(LOWER(d.name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(COALESCE(d.device_model,'')) LIKE ?)`);
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (days > 0) {
    where.push(`d.last_seen_at >= ?`);
    binds.push(new Date(Date.now() - days * 86400_000).toISOString());
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM devices d JOIN users u ON u.id = d.user_id ${clause}`,
    ...binds,
  );
  const rows = await all<any>(
    c.env.DB,
    `SELECT d.*, u.email AS user_email FROM devices d JOIN users u ON u.id = d.user_id ${clause}
     ORDER BY d.last_seen_at DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    offset,
  );
  const items = [] as any[];
  for (const r of rows) {
    const online = (await onlineUserCount(c.env, r.user_id)) > 0;
    if (onlineOnly && !online) continue;
    items.push({
      id: r.id,
      name: r.name,
      platform: r.platform,
      app_version: r.app_version ?? null,
      os_version: r.os_version ?? null,
      device_model: r.device_model ?? null,
      last_ip: r.last_ip ?? null,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      is_online: online,
      user_id: r.user_id,
      user_email: r.user_email,
    });
  }
  return { total: Number(totalRow?.n || 0), items };
}

adminRoutes.get('/devices', async (c) => json(await deviceRows(c)));

adminRoutes.get('/devices/online', async (c) => {
  const users = await all<any>(c.env.DB, `SELECT id, email FROM users WHERE is_enabled = 1`);
  const items: any[] = [];
  for (const u of users) {
    const n = await onlineUserCount(c.env, u.id);
    if (n > 0) items.push({ user_id: u.id, email: u.email, connections: n });
  }
  return json({ count: items.length, items });
});

/* ------------------------------- overview/health ----------------------------- */
adminRoutes.get('/overview', async (c) => {
  const [usersTotal, usersEnabled, ledgers, tx, accounts, categories, tags] = await Promise.all([
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM users`),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM users WHERE is_enabled = 1`),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM ledgers WHERE deleted_at IS NULL`),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM read_tx`),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM user_accounts`),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM user_categories`),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM user_tags`),
  ]);
  return json({
    users_total: Number(usersTotal?.n || 0),
    users_enabled_total: Number(usersEnabled?.n || 0),
    ledgers_total: Number(ledgers?.n || 0),
    transactions_total: Number(tx?.n || 0),
    accounts_total: Number(accounts?.n || 0),
    categories_total: Number(categories?.n || 0),
    tags_total: Number(tags?.n || 0),
  });
});

adminRoutes.get('/health', async (c) => {
  let db = 'ok';
  try {
    await one(c.env.DB, `SELECT 1 AS ok`);
  } catch {
    db = 'error';
  }
  return json({ status: db === 'ok' ? 'ok' : 'degraded', db, online_ws_users: await onlineUserCount(c.env, c.get('auth').user.id), time: nowIso(), version: c.env.APP_VERSION || null });
});

adminRoutes.get('/logs', async () => json({ items: [], capacity: 0, latest_seq: 0 }));

adminRoutes.get('/sync/errors', async (c) => {
  const rows = await all<any>(
    c.env.DB,
    `SELECT id, action, metadata_json AS metadata, created_at AS createdAt FROM audit_logs WHERE action = 'sync_conflict' ORDER BY id DESC LIMIT 200`,
  );
  return json({ count: rows.length, items: rows.map((r) => ({ id: r.id, action: r.action, metadata: parseJson(r.metadata, null), createdAt: r.createdAt })) });
});

adminRoutes.get('/debug/snapshot/:ledger', async (c) => {
  const ledger = await one<any>(c.env.DB, `SELECT * FROM ledgers WHERE external_id = ?`, c.req.param('ledger'));
  if (!ledger) throw new HttpError(404, 'Ledger not found');
  return json(await buildSnapshot(c.env, ledger));
});

/* -------------------------------- data cleanup ------------------------------- */
adminRoutes.get('/data-cleanup/scan', async (c) => {
  const dbOrphans: any[] = [];
  const txMissing = await all<any>(
    c.env.DB,
    `SELECT t.ledger_id, t.sync_id, t.category_sync_id FROM read_tx t
     WHERE t.category_sync_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM user_categories c WHERE c.sync_id = t.category_sync_id
     ) LIMIT 200`,
  );
  for (const t of txMissing) dbOrphans.push({ type: 'tx_missing_category', title: '交易引用不存在的分类', subtitle: t.sync_id, row_id: t.sync_id, sync_id: t.category_sync_id, extra: { ledger_id: t.ledger_id } });
  const budgetMissing = await all<any>(
    c.env.DB,
    `SELECT b.ledger_id, b.sync_id, b.category_sync_id FROM read_budgets b
     WHERE b.category_sync_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM user_categories c WHERE c.sync_id = b.category_sync_id
     ) LIMIT 200`,
  );
  for (const b of budgetMissing) dbOrphans.push({ type: 'budget_missing_category', title: '预算引用不存在的分类', subtitle: b.sync_id, row_id: b.sync_id, sync_id: b.category_sync_id, extra: { ledger_id: b.ledger_id } });
  const attachmentNoRef = await all<any>(
    c.env.DB,
    `SELECT id, file_name, size FROM attachments a
     WHERE a.kind = 'transaction' AND NOT EXISTS (
       SELECT 1 FROM read_tx t WHERE t.attachments_json LIKE '%' || a.id || '%'
     ) LIMIT 200`,
  );
  for (const a of attachmentNoRef) dbOrphans.push({ type: 'attachment_no_ref', title: '附件没有被任何交易引用', subtitle: a.file_name, row_id: a.id, size_bytes: a.size, extra: null });
  return json({
    db_orphans: dbOrphans,
    file_orphans: [],
    sync_orphans: [],
    total_count: dbOrphans.length,
    total_size_bytes: dbOrphans.reduce((sum, r) => sum + Number(r.size_bytes || 0), 0),
  });
});

adminRoutes.post('/data-cleanup/clean', async (c) => {
  const body = await readBody(c);
  const keys: string[] = Array.isArray(body.keys) ? body.keys.map(String) : [];
  let success = 0;
  const failures: any[] = [];
  for (const key of keys) {
    const [type, id] = key.split(':', 2);
    try {
      if (type === 'tx_missing_category') await run(c.env.DB, `UPDATE read_tx SET category_sync_id = NULL, category_name = NULL WHERE sync_id = ?`, id);
      else if (type === 'budget_missing_category') await run(c.env.DB, `DELETE FROM read_budgets WHERE sync_id = ?`, id);
      else if (type === 'attachment_no_ref') {
        const row = await one<any>(c.env.DB, `SELECT * FROM attachments WHERE id = ?`, id);
        if (row && c.env.BUCKET) await c.env.BUCKET.delete(row.r2_key);
        await run(c.env.DB, `DELETE FROM attachments WHERE id = ?`, id);
      } else {
        failures.push({ record_key: key, error: 'unsupported record type' });
        continue;
      }
      success++;
    } catch (e) {
      failures.push({ record_key: key, error: String((e as Error)?.message || e) });
    }
  }
  return json({ success_count: success, failures });
});

/* ---------------------------------- backups --------------------------------- */
type BackupEntry = {
  id: string;
  ledger_id: string;
  kind: 'db' | 'snapshot';
  file_name: string;
  content_type: string;
  checksum: string;
  size: number;
  created_at: string;
  created_by: string;
  note: string | null;
  metadata: Record<string, unknown>;
};

adminRoutes.get('/backups/artifacts', async (c) => {
  if (!c.env.BUCKET) return json({ items: [] });
  const list = await c.env.BUCKET.list({ prefix: 'backups/', limit: 200, include: ['customMetadata', 'httpMetadata'] as any });
  const items: BackupEntry[] = [];
  for (const obj of list.objects) {
    const meta = (obj.customMetadata || {}) as Record<string, string>;
    items.push({
      id: meta.id || obj.key,
      ledger_id: meta.ledger_id || '',
      kind: (meta.kind as any) || 'snapshot',
      file_name: obj.key.split('/').pop() || obj.key,
      content_type: 'application/json',
      checksum: meta.checksum || '',
      size: obj.size,
      created_at: meta.created_at || obj.uploaded.toISOString(),
      created_by: meta.created_by || '',
      note: meta.note || null,
      metadata: {},
    });
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return json({ items });
});

adminRoutes.post('/backups/create', async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, 'R2 is not configured');
  const body = await readBody(c);
  const externalId = String(body.ledger_id || '');
  const ledger = await one<any>(c.env.DB, `SELECT * FROM ledgers WHERE external_id = ?`, externalId);
  if (!ledger) throw new HttpError(404, 'Ledger not found');
  const snapshot = await buildSnapshot(c.env, ledger);
  const content = JSON.stringify(snapshot);
  const id = `bkp_${crypto.randomUUID().replace(/-/g, '')}`;
  const checksum = await sha256Hex(content);
  const createdAt = nowIso();
  await c.env.BUCKET.put(`backups/${externalId}/${id}.json`, content, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { id, ledger_id: externalId, kind: 'snapshot', checksum, created_at: createdAt, created_by: c.get('auth').user.email, note: String(body.note || '') },
  });
  return json({ snapshot_id: id, ledger_id: externalId, created_at: createdAt });
});

adminRoutes.post('/backups/restore', async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, 'R2 is not configured');
  const body = await readBody(c);
  const id = String(body.snapshot_id || '');
  if (!id) throw new HttpError(422, 'snapshot_id is required');
  const list = await c.env.BUCKET.list({ prefix: 'backups/', limit: 1000 });
  const target = list.objects.find((o) => o.key.endsWith(`/${id}.json`) || o.key === id);
  if (!target) throw new HttpError(404, 'Backup not found');
  const obj = await c.env.BUCKET.get(target.key);
  if (!obj) throw new HttpError(404, 'Backup not found');
  const snapshot = JSON.parse(await obj.text());
  const externalId = String(snapshot.ledgerSyncId || '');
  const ledger = await one<any>(c.env.DB, `SELECT * FROM ledgers WHERE external_id = ?`, externalId);
  if (!ledger) throw new HttpError(404, 'Ledger not found');
  const items: any[] = Array.isArray(snapshot.items) ? snapshot.items : [];
  await run(c.env.DB, `DELETE FROM read_tx WHERE ledger_id = ?`, ledger.id);
  let index = 0;
  let changeId = 0;
  for (const item of items) {
    const sid = String(item.syncId || `tx_${crypto.randomUUID().replace(/-/g, '')}`);
    const { appendChange } = await import('../lib/changes');
    const { applyLedgerChange } = await import('../lib/projection');
    const payload = { ...item, syncId: sid, txIndex: item.txIndex ?? ++index };
    changeId = await appendChange(c.env, {
      userId: ledger.user_id,
      ledgerId: ledger.id,
      scope: 'ledger',
      entityType: 'transaction',
      entitySyncId: sid,
      action: 'upsert',
      payload,
      deviceId: 'admin-restore',
      updatedByUserId: c.get('auth').user.id,
    });
    await applyLedgerChange(c.env, ledger, {
      changeId,
      entityType: 'transaction',
      entitySyncId: sid,
      action: 'upsert',
      payload,
      updatedAt: nowIso(),
      actorUserId: c.get('auth').user.id,
    });
  }
  return json({ restored: true, ledger_id: externalId, change_id: changeId });
});

// Legacy adapter endpoints used by the current admin panel; rclone is not
// available in Workers, so configuration surfaces stay read-only/empty.
adminRoutes.get('/backup/rclone-config', async () => json({ configured: false, remotes: [] }));
adminRoutes.get('/backup/remotes', async () => json([]));
adminRoutes.post('/backup/remotes', async () => {
  throw new HttpError(501, 'rclone remotes are not available in the Workers build; use R2 artifacts instead.');
});
adminRoutes.patch('/backup/remotes/:id', async () => {
  throw new HttpError(501, 'rclone remotes are not available in the Workers build');
});
adminRoutes.delete('/backup/remotes/:id', async () => json({ ok: true }));
adminRoutes.get('/backup/remotes/:id/reveal', async () => json({ password: null }));
adminRoutes.post('/backup/remotes/:id/test', async () => json({ success: false, message: 'rclone is not available in the Workers build' }));
adminRoutes.get('/backup/schedules', async () => json([]));
adminRoutes.post('/backup/schedules', async () => {
  throw new HttpError(501, 'Scheduled rclone backups are not available; the daily Cron exports to R2 instead.');
});
adminRoutes.patch('/backup/schedules/:id', async () => json({ ok: true }));
adminRoutes.delete('/backup/schedules/:id', async () => json({ ok: true }));
adminRoutes.post('/backup/schedules/:id/run-now', async () => json({ ok: false, message: 'not available' }));
adminRoutes.get('/backup/runs', async () => json({ items: [], total: 0 }));
adminRoutes.get('/backup/runs/:id', async (c) => json({ id: c.req.param('id'), status: 'unavailable' }));
adminRoutes.get('/backup/restores', async () => json({ items: [], total: 0 }));
adminRoutes.get('/backup/restores/:id', async () => json({ id: null, status: 'unavailable' }));
adminRoutes.delete('/backup/restores/:id', async () => json({ ok: true }));
adminRoutes.post('/backup/runs/:id/prepare-restore', async () => {
  throw new HttpError(501, 'Use /admin/backups/restore with an R2 artifact id.');
});
adminRoutes.post('/backups/upload-db', async () => {
  throw new HttpError(501, 'Use /admin/backups/create (JSON snapshot into R2) instead of uploading a SQLite file.');
});
adminRoutes.post('/backups/upload-snapshot', async () => {
  throw new HttpError(501, 'Upload snapshots through the app import flow; direct snapshot upload is not enabled in this build.');
});

/* ------------------------------------ rag ----------------------------------- */
const ragStatus = () => ({
  source: 'builtin',
  corpus_hash: null,
  embedding_model: null,
  languages: {},
  last_checked_at: null,
  last_updated_at: null,
  last_error: 'RAG 索引未随 Workers 版部署，AI 问答直接使用模型知识。',
  remote_corpus_hash: null,
  is_latest: null,
});
adminRoutes.get('/rag/status', async () => json(ragStatus()));
adminRoutes.post('/rag/refresh', async () => json({ ...ragStatus(), last_error: 'Workers 版本不支持刷新 RAG 索引。' }));
