// Shared server helpers: pricing, admin auth, order storage.
import { getStore, getDeployStore } from '@netlify/blobs';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import catalogFile from './_catalog.json' with { type: 'json' };

export const catalog = catalogFile.products;

// Shipping lives in TWO places by necessity: js/app.js:371 draws it in the browser so the
// customer sees a total before submitting, and here so the server charges one. They must
// agree. If either moves, move both.
export const SHIP_FLAT = 9.95;
export const FREE_SHIP_OVER = 150;

export const money = (n) => Math.round(n * 100) / 100;
export const fmtUSD = (n) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const fail = (message, status = 400) => json({ ok: false, error: message }, status);

/* ---- storage ---------------------------------------------------------------
   Deploy previews and branch builds write to their own store, so a test order placed
   against a preview URL can never appear in the real order list. */
export function orderStore() {
  const isProd = globalThis.Netlify?.context?.deploy?.context === 'production';
  return isProd ? getStore('orders') : getDeployStore('orders');
}

/* ---- rate limiting ---------------------------------------------------------
   Nothing else stops a script from creating orders in a loop, and the admin list reads
   every order on every load, so junk rows degrade the panel as well as the inbox. The
   same helper caps failed admin logins, which is otherwise an unlimited guessing budget
   against a single shared password.

   ⚠️ HONEST LIMIT. Netlify Blobs has no atomic increment — the docs are explicit that
   writes are last-write-wins — so two requests landing in the same instant can each read
   the same count and write back the same value, losing one. That makes this a brake on
   scripted abuse, which is the realistic threat, NOT a hard guarantee against a
   determined attacker racing it deliberately. Anything needing a real guarantee wants a
   store with atomic counters. Failing OPEN on a storage error is deliberate too: a
   limiter outage must not take checkout down with it. */
export function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

export async function rateLimit({ bucket, id, max, windowMs }) {
  const isProd = globalThis.Netlify?.context?.deploy?.context === 'production';
  const store = isProd ? getStore('ratelimit') : getDeployStore('ratelimit');
  const key = `${bucket}:${id}`.replace(/[^A-Za-z0-9_.:@+-]/g, '_').slice(0, 600);
  const now = Date.now();
  try {
    const rec = (await store.get(key, { type: 'json' })) || { hits: [] };
    const hits = (rec.hits || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return { ok: false, retryAfter: Math.ceil((windowMs - (now - hits[0])) / 1000) };
    }
    hits.push(now);
    await store.setJSON(key, { hits });
    return { ok: true, remaining: max - hits.length };
  } catch (err) {
    console.error('[ratelimit] store unavailable, allowing request:', err?.message);
    return { ok: true, remaining: -1 };
  }
}

/* ---- admin auth ------------------------------------------------------------
   Compares SHA-256 digests rather than the raw strings so timingSafeEqual gets two
   equal-length buffers; comparing raw secrets of different lengths throws, and the
   throw itself leaks length. Fails closed when ADMIN_PASSWORD is unset — an admin
   panel that opens because nobody configured a password is worse than one nobody
   can open. */
export function adminOk(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/* ---- order reference -------------------------------------------------------
   AUR-XXXXXX from a UUID. Not sequential: a guessable reference is the whole
   authorisation story on the customer-facing order page. The same string is
   also used as the one-off TagadaPay promotion code for the order's bundle
   discount (see _tagada.mjs), so its shape must stay promo-code safe. */
export function newRef() {
  return 'AUR-' + randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
}

/* ---- pricing ---------------------------------------------------------------
   Authoritative. Takes only identifiers from the client and rebuilds every number
   from the generated catalogue. Throws on anything it cannot resolve rather than
   silently dropping the line, because a dropped line is an under-charge. */
export function priceOrder(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty.');
  if (items.length > 40) throw new Error('Too many lines in one order.');

  const priced = items.map((line) => {
    const p = catalog[String(line.slug)];
    if (!p) throw new Error(`We no longer carry one of the items in your cart.`);
    if (p.soldOut) throw new Error(`${p.name} is sold out.`);

    const variant = p.variants.find((v) => String(v.mgKey) === String(line.variant));
    if (!variant) throw new Error(`That size of ${p.name} is unavailable.`);

    const bundle = p.bundles.find((b) => Number(b.qty) === Number(line.bundleQty));
    if (!bundle) throw new Error(`That bundle of ${p.name} is unavailable.`);

    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 25) {
      throw new Error(`Choose a quantity between 1 and 25 for ${p.name}.`);
    }

    const unit = money(variant.price * (1 - bundle.save));
    const lineTotal = money(unit * bundle.qty * qty);
    return {
      slug: p.slug, name: p.name,
      meta: bundle.qty > 1 ? `${variant.label} · ${bundle.label}` : variant.label,
      variant: variant.mgKey, bundleQty: bundle.qty, qty,
      unitPrice: unit, lineTotal,
    };
  });

  const subtotal = money(priced.reduce((s, l) => s + l.lineTotal, 0));
  const shipping = subtotal >= FREE_SHIP_OVER ? 0 : SHIP_FLAT;
  return { items: priced, subtotal, shipping, total: money(subtotal + shipping) };
}

