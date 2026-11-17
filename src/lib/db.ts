import type { Env } from '../env';
import { nowIso, sha256Hex } from './util';

export type D1 = D1Database;

export async function one<T = any>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...binds).first<T>()) ?? null;
}

export async function all<T = any>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...binds).all<T>();
  return (res.results || []) as T[];
}

export async function run(db: D1Database, sql: string, ...binds: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...binds).run();
}

export async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  if (!statements.length) return [];
  return db.batch(statements);
}

/**
 * Reserve a contiguous block of change ids. `UPDATE … RETURNING` is atomic in
 * D1, so concurrent writers never get the same range even without an
 * interactive transaction. Gaps are harmless.
 */
export async function reserveChangeIds(db: D1Database, count: number): Promise<number> {
  // `change_seq` may lag behind sync_changes written with AUTOINCREMENT, and a
  // restored database starts it at 0. Raise it to MAX(change_id) before taking
  // the next block so the reserved ids can never collide.
  const row = await one<{ int_value: number }>(
    db,
    `UPDATE app_meta
     SET int_value = MAX(int_value, COALESCE((SELECT MAX(change_id) FROM sync_changes), 0)) + ?
     WHERE key = 'change_seq' RETURNING int_value`,
    count,
  );
  if (!row) {
    await run(db, `INSERT OR IGNORE INTO app_meta (key, int_value) VALUES ('change_seq', 0)`);
    const again = await one<{ int_value: number }>(
      db,
      `UPDATE app_meta SET int_value = int_value + ? WHERE key = 'change_seq' RETURNING int_value`,
      count,
    );
    return Math.max(1, (again?.int_value ?? count) - count + 1);
  }
  return Math.max(1, row.int_value - count + 1);
}

export async function latestLedgerChangeId(db: D1Database, ledgerId: string): Promise<number> {
  const row = await one<{ n: number }>(db, `SELECT COALESCE(MAX(change_id),0) AS n FROM sync_changes WHERE ledger_id = ?`, ledgerId);
  return Number(row?.n || 0);
}

export async function maxAccessibleCursor(db: D1Database, userId: string): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    `SELECT COALESCE(MAX(c.change_id),0) AS n FROM sync_changes c
     WHERE (c.scope='user' AND c.user_id=?)
        OR (c.scope='ledger' AND c.ledger_id IN (SELECT ledger_id FROM ledger_members WHERE user_id=?))`,
    userId,
    userId,
  );
  return Number(row?.n || 0);
}

export async function recordAudit(
  db: D1Database,
  userId: string | null,
  ledgerId: string | null,
  action: string,
  metadata: unknown,
): Promise<void> {
  await run(
    db,
    `INSERT INTO audit_logs (user_id, ledger_id, action, metadata_json, created_at) VALUES (?,?,?,?,?)`,
    userId,
    ledgerId,
    action,
    JSON.stringify(metadata ?? {}),
    nowIso(),
  );
}

export function r2AttachmentKey(userId: string, sha: string): string {
  return `u/${userId}/${sha.slice(0, 2)}/${sha}`;
}

export async function ensureUserProfile(env: Env, userId: string): Promise<void> {
  await run(
    env.DB,
    `INSERT OR IGNORE INTO user_profiles (user_id, avatar_version, updated_at) VALUES (?,0,?)`,
    userId,
    nowIso(),
  );
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}
