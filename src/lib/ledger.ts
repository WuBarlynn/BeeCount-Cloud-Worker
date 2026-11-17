import type { Env } from '../env';
import { HttpError } from './util';
import { all, one } from './db';

export type LedgerRow = {
  id: string;
  user_id: string;
  external_id: string;
  name: string;
  currency: string;
  month_start_day: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  role?: string;
};

export async function listAccessibleLedgers(
  env: Env,
  userId: string,
  includeDeleted = false,
): Promise<LedgerRow[]> {
  const deleted = includeDeleted ? '' : 'AND l.deleted_at IS NULL';
  return all<LedgerRow>(
    env.DB,
    `SELECT l.*, m.role AS role
     FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
     WHERE m.user_id = ? ${deleted}
     ORDER BY l.created_at DESC`,
    userId,
  );
}

export async function roleForLedger(env: Env, userId: string, ledgerId: string): Promise<string | null> {
  const row = await one<{ role: string }>(
    env.DB,
    `SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?`,
    ledgerId,
    userId,
  );
  return row?.role ?? null;
}

export async function getLedgerByExternal(
  env: Env,
  userId: string,
  externalId: string,
): Promise<LedgerRow | null> {
  return one<LedgerRow>(
    env.DB,
    `SELECT l.*, m.role AS role
     FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
     WHERE l.external_id = ? AND m.user_id = ? AND l.deleted_at IS NULL
     LIMIT 1`,
    externalId,
    userId,
  );
}

export async function requireLedger(
  env: Env,
  userId: string,
  externalId: string,
  roles: string[] = ['owner', 'editor', 'viewer'],
): Promise<LedgerRow> {
  const row = await getLedgerByExternal(env, userId, externalId);
  if (!row) throw new HttpError(404, 'Ledger not found');
  if (!roles.includes(row.role || 'viewer')) throw new HttpError(403, 'Permission denied');
  return row;
}

export function canWrite(role: string | undefined): boolean {
  return role === 'owner' || role === 'editor';
}

export async function countMembers(env: Env, ledgerId: string): Promise<number> {
  const row = await one<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ledger_members WHERE ledger_id = ?`, ledgerId);
  return Number(row?.n || 0);
}

export async function createLedger(
  env: Env,
  ownerId: string,
  opts: { externalId: string; name: string; currency?: string; monthStartDay?: number; createdAt?: string },
): Promise<LedgerRow> {
  const id = crypto.randomUUID();
  const now = opts.createdAt || new Date().toISOString();
  const monthStart = Math.max(1, Math.min(28, opts.monthStartDay || 1));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ledgers (id,user_id,external_id,name,currency,month_start_day,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(id, ownerId, opts.externalId, opts.name, opts.currency || 'CNY', monthStart, now, now),
    env.DB.prepare(`INSERT INTO ledger_members (ledger_id,user_id,role,joined_at) VALUES (?,?, 'owner', ?)`).bind(
      id,
      ownerId,
      now,
    ),
  ]);
  return (await one<LedgerRow>(env.DB, `SELECT * FROM ledgers WHERE id = ?`, id))!;
}
