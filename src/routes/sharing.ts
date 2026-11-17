import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one, run } from '../lib/db';
import { broadcastToLedger } from '../lib/changes';
import { HttpError, json, nowIso, toInt } from '../lib/util';
import { requireLedger } from '../lib/ledger';

export const sharingRoutes = new Hono<AppContext>();

sharingRoutes.use('*', authMiddleware());
const readScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE);
const writeScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE);
sharingRoutes.use('*', readScope);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MEMBER_LIMIT = 5;
const MAX_ACTIVE_INVITES = 10;

async function readBody(c: any): Promise<Record<string, any>> {
  const text = await c.req.raw.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, 'Invalid JSON body');
  }
}

const genCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.getRandomValues(new Uint8Array(1))[0] % CODE_ALPHABET.length]).join('');
const formatCode = (code: string) => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
const shareUrl = (code: string, origin: string) => `${origin}/join/${code}`;

async function memberOut(env: AppContext['Bindings'], row: any, callerId: string) {
  const user = await one<any>(env.DB, `SELECT u.id, u.email, p.display_name, p.avatar_file_id, p.avatar_version FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id = ?`, row.user_id);
  const version = Number(user?.avatar_version || 0);
  return {
    user_id: row.user_id,
    email: user?.email || '',
    display_name: user?.display_name ?? null,
    role: row.role,
    joined_at: row.joined_at,
    invited_by_user_id: null,
    is_self: row.user_id === callerId,
    avatar_url: user?.avatar_file_id ? `/api/v1/profile/avatar/${row.user_id}?v=${version}` : null,
    avatar_version: version,
  };
}

/* ---------------------------------- invites --------------------------------- */
sharingRoutes.post('/ledgers/:id/invites', writeScope, async (c) => {
  const auth = c.get('auth');
  const externalId = c.req.param('id')!;
  const ledger = await requireLedger(c.env, auth.user.id, externalId, ['owner']);
  const body = await readBody(c);
  const hours = Math.max(1, Math.min(168, toInt(body.expires_in_hours, 24)));
  const now = nowIso();
  const active = await one<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM ledger_invites WHERE ledger_id = ? AND expires_at > ? AND used_count < max_uses`,
    ledger.id,
    now,
  );
  if (Number(active?.n || 0) >= MAX_ACTIVE_INVITES) throw new HttpError(409, 'Too many active invites for this ledger');
  let code = genCode();
  for (let i = 0; i < 4 && (await one(c.env.DB, `SELECT 1 AS x FROM ledger_invites WHERE code = ?`, code)); i++) code = genCode();
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  await run(
    c.env.DB,
    `INSERT INTO ledger_invites (code, ledger_id, created_by, role, expires_at, max_uses, used_count, created_at)
     VALUES (?,?,?,?,?,1,0,?)`,
    code,
    ledger.id,
    auth.user.id,
    'editor',
    expiresAt,
    now,
  );
  const origin = new URL(c.req.url).origin;
  return json(
    {
      code,
      formatted_code: formatCode(code),
      target_role: 'editor',
      expires_at: expiresAt,
      share_url: shareUrl(code, origin),
      created_at: now,
    },
    201,
  );
});

sharingRoutes.get('/ledgers/:id/invites', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!, ['owner']);
  const rows = await all<any>(
    c.env.DB,
    `SELECT * FROM ledger_invites WHERE ledger_id = ? AND expires_at > ? AND used_count < max_uses ORDER BY created_at DESC`,
    ledger.id,
    nowIso(),
  );
  const origin = new URL(c.req.url).origin;
  return json(
    rows.map((r) => ({
      code: r.code,
      formatted_code: formatCode(r.code),
      target_role: r.role,
      expires_at: r.expires_at,
      created_at: r.created_at,
      invited_by_user_id: r.created_by,
      share_url: shareUrl(r.code, origin),
    })),
  );
});

sharingRoutes.delete('/ledgers/:id/invites/:code', writeScope, async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!, ['owner']);
  const res = await run(c.env.DB, `DELETE FROM ledger_invites WHERE code = ? AND ledger_id = ?`, c.req.param('code')!.toUpperCase(), ledger.id);
  if ((res.meta?.changes ?? 0) === 0) throw new HttpError(404, 'Invite not found');
  return json({ ok: true });
});

async function loadInvite(c: any, codeRaw: string) {
  const code = String(codeRaw || '').replace(/[\s-]/g, '').toUpperCase();
  const invite = await one<any>(c.env.DB, `SELECT * FROM ledger_invites WHERE code = ?`, code);
  if (!invite) throw new HttpError(404, 'Invite not found');
  if (new Date(invite.expires_at).getTime() < Date.now()) throw new HttpError(404, 'Invite expired');
  if (Number(invite.used_count) >= Number(invite.max_uses)) throw new HttpError(404, 'Invite already used');
  const ledger = await one<any>(c.env.DB, `SELECT * FROM ledgers WHERE id = ?`, invite.ledger_id);
  if (!ledger || ledger.deleted_at) throw new HttpError(404, 'Ledger not found');
  return { code, invite, ledger };
}

sharingRoutes.post('/invites/:code/preview', async (c) => {
  const { code, invite, ledger } = await loadInvite(c, c.req.param('code')!);
  const inviter = await one<any>(
    c.env.DB,
    `SELECT u.email, p.display_name FROM users u LEFT JOIN user_profiles p ON p.user_id=u.id WHERE u.id = ?`,
    invite.created_by,
  );
  return json({
    code,
    ledger_external_id: ledger.external_id,
    ledger_name: ledger.name ?? null,
    ledger_currency: ledger.currency || 'CNY',
    invited_by_display: inviter?.display_name || inviter?.email || '',
    target_role: invite.role,
    expires_at: invite.expires_at,
  });
});

sharingRoutes.post('/invites/:code/accept', writeScope, async (c) => {
  const auth = c.get('auth');
  const { invite, ledger } = await loadInvite(c, c.req.param('code')!);
  const existing = await one<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? AND user_id = ?`, ledger.id, auth.user.id);
  if (!existing) {
    const count = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM ledger_members WHERE ledger_id = ?`, ledger.id);
    if (Number(count?.n || 0) >= MEMBER_LIMIT) throw new HttpError(409, 'Ledger member limit reached');
    await run(
      c.env.DB,
      `INSERT INTO ledger_members (ledger_id, user_id, role, joined_at) VALUES (?,?,?,?)`,
      ledger.id,
      auth.user.id,
      invite.role || 'editor',
      nowIso(),
    );
  }
  const res = await run(
    c.env.DB,
    `UPDATE ledger_invites SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses`,
    invite.code,
  );
  if ((res.meta?.changes ?? 0) === 0) throw new HttpError(409, 'Invite already used');
  const count = await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM ledger_members WHERE ledger_id = ?`, ledger.id);
  await broadcastToLedger(c.env, ledger.id, { type: 'member_change', ledgerId: ledger.external_id, changeType: 'joined', userId: auth.user.id, newRole: invite.role || 'editor' });
  return json({
    ledger_external_id: ledger.external_id,
    ledger_name: ledger.name ?? null,
    ledger_currency: ledger.currency || 'CNY',
    role: existing?.role || invite.role || 'editor',
    member_count: Number(count?.n || 0),
  });
});

/* ---------------------------------- members --------------------------------- */
sharingRoutes.get('/ledgers/:id/members', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!);
  const rows = await all<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? ORDER BY joined_at ASC`, ledger.id);
  return json(await Promise.all(rows.map((r) => memberOut(c.env, r, auth.user.id))));
});

sharingRoutes.patch('/ledgers/:id/members/:userId', writeScope, async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!, ['owner']);
  const userId = c.req.param('userId')!;
  const row = await one<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? AND user_id = ?`, ledger.id, userId);
  if (!row) throw new HttpError(404, 'Member not found');
  if (row.role === 'owner') throw new HttpError(400, 'Cannot change owner role; transfer ownership first');
  const body = await readBody(c);
  const role = body.role === 'viewer' ? 'viewer' : 'editor';
  await run(c.env.DB, `UPDATE ledger_members SET role = ? WHERE ledger_id = ? AND user_id = ?`, role, ledger.id, userId);
  await broadcastToLedger(c.env, ledger.id, { type: 'member_change', ledgerId: ledger.external_id, changeType: 'role_changed', userId, newRole: role });
  return json(await memberOut(c.env, { ...row, role }, auth.user.id));
});

sharingRoutes.delete('/ledgers/:id/members/:userId', writeScope, async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!, ['owner']);
  const userId = c.req.param('userId')!;
  const row = await one<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? AND user_id = ?`, ledger.id, userId);
  if (!row) throw new HttpError(404, 'Member not found');
  if (row.role === 'owner') throw new HttpError(400, 'Cannot remove owner; transfer ownership first');
  await run(c.env.DB, `DELETE FROM ledger_members WHERE ledger_id = ? AND user_id = ?`, ledger.id, userId);
  await broadcastToLedger(c.env, ledger.id, { type: 'member_change', ledgerId: ledger.external_id, changeType: 'removed', userId });
  return json({ ok: true });
});

sharingRoutes.post('/ledgers/:id/transfer', writeScope, async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!, ['owner']);
  const body = await readBody(c);
  const target = String(body.new_owner_user_id || '');
  const row = await one<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? AND user_id = ?`, ledger.id, target);
  if (!row) throw new HttpError(404, 'Member not found');
  if (target === auth.user.id) throw new HttpError(400, 'Already the owner');
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE ledger_members SET role = 'editor' WHERE ledger_id = ? AND user_id = ?`).bind(ledger.id, auth.user.id),
    c.env.DB.prepare(`UPDATE ledger_members SET role = 'owner' WHERE ledger_id = ? AND user_id = ?`).bind(ledger.id, target),
    c.env.DB.prepare(`UPDATE ledgers SET user_id = ?, updated_at = ? WHERE id = ?`).bind(target, nowIso(), ledger.id),
  ]);
  for (const [uid, role] of [[target, 'owner'], [auth.user.id, 'editor']] as const) {
    await broadcastToLedger(c.env, ledger.id, { type: 'member_change', ledgerId: ledger.external_id, changeType: 'role_changed', userId: uid, newRole: role });
  }
  const rows = await all<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? ORDER BY joined_at ASC`, ledger.id);
  return json(await Promise.all(rows.map((r) => memberOut(c.env, r, auth.user.id))));
});

/* -------------------------------- member stats ------------------------------ */
function msdClamp(v: unknown): number {
  return Math.max(1, Math.min(28, toInt(v, 1) || 1));
}

function analyticsRange(scope: string, period: string | null, tzOffset: number, msd: number) {
  const day = msdClamp(msd);
  if (scope === 'all') return { start: null as string | null, end: null as string | null, period: null as string | null };
  const localNow = new Date(Date.now() + tzOffset * 60000);
  if (scope === 'month') {
    let target = period;
    if (!target) {
      let y = localNow.getUTCFullYear();
      let m = localNow.getUTCMonth() + 1;
      if (localNow.getUTCDate() < day) {
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
      target = `${y}-${String(m).padStart(2, '0')}`;
    }
    const [ys, ms] = target.split('-');
    const y = Number(ys);
    const m = Number(ms);
    if (!y || !m || m < 1 || m > 12) throw new HttpError(400, 'Invalid analytics period');
    const startMs = Date.UTC(y, m - 1, day) - tzOffset * 60000;
    const endMs = (m === 12 ? Date.UTC(y + 1, 0, day) : Date.UTC(y, m, day)) - tzOffset * 60000;
    return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), period: target };
  }
  const y = Number(period || localNow.getUTCFullYear());
  if (!y) throw new HttpError(400, 'Invalid analytics period');
  return {
    start: new Date(Date.UTC(y, 0, day) - tzOffset * 60000).toISOString(),
    end: new Date(Date.UTC(y + 1, 0, day) - tzOffset * 60000).toISOString(),
    period: String(y),
  };
}

sharingRoutes.get('/ledgers/:id/member-stats', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!);
  const scope = c.req.query('scope') || 'month';
  const tz = toInt(c.req.query('tz_offset_minutes'), 0);
  const range = analyticsRange(scope, c.req.query('period') || null, tz, ledger.month_start_day || 1);
  const members = await all<any>(c.env.DB, `SELECT * FROM ledger_members WHERE ledger_id = ? ORDER BY joined_at ASC`, ledger.id);
  const where = [`ledger_id = ?`];
  const binds: unknown[] = [ledger.id];
  if (range.start) {
    where.push(`happened_at >= ?`);
    binds.push(range.start);
  }
  if (range.end) {
    where.push(`happened_at < ?`);
    binds.push(range.end);
  }
  const rows = await all<any>(
    c.env.DB,
    `SELECT created_by_user_id,
       COALESCE(SUM(CASE WHEN tx_type='income' AND exclude_from_stats=0 THEN COALESCE(native_amount,amount) ELSE 0 END),0) AS income_total,
       COALESCE(SUM(CASE WHEN tx_type='expense' AND exclude_from_stats=0 THEN COALESCE(native_amount,amount) ELSE 0 END),0) AS expense_total,
       COUNT(*) AS tx_count
     FROM read_tx WHERE ${where.join(' AND ')} GROUP BY created_by_user_id`,
    ...binds,
  );
  const byUser = new Map(rows.map((r) => [r.created_by_user_id, r]));
  const items = [];
  for (const m of members) {
    const info = await memberOut(c.env, m, auth.user.id);
    const agg = byUser.get(m.user_id) || {};
    items.push({
      user_id: m.user_id,
      email: info.email,
      display_name: info.display_name,
      avatar_url: info.avatar_url,
      avatar_version: info.avatar_version,
      role: m.role,
      income_total: Number(agg.income_total || 0),
      expense_total: Number(agg.expense_total || 0),
      tx_count: Number(agg.tx_count || 0),
    });
  }
  return json({
    ledger_id: ledger.external_id,
    ledger_currency: ledger.currency || 'CNY',
    scope,
    period: range.period,
    start_at: range.start,
    end_at: range.end ? new Date(Date.parse(range.end) - 1000).toISOString() : null,
    items,
  });
});

/* ------------------------------ shared resources ---------------------------- */
sharingRoutes.get('/ledgers/:id/shared-resources', async (c) => {
  const auth = c.get('auth');
  const ledger = await requireLedger(c.env, auth.user.id, c.req.param('id')!);
  const owner = ledger.user_id;
  const cats = await all<any>(c.env.DB, `SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order ASC`, owner);
  const accts = await all<any>(c.env.DB, `SELECT * FROM user_accounts WHERE user_id = ? ORDER BY name`, owner);
  const tags = await all<any>(c.env.DB, `SELECT * FROM user_tags WHERE user_id = ? ORDER BY name`, owner);
  return json({
    owner_user_id: owner,
    categories: cats.map((r) => ({
      sync_id: r.sync_id,
      name: r.name,
      kind: r.kind,
      icon: r.icon,
      icon_type: r.icon_type,
      icon_cloud_file_id: r.icon_cloud_file_id,
      icon_cloud_sha256: r.icon_cloud_sha256,
      sort_order: r.sort_order,
      level: r.level,
      parent_name: r.parent_name,
      parent_sync_id: r.parent_sync_id ?? null,
    })),
    accounts: accts.map((r) => ({
      sync_id: r.sync_id,
      name: r.name,
      account_type: r.account_type,
      currency: r.currency,
      initial_balance: r.initial_balance,
      note: r.note,
      credit_limit: r.credit_limit,
      billing_day: r.billing_day,
      payment_due_day: r.payment_due_day,
      bank_name: r.bank_name,
      card_last_four: r.card_last_four,
    })),
    tags: tags.map((r) => ({ sync_id: r.sync_id, name: r.name, color: r.color })),
  });
});
