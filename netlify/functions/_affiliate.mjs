// Affiliate program glue: talks to the partner app (auraa-partners) and nothing else.
//   - validateCode(code)         GET  /api/affiliates/code/{CODE}  -> {valid}
//   - applyToProgram(fields)     POST /api/affiliates/apply
//   - reportAffiliateOrder(...)  POST /api/affiliates/order, HMAC-SHA256 signed
// Every call has a short timeout and NEVER throws into a shopper's request: a partner
// app that is down must not fail, slow or lose an order. Failures are logged (no secret,
// no signature, no customer detail beyond the order ref).
import { createHmac } from 'node:crypto';

export const COOKIE = 'aur_ref';
export const COOKIE_DAYS = 30;
// Letters, digits, dash, underscore. Anything else is never sent to the app or stored.
export const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;

const baseUrl = () => (process.env.AFFILIATE_APP_URL || 'https://auraa-partners.vercel.app').replace(/\/+$/, '');

export const normalizeCode = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return CODE_RE.test(s) ? s : '';
};

export function readRefCookie(req) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return '';
  try { return normalizeCode(decodeURIComponent(m[1])); } catch { return ''; }
}

export const refCookie = (code) =>
  `${COOKIE}=${encodeURIComponent(code)}; Path=/; Secure; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}`;

async function timedFetch(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* -> { valid: true } | { valid: false } | { error: true }.
   `error` means the app could not answer (down, slow, bad reply), which is NOT the same
   as "invalid": callers decide what to do with an unknown. */
export async function validateCode(code, ms = 2500) {
  const c = normalizeCode(code);
  if (!c) return { valid: false };
  try {
    const res = await timedFetch(`${baseUrl()}/api/affiliates/code/${encodeURIComponent(c)}`, { headers: { accept: 'application/json' } }, ms);
    if (!res.ok) return { error: true };
    const d = await res.json();
    if (d && d.valid === true) return { valid: true };
    if (d && d.valid === false) return { valid: false };
    return { error: true };
  } catch (err) {
    console.warn('[affiliate] code check failed:', err?.name || err?.message);
    return { error: true };
  }
}

/* -> { ok:true } | { ok:false, status, error } . */
export async function applyToProgram(fields, ms = 8000) {
  try {
    const res = await timedFetch(`${baseUrl()}/api/affiliates/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(fields),
    }, ms);
    if (res.status === 201) return { ok: true };
    let msg = '';
    try { msg = String((await res.json())?.error || ''); } catch { /* no body */ }
    return { ok: false, status: res.status, error: res.status === 400 ? msg : '' };
  } catch (err) {
    console.warn('[affiliate] apply failed:', err?.name || err?.message);
    return { ok: false, status: 0, error: '' };
  }
}

/* Header value: hex HMAC-SHA256 over `${timestamp}.${rawBody}`. */
export const signOrderBody = (secret, timestamp, rawBody) =>
  createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

// The app speaks pending | paid | cancelled | refunded. Everything else (shipped, payment
// failed, held for review) is not a money event and is not sent.
const STATUS_MAP = {
  pending_payment: 'pending',
  paid: 'paid',
  shipped: 'paid',
  cancelled: 'cancelled',
  refunded: 'refunded',
};
export const affiliateStatus = (orderStatus) => STATUS_MAP[orderStatus] || null;

/* Fire-and-forget order report. Resolves (never rejects) in at most `ms`. Only sends
   when the order carries a code. Returns { sent, ok?, reason? } for the admin resend. */
export async function reportAffiliateOrder(order, status, { ms = 3000 } = {}) {
  try {
    const code = normalizeCode(order?.affiliate?.code);
    if (!code) return { sent: false, reason: 'no code' };
    const mapped = affiliateStatus(status) || null;
    if (!mapped) return { sent: false, reason: 'status not reported' };
    const secret = process.env.AFFILIATE_ORDER_WEBHOOK_SECRET;
    if (!secret) {
      console.warn(`[affiliate] ${order.ref}: AFFILIATE_ORDER_WEBHOOK_SECRET not set, order not reported`);
      return { sent: false, reason: 'secret not set' };
    }
    const rawBody = JSON.stringify({
      order_id: order.ref,
      code,
      subtotal_cents: Math.round(Number(order.subtotal) * 100),
      status: mapped,
      created_at: order.createdAt,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await timedFetch(`${baseUrl()}/api/affiliates/order`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auraa-timestamp': timestamp,
        'x-auraa-signature': signOrderBody(secret, timestamp, rawBody),
      },
      body: rawBody,
    }, ms);
    if (!res.ok) {
      console.warn(`[affiliate] ${order.ref} ${mapped}: app answered ${res.status}`);
      return { sent: true, ok: false, status: res.status };
    }
    return { sent: true, ok: true };
  } catch (err) {
    console.warn(`[affiliate] ${order?.ref} ${status}: report failed:`, err?.name || err?.message);
    return { sent: true, ok: false, reason: 'unreachable' };
  }
}

/* Let the report finish after the response has gone out when the platform allows it
   (context.waitUntil); otherwise wait for it, which is bounded by the report's timeout. */
export async function finishInBackground(context, promise) {
  const safe = Promise.resolve(promise).catch(() => {});
  if (context && typeof context.waitUntil === 'function') { context.waitUntil(safe); return; }
  await safe;
}
