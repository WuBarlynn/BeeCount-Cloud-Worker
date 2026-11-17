import type { Env } from '../env';
import { all, one } from './db';
import { nowIso } from './util';

export type ChangeScope = 'user' | 'ledger';

export async function appendChange(
  env: Env,
  opts: {
    userId: string;
    ledgerId: string | null;
    scope: ChangeScope;
    entityType: string;
    entitySyncId: string;
    action: 'upsert' | 'delete';
    payload: unknown;
    updatedAt?: string;
    deviceId?: string | null;
    updatedByUserId: string;
  },
): Promise<number> {
  const row = await one<{ change_id: number }>(
    env.DB,
    `INSERT INTO sync_changes
      (user_id, ledger_id, scope, entity_type, entity_sync_id, action, payload_json, updated_at,
       updated_by_device_id, updated_by_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     RETURNING change_id`,
    opts.userId,
    opts.ledgerId,
    opts.scope,
    opts.entityType,
    opts.entitySyncId,
    opts.action,
    JSON.stringify(opts.payload ?? {}),
    opts.updatedAt || nowIso(),
    opts.deviceId ?? null,
    opts.updatedByUserId,
    nowIso(),
  );
  return Number(row?.change_id || 0);
}

export async function broadcastToUser(env: Env, userId: string, payload: unknown): Promise<number> {
  if (!env.SYNC_HUB) return 0;
  try {
    const stub = env.SYNC_HUB.get(env.SYNC_HUB.idFromName(`u:${userId}`));
    const res = await stub.fetch('https://sync-hub/broadcast', { method: 'POST', body: JSON.stringify(payload) });
    const data = (await res.json()) as { delivered?: number };
    return Number(data.delivered || 0);
  } catch {
    return 0;
  }
}

export async function broadcastToLedger(
  env: Env,
  ledgerInternalId: string,
  payload: unknown,
): Promise<void> {
  if (!env.SYNC_HUB) return;
  const members = await all<{ user_id: string }>(env.DB, `SELECT user_id FROM ledger_members WHERE ledger_id = ?`, ledgerInternalId);
  await Promise.all(members.map((m) => broadcastToUser(env, m.user_id, payload)));
}

export async function onlineUserCount(env: Env, userId: string): Promise<number> {
  if (!env.SYNC_HUB) return 0;
  try {
    const stub = env.SYNC_HUB.get(env.SYNC_HUB.idFromName(`u:${userId}`));
    const res = await stub.fetch('https://sync-hub/online');
    const data = (await res.json()) as { online?: number };
    return Number(data.online || 0);
  } catch {
    return 0;
  }
}
