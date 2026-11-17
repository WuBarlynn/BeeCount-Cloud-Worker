import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one, r2AttachmentKey } from '../lib/db';
import { HttpError, json, nowIso, sha256Hex, uuid } from '../lib/util';
import { getLedgerByExternal } from '../lib/ledger';

export const attachmentRoutes = new Hono<AppContext>();

attachmentRoutes.use('*', authMiddleware());
const readScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE);
const writeScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE);

const MAX_UPLOAD = 64 * 1024 * 1024;

function uploadOut(row: any, ledgerExternalId: string) {
  return {
    file_id: row.id,
    ledger_id: ledgerExternalId,
    sha256: row.sha256,
    size: row.size,
    mime_type: row.mime_type ?? null,
    file_name: row.file_name,
    created_at: row.created_at,
  };
}

async function ledgerForUpload(c: any, ledgerExternalId: string) {
  const ledger = await getLedgerByExternal(c.env, c.get('auth').user.id, ledgerExternalId);
  if (!ledger) throw new HttpError(404, 'Ledger not found');
  return ledger;
}

attachmentRoutes.post('/upload', writeScope, async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, 'Attachment storage is not configured');
  const form = await c.req.formData();
  const ledgerId = String(form.get('ledger_id') || '');
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'file is required');
  if (!ledgerId) throw new HttpError(422, 'ledger_id is required');
  if (!file.size) throw new HttpError(400, 'Attachment file is empty');
  if (file.size > MAX_UPLOAD) throw new HttpError(413, 'Attachment upload too large');
  const ledger = await ledgerForUpload(c, ledgerId);

  const bytes = await file.arrayBuffer();
  const sha = await sha256Hex(bytes);
  const existing = await one<any>(
    c.env.DB,
    `SELECT * FROM attachments WHERE user_id = ? AND sha256 = ? AND kind = 'transaction' LIMIT 1`,
    c.get('auth').user.id,
    sha,
  );
  if (existing) return json(uploadOut(existing, ledgerId));

  const id = uuid();
  const key = r2AttachmentKey(c.get('auth').user.id, sha);
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
  const safeName = (file.name || 'attachment.bin').split(/[\\/]/).pop()!.slice(0, 255) || 'attachment.bin';
  await one(
    c.env.DB,
    `INSERT INTO attachments (id,user_id,ledger_id,kind,sha256,file_name,original_name,size,mime_type,r2_key,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    id,
    c.get('auth').user.id,
    ledger.id,
    'transaction',
    sha,
    safeName,
    safeName,
    file.size,
    file.type || null,
    key,
    nowIso(),
  );
  const row = await one<any>(c.env.DB, `SELECT * FROM attachments WHERE id = ?`, id);
  return json(uploadOut(row, ledgerId));
});

attachmentRoutes.post('/category-icons/upload', writeScope, async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, 'Attachment storage is not configured');
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError(422, 'file is required');
  if (!file.size) throw new HttpError(400, 'Attachment file is empty');
  if (file.size > MAX_UPLOAD) throw new HttpError(413, 'Attachment upload too large');
  const bytes = await file.arrayBuffer();
  const sha = await sha256Hex(bytes);
  const existing = await one<any>(
    c.env.DB,
    `SELECT * FROM attachments WHERE user_id = ? AND sha256 = ? AND kind = 'category_icon' LIMIT 1`,
    c.get('auth').user.id,
    sha,
  );
  if (existing) return json(uploadOut(existing, ''));
  const id = uuid();
  const key = r2AttachmentKey(c.get('auth').user.id, `icon-${sha}`);
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: file.type || 'image/png' } });
  const safeName = (file.name || 'category_icon.png').split(/[\\/]/).pop()!.slice(0, 255);
  await one(
    c.env.DB,
    `INSERT INTO attachments (id,user_id,ledger_id,kind,sha256,file_name,original_name,size,mime_type,r2_key,created_at)
     VALUES (?,?,NULL,?,?,?,?,?,?,?,?) RETURNING id`,
    id,
    c.get('auth').user.id,
    'category_icon',
    sha,
    safeName,
    safeName,
    file.size,
    file.type || null,
    key,
    nowIso(),
  );
  const row = await one<any>(c.env.DB, `SELECT * FROM attachments WHERE id = ?`, id);
  return json(uploadOut(row, ''));
});

attachmentRoutes.post('/batch-exists', writeScope, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const ledgerId = String(body.ledger_id || '');
  if (!ledgerId) throw new HttpError(422, 'ledger_id is required');
  await ledgerForUpload(c, ledgerId);
  const wanted: string[] = Array.isArray(body.sha256_list)
    ? body.sha256_list.map((v: any) => String(v).trim().toLowerCase()).filter(Boolean)
    : [];
  if (!wanted.length) return json({ items: [] });
  const ph = wanted.map(() => '?').join(',');
  const rows = await all<any>(
    c.env.DB,
    `SELECT * FROM attachments WHERE user_id = ? AND sha256 IN (${ph})`,
    c.get('auth').user.id,
    ...wanted,
  );
  const bySha = new Map(rows.map((r) => [r.sha256, r]));
  return json({
    items: wanted.map((sha) => {
      const row = bySha.get(sha);
      return {
        sha256: sha,
        exists: !!row,
        file_id: row?.id ?? null,
        size: row?.size ?? null,
        mime_type: row?.mime_type ?? null,
      };
    }),
  });
});

async function loadAuthorized(c: any, fileId: string): Promise<any> {
  const auth = c.get('auth');
  const row = await one<any>(c.env.DB, `SELECT * FROM attachments WHERE id = ?`, fileId);
  if (!row) throw new HttpError(404, 'Attachment not found');
  if (row.user_id === auth.user.id || auth.user.is_admin) return row;
  if (row.ledger_id) {
    const member = await one<any>(
      c.env.DB,
      `SELECT 1 AS x FROM ledger_members WHERE ledger_id = ? AND user_id = ?`,
      row.ledger_id,
      auth.user.id,
    );
    if (member) return row;
  } else {
    // user-global (category icon): allow when the uploader owns a ledger the
    // caller also belongs to.
    const shared = await one<any>(
      c.env.DB,
      `SELECT 1 AS x FROM ledger_members m1
       JOIN ledger_members m2 ON m1.ledger_id = m2.ledger_id
       WHERE m1.user_id = ? AND m2.user_id = ? AND m2.role = 'owner' LIMIT 1`,
      auth.user.id,
      row.user_id,
    );
    if (shared) return row;
  }
  throw new HttpError(403, 'Attachment access forbidden');
}

async function serve(c: any, fileId: string, thumbnail: boolean): Promise<Response> {
  if (!c.env.BUCKET) throw new HttpError(404, 'Attachment not found');
  const row = await loadAuthorized(c, fileId);
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) throw new HttpError(404, 'Attachment file missing');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'private, max-age=31536000, immutable');
  if (!thumbnail) {
    headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.file_name || 'attachment')}`);
  }
  return new Response(obj.body, { headers });
}

attachmentRoutes.get('/:fileId', readScope, async (c) => serve(c, c.req.param('fileId')!, false));
// A Worker cannot resize images without a WASM decoder on the free CPU budget;
// serve the original bytes with the same cache semantics. Animated GIFs still
// render, and the web client downscales in CSS.
attachmentRoutes.get('/:fileId/thumbnail', readScope, async (c) => serve(c, c.req.param('fileId')!, true));
