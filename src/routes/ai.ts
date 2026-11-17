import { Hono } from 'hono';
import type { AppContext } from '../lib/auth';
import { authMiddleware, SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE, requireScopes } from '../lib/auth';
import { all, one } from '../lib/db';
import { HttpError, json, parseJson } from '../lib/util';

export const aiRoutes = new Hono<AppContext>();

aiRoutes.use('*', authMiddleware());
const readScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_READ, SCOPE_WEB_WRITE);
const writeScope = requireScopes(SCOPE_APP_WRITE, SCOPE_WEB_WRITE);
aiRoutes.use('*', readScope);

type Provider = { providerId: string; baseUrl: string; apiKey: string; model: string };

function resolveProvider(aiConfig: any, env: AppContext['Bindings'], kind: 'text' | 'vision'): Provider {
  const cfg = aiConfig && typeof aiConfig === 'object' ? aiConfig : {};
  const binding = cfg.binding && typeof cfg.binding === 'object' ? cfg.binding : {};
  const providerId = kind === 'text' ? binding.textProviderId : binding.visionProviderId;
  const providers: any[] = Array.isArray(cfg.providers) ? cfg.providers : [];
  const matched = providers.find((p) => p && p.id === providerId);
  if (matched?.apiKey && matched?.baseUrl) {
    const model = kind === 'text' ? matched.textModel : matched.visionModel;
    if (model) return { providerId: matched.id, baseUrl: String(matched.baseUrl).replace(/\/+$/, ''), apiKey: String(matched.apiKey), model: String(model) };
  }
  if (kind === 'text' && env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL) {
    return { providerId: 'env', baseUrl: env.AI_BASE_URL.replace(/\/+$/, ''), apiKey: env.AI_API_KEY, model: env.AI_MODEL };
  }
  if (kind === 'vision' && env.AI_BASE_URL && env.AI_API_KEY && env.AI_VISION_MODEL) {
    return { providerId: 'env', baseUrl: env.AI_BASE_URL.replace(/\/+$/, ''), apiKey: env.AI_API_KEY, model: env.AI_VISION_MODEL };
  }
  throw new HttpError(400, {
    error_code: kind === 'text' ? 'AI_NO_CHAT_PROVIDER' : 'AI_NO_VISION_PROVIDER',
    message: kind === 'text' ? 'No text model is configured. Set one in AI settings.' : 'No vision model is configured. Set one in AI settings.',
  });
}

async function chat(provider: Provider, messages: any[], opts: { json?: boolean; stream?: boolean; maxTokens?: number } = {}): Promise<Response> {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 1200,
      stream: !!opts.stream,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new HttpError(502, { error_code: 'AI_PROVIDER_ERROR', message: `provider ${res.status}: ${text}` });
  }
  return res;
}

async function chatJson(provider: Provider, messages: any[]): Promise<any> {
  const res = await chat(provider, messages, { json: true });
  const data = (await res.json()) as any;
  const text = String(data?.choices?.[0]?.message?.content || '');
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
  }
  throw new HttpError(422, { error_code: 'AI_PARSE_FAILED', message: 'model did not return valid JSON', raw: text.slice(0, 1000) });
}

function normalizeDrafts(result: any) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.tx_drafts)) {
    throw new HttpError(422, { error_code: 'AI_SCHEMA_INVALID', message: 'expected {"tx_drafts": [...]}', raw: JSON.stringify(result).slice(0, 1000) });
  }
  const out: any[] = [];
  for (const d of result.tx_drafts) {
    if (!d || typeof d !== 'object') continue;
    const amt = Number(d.amount);
    if (!Number.isFinite(amt)) continue;
    const type = ['expense', 'income', 'transfer'].includes(d.type) ? d.type : 'expense';
    const currency = typeof d.currency === 'string' && /^[A-Za-z]{3}$/.test(d.currency.trim()) ? d.currency.trim().toUpperCase() : '';
    out.push({
      type,
      amount: Math.abs(amt),
      currency,
      happened_at: typeof d.happened_at === 'string' ? d.happened_at : '',
      category_name: String(d.category_name || '').trim(),
      account_name: String(d.account_name || '').trim(),
      from_account_name: String(d.from_account_name || '').trim() || null,
      to_account_name: String(d.to_account_name || '').trim() || null,
      note: String(d.note || '').trim(),
      tags: Array.isArray(d.tags) ? d.tags.filter((t: any) => typeof t === 'string' && t.trim()) : [],
      confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'medium',
    });
  }
  return out;
}

async function ledgerContext(c: any, ledgerId?: string | null) {
  const auth = c.get('auth');
  let currency = 'CNY';
  let accounts = await all<any>(c.env.DB, `SELECT name FROM user_accounts WHERE user_id = ?`, auth.user.id);
  let categories = await all<any>(c.env.DB, `SELECT name, kind FROM user_categories WHERE user_id = ?`, auth.user.id);
  if (ledgerId) {
    const ledger = await one<any>(
      c.env.DB,
      `SELECT l.* FROM ledgers l JOIN ledger_members m ON m.ledger_id=l.id WHERE l.external_id=? AND m.user_id=? AND l.deleted_at IS NULL`,
      ledgerId,
      auth.user.id,
    );
    if (ledger) {
      currency = ledger.currency || 'CNY';
      const owner = await one<any>(c.env.DB, `SELECT user_id FROM ledgers WHERE id = ?`, ledger.id);
      if (owner?.user_id && owner.user_id !== auth.user.id) {
        accounts = await all<any>(c.env.DB, `SELECT name FROM user_accounts WHERE user_id = ?`, owner.user_id);
        categories = await all<any>(c.env.DB, `SELECT name, kind FROM user_categories WHERE user_id = ?`, owner.user_id);
      }
    }
  }
  return { currency, accounts: accounts.map((a) => a.name).filter(Boolean), categories: categories.map((x) => `${x.name}(${x.kind})`) };
}

function parseMessages(text: string, ctx: { currency: string; accounts: string[]; categories: string[] }, locale: string, now: string) {
  const system = `You are a bookkeeping parser. Return ONLY JSON: {"tx_drafts":[{type:"expense|income|transfer",amount:number,currency:"",happened_at:"ISO8601",category_name:"",account_name:"",from_account_name:null,to_account_name:null,note:"",tags:[],confidence:"high|medium|low"}]}.
Use the ledger currency ${ctx.currency} unless the text names another currency.
Prefer these categories: ${ctx.categories.slice(0, 80).join(', ') || '(none)'}.
Prefer these accounts: ${ctx.accounts.slice(0, 40).join(', ') || '(none)'}.
Now is ${now}. locale=${locale}. Never invent unknown categories if a close match exists.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
}

aiRoutes.post('/parse-tx-text', writeScope, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const text = String(body.text || '').trim();
  if (!text || text.length > 5000) throw new HttpError(422, 'text must be 1..5000 characters');
  const profile = await one<any>(c.env.DB, `SELECT * FROM user_profiles WHERE user_id = ?`, c.get('auth').user.id);
  const provider = resolveProvider(parseJson(profile?.ai_config_json, null), c.env, 'text');
  const ctx = await ledgerContext(c, body.ledger_id);
  const result = await chatJson(provider, parseMessages(text, ctx, String(body.locale || 'zh'), new Date().toISOString()));
  return json({ tx_drafts: normalizeDrafts(result) });
});

aiRoutes.post('/parse-tx-image', writeScope, async (c) => {
  const form = await c.req.formData();
  const image = form.get('image');
  if (!(image instanceof File)) throw new HttpError(422, 'image is required');
  if (image.size > 8 * 1024 * 1024) throw new HttpError(413, 'Image too large (max 8 MB)');
  const profile = await one<any>(c.env.DB, `SELECT * FROM user_profiles WHERE user_id = ?`, c.get('auth').user.id);
  const provider = resolveProvider(parseJson(profile?.ai_config_json, null), c.env, 'vision');
  const ctx = await ledgerContext(c, String(form.get('ledger_id') || ''));
  const bytes = new Uint8Array(await image.arrayBuffer());
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const dataUrl = `data:${image.type || 'image/jpeg'};base64,${btoa(binary)}`;
  const messages = parseMessages(String(form.get('locale') || 'zh'), ctx, String(form.get('locale') || 'zh'), new Date().toISOString());
  messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: 'Parse the transactions in this screenshot.' }] } as any);
  const result = await chatJson(provider, messages);
  return json({ tx_drafts: normalizeDrafts(result), image_id: '' });
});

aiRoutes.post('/test-provider', writeScope, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const p = body.provider;
  const started = Date.now();
  if (!p?.baseUrl || !p?.apiKey) return json({ success: false, error_code: 'AI_TEST_MISSING_FIELDS', error_message: 'baseUrl and apiKey are required', latency_ms: 0, preview: '' });
  const capability = String(body.capability || 'text');
  const model = capability === 'vision' ? p.visionModel || p.textModel : p.textModel;
  if (!model) return json({ success: false, error_code: 'AI_TEST_MISSING_FIELDS', error_message: 'model is empty', latency_ms: Date.now() - started, preview: '' });
  try {
    const res = await fetch(`${String(p.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 16 }),
    });
    const latency = Date.now() - started;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      const code = res.status === 401 || res.status === 403 ? 'AI_TEST_AUTH' : res.status === 404 ? 'AI_TEST_MODEL_NOT_FOUND' : res.status === 429 ? 'AI_TEST_RATE_LIMITED' : 'AI_TEST_UNKNOWN';
      return json({ success: false, error_code: code, error_message: `${res.status}: ${text}`, latency_ms: latency, preview: '' });
    }
    const data = (await res.json()) as any;
    return json({ success: true, error_code: null, error_message: null, latency_ms: latency, preview: String(data?.choices?.[0]?.message?.content || '').slice(0, 120) });
  } catch (e) {
    return json({ success: false, error_code: 'AI_TEST_NETWORK', error_message: String((e as Error)?.message || e).slice(0, 200), latency_ms: Date.now() - started, preview: '' });
  }
});

aiRoutes.get('/docs-index/status', async () =>
  json({
    source: 'builtin',
    corpus_hash: null,
    embedding_model: null,
    languages: {},
    last_checked_at: null,
    last_updated_at: null,
    last_error: '文档检索索引未部署到 Workers 版本，问答会直接使用模型回答。',
    remote_corpus_hash: null,
    is_latest: null,
  }),
);

aiRoutes.post('/ask', readScope, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any;
  const query = String(body.query || '').trim();
  if (!query || query.length > 1000) throw new HttpError(422, 'query must be 1..1000 characters');
  const profile = await one<any>(c.env.DB, `SELECT * FROM user_profiles WHERE user_id = ?`, c.get('auth').user.id);
  const provider = resolveProvider(parseJson(profile?.ai_config_json, null), c.env, 'text');
  const res = await chat(
    provider,
    [
      { role: 'system', content: 'You are BeeCount help. Answer concisely in the user language. If you are unsure, say what part of the app to check.' },
      { role: 'user', content: query },
    ],
    { stream: true, maxTokens: 900 },
  );
  if (!res.body) throw new HttpError(502, { error_code: 'AI_PROVIDER_ERROR', message: 'empty stream' });

  const encoder = new TextEncoder();
  const sse = (obj: any) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
  const upstream = res.body.getReader();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await upstream.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const evt = JSON.parse(payload);
              const delta = evt?.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(sse({ type: 'chunk', text: delta }));
            } catch {
              /* ignore partial */
            }
          }
        }
        controller.enqueue(sse({ type: 'sources', items: [] }));
        controller.enqueue(sse({ type: 'done' }));
      } catch (e) {
        controller.enqueue(sse({ type: 'error', error_code: 'AI_PROVIDER_ERROR', message: String((e as Error)?.message || e).slice(0, 200) }));
      } finally {
        controller.close();
      }
    },
    cancel() {
      upstream.cancel().catch(() => undefined);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform' } });
});
