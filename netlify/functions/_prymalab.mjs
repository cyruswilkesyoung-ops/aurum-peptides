// PrymaLab, as this store orders from it. Server only.
//
// Ported from the Hardproof store template (lib/hardproof/supplier/prymalab.ts) and the
// Hardproof CRM (lib/backend/suppliers/prymalab.js). Partner API v1: POST /orders with this
// store's OWN sub-account key (partner ID in _prymalab-skus.json) and the store's order
// reference as external_id, which is PrymaLab's duplicate guard: the same reference again
// returns the same order (HTTP 200) instead of creating a second one.
//
// PrymaLab has no test keys. Every order it accepts ships and is billed, so:
//   - nothing is sent unless PRYMALAB_SEND is exactly "on" AND PRYMALAB_API_KEY is set;
//     otherwise the order is not touched at all (log line only);
//   - a TagadaPay test (draft) payment is never sent;
//   - an order holding any size PrymaLab does not carry is held for a person, never partly sent;
//   - before every order, GET /me must say the key belongs to this store's partner ID.
// Only the documented host is called and no redirect is followed. What goes: the order
// reference, where it ships, which SKUs. No customer email or phone, no retail prices, no
// payment details. The key is never logged, stored or returned.
import { getStore, getDeployStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import map from './_prymalab-skus.json' with { type: 'json' };

export const BASE = 'https://prymalab.net/wp-json/prymalab/v1';
export const PARTNER_ID = String(map.partnerId);
export const SITE = String(map.site);
export const RETRY_STATES = new Set(['retrying', 'held_balance']);
export const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const REF = /^AUR-[A-Z0-9]{6}$/;

/* ---- switch and key -------------------------------------------------------- */
export function sendConfig() {
  const on = (process.env.PRYMALAB_SEND || '').trim() === 'on';
  const key = (process.env.PRYMALAB_API_KEY || '').trim();
  if (!on) return { ok: false, why: 'PRYMALAB_SEND is not "on"' };
  if (!key) return { ok: false, why: 'PRYMALAB_API_KEY is not set' };
  return { ok: true, key };
}

/* ---- text helpers ---------------------------------------------------------- */
const usd = (c) => '$' + (c / 100).toFixed(2);
const short = (v, max = 80) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** Anything PrymaLab echoes is masked before it is stored or shown: keys, emails, phone numbers, long tokens. */
export function scrub(message) {
  return String(message ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(plk|ap_sk|ap_pk|sk|pk|tp)_[^\s"',;]*/gi, '[hidden]')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/\+?[0-9][0-9\s().-]{6,}[0-9]/g, '[number]')
    .replace(/[A-Za-z0-9_\-+/=.]{24,}/g, '[hidden]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function named(d) {
  if (!d || typeof d !== 'object') return '';
  const parts = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    else if (Array.isArray(v)) v.slice(0, 5).forEach(add);
    else if (v && typeof v === 'object') for (const k of ['sku', 'field', 'message', 'error']) add(v[k]);
  };
  for (const k of ['error', 'message', 'detail', 'sku', 'skus', 'field', 'missing', 'errors']) add(d[k]);
  return scrub([...new Set(parts)].join('; '));
}

// Amounts arrive as dollars (a number or a numeric string) and are kept in cents.
function cents(v) {
  let n = v;
  if (n && typeof n === 'object' && !Array.isArray(n)) n = n.amount ?? n.total ?? n.due;
  if (typeof n === 'string') {
    const s = n.replace(/[$,\s]/g, '');
    n = /^-?[0-9]+(\.[0-9]+)?$/.test(s) ? Number(s) : NaN;
  }
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e9 ? Math.round(n * 100) : null;
}

const host = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : 'https://' + v).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/* ---- SKU map --------------------------------------------------------------- */
/** Cart lines to PrymaLab lines. Bundles multiply: a bundle of 3, twice, is 6 vials. Same SKU lines merge. */
export function mapItems(items) {
  const lines = new Map();
  const unmapped = [];
  for (const it of Array.isArray(items) ? items : []) {
    const sku = map.skus[String(it?.slug)]?.[String(it?.variant)];
    const qty = Number(it?.bundleQty || 1) * Number(it?.qty);
    if (!sku) {
      unmapped.push(`${it?.name || it?.slug} ${it?.meta || it?.variant || ''}`.trim());
      continue;
    }
    if (!Number.isInteger(qty) || qty < 1) {
      unmapped.push(`${it?.name || it?.slug} (quantity ${it?.qty})`);
      continue;
    }
    lines.set(sku, (lines.get(sku) || 0) + qty);
  }
  return { lines: [...lines].map(([sku, qty]) => ({ sku, qty })), unmapped };
}

/** Where it ships, from what TagadaPay's checkout collected (written by tagada-webhook.mjs). */
export function shipToOf(order) {
  const c = order?.customer || {};
  const t = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    name: t(c.shipName) || t(c.name),
    address1: t(c.address1, 200),
    address2: t(c.address2, 200),
    city: t(c.city, 100),
    state: t(c.state, 60),
    zip: t(c.postal, 20),
    country: t(c.country, 60),
  };
}

/** The whole body PrymaLab gets. Nothing else about the buyer or the payment. */
export function orderBody(ref, shipTo, lines) {
  return {
    external_id: ref,
    ship_to: {
      name: shipTo.name,
      address_1: shipTo.address1,
      ...(shipTo.address2 ? { address_2: shipTo.address2 } : {}),
      city: shipTo.city,
      state: shipTo.state,
      postcode: shipTo.zip,
      country: shipTo.country,
    },
    items: lines.map((x) => ({ sku: x.sku, quantity: x.qty })),
  };
}

/* ---- HTTP ------------------------------------------------------------------ */
const netError = (err, secs) =>
  err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `no answer within ${secs} seconds` : String(err?.cause?.code || 'network error');

async function call(key, path, { method = 'GET', body, timeoutMs = 20000, fetcher = globalThis.fetch } = {}) {
  const headers = { authorization: 'Bearer ' + key, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const r = await fetcher(BASE + path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await r.text().catch(() => '');
    let data = null;
    if (raw.length <= 2000000) {
      try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    }
    return { status: r.status, data };
  } catch (err) {
    return { error: netError(err, Math.round(timeoutMs / 1000)) };
  }
}

/** GET /me with this store's key must name this store's partner ID (and, when given, this store's site). Fails closed. */
export async function identify(key, { timeoutMs = 10000, fetcher } = {}) {
  const r = await call(key, '/me', { timeoutMs, fetcher });
  if (r.error) return { ok: false, state: 'retrying', detail: `PrymaLab did not answer when asked whose key this is (${r.error}).` };
  if (r.status === 401) return { ok: false, state: 'key_rejected', http_status: 401, detail: 'PrymaLab rejected this store\'s key (HTTP 401). It was revoked or replaced. Ask Hardproof for a new key, then press Send to PrymaLab.' };
  if (r.status === 403) return { ok: false, state: 'failed', http_status: 403, detail: 'PrymaLab refused this store\'s key (HTTP 403). The account may be paused. Ask Hardproof to check it, then press Send to PrymaLab.' };
  if (r.status === 429 || r.status >= 500) return { ok: false, state: 'retrying', http_status: r.status, detail: `PrymaLab could not say whose key this is (HTTP ${r.status}).` };
  const me = r.status === 200 && r.data && typeof r.data === 'object' ? r.data : null;
  const theirs = short(me?.partner_id ?? me?.id, 64);
  if (!theirs) return { ok: false, state: 'failed', http_status: r.status, detail: `PrymaLab answered HTTP ${r.status} without the account the key belongs to. Nothing was sent.` };
  if (theirs !== PARTNER_ID) return { ok: false, state: 'held', detail: `This store's PrymaLab key belongs to account ${scrub(theirs)}, but the store is set up as account ${PARTNER_ID}. Nothing was sent. Ask Hardproof to check the key.` };
  const theirStore = host(me.store_url ?? me.url);
  if (theirStore && theirStore !== SITE) return { ok: false, state: 'held', detail: `PrymaLab has account ${PARTNER_ID} registered to ${scrub(theirStore)}, but this store is ${SITE}. Nothing was sent. Ask Hardproof to check which brand this key belongs to.` };
  return { ok: true };
}

/* ---- PrymaLab's answer as an order state ---------------------------------- */
function sameLines(echo, sent) {
  if (!Array.isArray(echo) || !echo.length) return null; // no echo proves nothing either way
  const tally = (list) => {
    const m = new Map();
    for (const x of list) {
      const k = String(x?.sku ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!k) return null;
      m.set(k, (m.get(k) ?? 0) + Number(x.quantity ?? x.qty));
    }
    return m;
  };
  const a = tally(echo);
  const b = tally(sent);
  if (!a || !b) return null;
  return a.size === b.size && [...b].every(([k, v]) => a.get(k) === v);
}

const SHIPS = { paid: 'its invoice is paid', terms: 'its invoice is on payment terms', terms_due: 'its invoice is on payment terms and now due', none: 'no payment is needed' };

export function outcome(r, { ref, lines }) {
  if (r.error) return { state: 'retrying', detail: `PrymaLab did not answer (${r.error}). It is asked again every hour for 3 days; the order reference stops a second order.` };
  const status = r.status;
  const d = r.data && typeof r.data === 'object' ? r.data : {};
  if (status === 200 || status === 201) {
    const o = d.order && typeof d.order === 'object' ? d.order : d;
    const pick = (k) => d[k] ?? o[k];
    const pay = pick('payment') && typeof pick('payment') === 'object' ? pick('payment') : {};
    const ps = (short(pay.status, 20) ?? '').toLowerCase();
    const cost = cents(pick('partner_cost'));
    const ship = cents(pick('shipping_charge'));
    const due = cents(pay.amount_due);
    const charged = { partner_cost_cents: cost, shipping_cents: ship, amount_due_cents: due, amount_paid_cents: cents(pay.amount_paid) };
    const base = {
      http_status: status,
      supplier_order_id: short(o.id),
      supplier_status: short(o.status, 40),
      charged: Object.values(charged).some((v) => v != null) ? charged : null,
    };
    const repeat = status === 200 || d.duplicate === true;
    const costs = cost != null ? ` PrymaLab's cost ${usd(cost)}${ship != null ? ` plus ${usd(ship)} shipping` : ''}.` : '';
    const echoId = short(o.external_id, 100);
    if (echoId && echoId !== ref) return { ...base, state: 'conflict', detail: `PrymaLab answered for order ${scrub(echoId)} when this store sent ${ref} (HTTP ${status}). A person needs to look at it in the PrymaLab dashboard. It is not sent again on its own.` };
    if (sameLines(o.items, lines) === false) {
      return {
        ...base,
        state: 'conflict',
        detail: repeat
          ? `PrymaLab already has order ${ref} with different products (HTTP ${status}). Nothing new was created. Check that order in the PrymaLab dashboard before sending again.`
          : `PrymaLab accepted order ${ref}${base.supplier_order_id ? ` as ${base.supplier_order_id}` : ''} but lists different products than this store sent (HTTP ${status}). Open it in the PrymaLab dashboard now and cancel it there if it is wrong. It is not sent again on its own.`,
      };
    }
    if (base.supplier_status === 'cancelled') return { ...base, state: 'supplier_cancelled', detail: `PrymaLab holds order ${ref} as cancelled (HTTP ${status}), so nothing ships. A person needs to look at it in the PrymaLab dashboard.` };
    if (ps && Object.hasOwn(SHIPS, ps)) {
      return {
        ...base,
        state: 'submitted',
        detail: (repeat
          ? `PrymaLab already had this order under the same reference, so it was not created or charged twice; ${SHIPS[ps]}.`
          : `PrymaLab accepted the order${base.supplier_status ? ` (${base.supplier_status})` : ''}; ${SHIPS[ps]}.`) + costs,
      };
    }
    return {
      ...base,
      state: 'held_balance',
      detail: `PrymaLab has the order${base.supplier_order_id ? ` (${base.supplier_order_id})` : ''} but ships it only once its invoice is paid (payment ${scrub(ps) || 'not given'}${due != null ? `, ${usd(due)} due` : ''}). The PrymaLab balance that pays this brand's invoices needs topping up. It is asked again every hour for 3 days; the order reference stops a second order.${costs}`,
    };
  }
  const code = (short(d.code, 40) ?? short(d.error, 40) ?? '').toLowerCase();
  const said = named(d);
  const why = scrub(said.includes(code) ? said : [code, said].filter(Boolean).join(': '));
  const tail = why ? ': ' + why : '';
  if (status === 401) return { http_status: status, state: 'key_rejected', detail: `PrymaLab rejected this store's key (HTTP 401)${tail}. It was revoked or replaced. Ask Hardproof for a new key, then press Send to PrymaLab.` };
  if (status === 422) {
    const next = code.includes('no_address')
      ? 'The delivery address is missing its street, city, state or ZIP. Correct it with the customer.'
      : code.includes('no_items')
        ? 'PrymaLab found no product it recognises. Ask Hardproof to check the SKU list.'
        : 'Sort it out, then press Send to PrymaLab.';
    return { http_status: status, state: 'rejected', detail: `PrymaLab refused the order (HTTP 422)${tail}. Nothing was created or charged. ${next}` };
  }
  if (status === 429 || status >= 500) return { http_status: status, state: 'retrying', detail: `PrymaLab ${status === 429 ? 'is limiting how fast orders are sent (HTTP 429)' : `had a problem on their side (HTTP ${status})`}. It is asked again every hour for 3 days; the order reference stops a second order.` };
  if (status >= 300 && status < 400) return { http_status: status, state: 'failed', detail: `PrymaLab redirected the order (HTTP ${status}), so it was not sent. Their ordering address may have changed. Tell Hardproof.` };
  const next = status === 403
    ? 'The account may be paused. Ask Hardproof to check it in the PrymaLab dashboard.'
    : status === 404
      ? 'PrymaLab\'s ordering address may have changed. Tell Hardproof.'
      : status === 400
        ? 'PrymaLab could not read the order. A person needs to look at it.'
        : 'It is not sent again on its own. A person needs to look at it.';
  return { http_status: status, state: 'failed', detail: `PrymaLab answered HTTP ${status}${tail}. ${next}` };
}

/* ---- storage --------------------------------------------------------------- */
function metaStore() {
  const isProd = globalThis.Netlify?.context?.deploy?.context === 'production';
  return isProd ? getStore('prymalab-meta') : getDeployStore('prymalab-meta');
}

/** When this store first ran with sending switched on. Orders created before it are never sent (no backfill). */
async function sendingSince() {
  const meta = metaStore();
  const got = await meta.get('since', { type: 'json' }).catch(() => null);
  if (got?.at && Number.isFinite(Date.parse(got.at))) return got.at;
  const at = new Date().toISOString();
  await meta.setJSON('since', { at }).catch(() => {});
  return at;
}
export async function readSince() {
  const got = await metaStore().get('since', { type: 'json' }).catch(() => null);
  return got?.at && Number.isFinite(Date.parse(got.at)) ? got.at : null;
}

/** Writes the PrymaLab record onto the order, re-reading it first so a concurrent change is not lost. */
async function record(store, ref, rec, via) {
  const fresh = (await store.get(ref, { type: 'json' }).catch(() => null)) || null;
  if (!fresh) return null;
  const prev = fresh.prymalab || {};
  const now = new Date().toISOString();
  const attempts = [...(prev.attempts || []), { at: now, via, state: rec.state, http_status: rec.http_status ?? null }].slice(-12);
  fresh.prymalab = {
    external_id: ref,
    firstAt: prev.firstAt || now,
    ...prev,
    state: rec.state,
    detail: rec.detail,
    http_status: rec.http_status ?? null,
    supplier_order_id: rec.supplier_order_id ?? prev.supplier_order_id ?? null,
    supplier_status: rec.supplier_status ?? prev.supplier_status ?? null,
    charged: rec.charged ?? prev.charged ?? null,
    lines: rec.lines ?? prev.lines ?? null,
    unmapped: rec.unmapped ?? null,
    lastAt: now,
    attempts,
  };
  await store.setJSON(ref, fresh);
  return fresh;
}

/* ---- the send -------------------------------------------------------------- */
/**
 * Sends one paid order to PrymaLab and records what happened on it. Never throws.
 * Returns { sent: false, skipped } and touches nothing when sending is off or the order is not eligible;
 * otherwise { sent: true, state, order }.
 *   via: 'paid-webhook' | 'retry' | 'admin'
 *   requireRecord: true for the hourly retry (it only resumes orders already in its queue)
 */
export async function sendToPrymalab(store, ref, { via, timeouts = {}, fetcher, requireRecord = false } = {}) {
  try {
    const cfg = sendConfig();
    if (!cfg.ok) {
      console.log(`[prymalab] ${ref}: not sent, ${cfg.why}`);
      return { sent: false, skipped: 'off', why: 'PrymaLab sending is switched off, so nothing was sent.' };
    }
    if (!REF.test(String(ref))) return { sent: false, skipped: 'bad_ref', why: 'Unknown order reference.' };
    const order = await store.get(ref, { type: 'json' }).catch(() => null);
    if (!order) return { sent: false, skipped: 'missing', why: 'Unknown order reference.' };

    const pr = order.prymalab || null;
    if (requireRecord && !pr) return { sent: false, skipped: 'not_queued', why: 'Not in the PrymaLab queue.' };
    if (order.status !== 'paid') return { sent: false, skipped: 'not_paid', why: `The order is ${order.status}, not paid, so it is not sent.` };
    if (order.tracking) return { sent: false, skipped: 'has_tracking', why: 'The order already has tracking, so it is not sent.' };
    if (pr?.state === 'submitted') return { sent: false, skipped: 'already', why: 'PrymaLab already has this order.' };

    // No backfill: an order paid before sending began was fulfilled some other way. The paid
    // webhook is exempt (it is the payment happening now); the hourly retry only resumes orders
    // already in the queue; so this bites on the admin button for an order with no record yet.
    const since = await sendingSince();
    const paidAt = Date.parse(order.paidAt || order.createdAt);
    if (!pr && via !== 'paid-webhook' && !(paidAt >= Date.parse(since))) {
      return { sent: false, skipped: 'before_start', why: 'This order was placed before PrymaLab sending began, so it is not sent from here.' };
    }

    if (order.payment?.draft === true) {
      return { sent: true, ...(await settle(store, ref, { state: 'held', detail: 'This was a TagadaPay test payment, so it was not sent to PrymaLab. PrymaLab has no test orders: everything it accepts ships and is billed.' }, via)) };
    }

    const { lines, unmapped } = mapItems(order.items);
    if (unmapped.length) {
      return { sent: true, ...(await settle(store, ref, { state: 'held', unmapped, lines: null, detail: `Not sent: PrymaLab does not carry ${unmapped.join(', ')}. Nothing was sent, not even the other items. Fulfil this order another way, or change it with the customer.` }, via)) };
    }
    if (!lines.length) return { sent: true, ...(await settle(store, ref, { state: 'held', detail: 'Not sent: the order has no items.' }, via)) };

    const shipTo = shipToOf(order);
    const missing = ['name', 'address1', 'city', 'state', 'zip', 'country'].filter((k) => !shipTo[k]);
    if (missing.length) {
      return { sent: true, ...(await settle(store, ref, { state: 'held', lines, detail: `Not sent: the delivery address is missing ${missing.join(', ').replace('address1', 'street').replace('zip', 'ZIP')}. Correct it, then press Send to PrymaLab.` }, via)) };
    }

    const who = await identify(cfg.key, { timeoutMs: timeouts.me ?? 10000, fetcher });
    if (!who.ok) return { sent: true, ...(await settle(store, ref, { state: who.state, http_status: who.http_status, detail: who.detail, lines }, via)) };

    const r = await call(cfg.key, '/orders', { method: 'POST', body: orderBody(ref, shipTo, lines), timeoutMs: timeouts.order ?? 20000, fetcher });
    const out = outcome(r, { ref, lines });
    return { sent: true, ...(await settle(store, ref, { ...out, lines }, via)) };
  } catch (err) {
    console.error(`[prymalab] ${ref}: send failed unexpectedly: ${err?.name || 'error'}`);
    return { sent: false, skipped: 'error', why: 'Something went wrong sending to PrymaLab. Nothing was recorded.' };
  }
}

async function settle(store, ref, rec, via) {
  const order = await record(store, ref, rec, via);
  console.log(`[prymalab] ${ref}: ${rec.state}${rec.http_status ? ` (HTTP ${rec.http_status})` : ''} via ${via}`);
  return { state: rec.state, detail: rec.detail, order };
}

/* ---- tracking webhook ------------------------------------------------------ */
/** X-PrymaLab-Signature: hex HMAC-SHA256 of the raw body with the signing secret ("sha256=" prefix tolerated). */
export function verifyPrymalabSignature(raw, header, secret) {
  if (!secret) return false;
  const given = String(header ?? '').trim().replace(/^sha256=/i, '');
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const a = Buffer.from(given.toLowerCase(), 'hex');
  const b = createHmac('sha256', secret).update(raw, 'utf8').digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tracking as PrymaLab gives it on an order (and the same fields in its webhooks). */
export function trackingOf(o) {
  const x = o && typeof o === 'object' ? o : {};
  const shipped = short(x.shipped_at, 40);
  return {
    status: short(x.status, 40),
    carrier: short(x.carrier, 60),
    tracking_number: short(x.tracking_number, 80),
    shipped_at: shipped && Number.isFinite(Date.parse(shipped)) ? new Date(Date.parse(shipped)).toISOString() : null,
  };
}
