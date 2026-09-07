// Shared server helpers: pricing, admin auth, order storage, payment instructions.
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
   authorisation story on the customer-facing order page. */
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

/* ---- payment instructions --------------------------------------------------
   Built from env, never committed. Only methods that are actually configured are
   offered. If NOTHING is configured the caller refuses the order: taking money-less
   orders leaves the buyer with no way to pay and the owner with phantom rows.

   Variable names follow /guide/ ("Environment variables") so the documentation on
   the site and the code agree. The shorter aliases are accepted too, because the
   cost of a silent typo here is an order screen with no way to pay on it. */
const env = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return '';
};

export function paymentMethods() {
  const methods = [];

  /* The network is configurable and shown next to every address. Sending USDT to
     an ERC-20 address over TRC-20 (or the reverse) destroys the funds, so the
     chain the owner actually holds must win over any default we pick. */
  const coins = [
    /* The screen prints "<label> · <network>", so BTC's default is "On-chain"
       rather than "Bitcoin": it avoids "Bitcoin · Bitcoin" and still tells the
       buyer this is not Lightning and not a wrapped BTC on another chain. */
    ['BTC',  'Bitcoin',  env('CRYPTO_BTC_NETWORK') || 'On-chain',
             env('CRYPTO_BTC_ADDRESS', 'CRYPTO_BTC')],
    ['ETH',  'Ethereum', env('CRYPTO_ETH_NETWORK') || 'ERC-20',
             env('CRYPTO_ETH_ADDRESS', 'CRYPTO_ETH')],
    ['USDT', 'Tether',   env('CRYPTO_USDT_NETWORK') || 'TRC-20',
             env('CRYPTO_USDT_ADDRESS', 'CRYPTO_USDT_TRC20')],
    ['USDC', 'USD Coin', env('CRYPTO_USDC_NETWORK') || 'ERC-20',
             env('CRYPTO_USDC_ADDRESS', 'CRYPTO_USDC_ERC20')],
  ]
    .filter(([, , , address]) => address)
    .map(([code, label, network, address]) => ({ code, label, network, address, qr: '' }));

  if (coins.length) methods.push({ id: 'crypto', label: 'Crypto', coins });

  const handle = env('CASHAPP_CASHTAG', 'CASHAPP_HANDLE');
  if (handle) {
    methods.push({
      id: 'cashapp', label: 'Cash App',
      name: env('CASHAPP_NAME') || 'Aurum Peptides',
      handle: handle.startsWith('$') ? handle : '$' + handle,
      qr: '',
    });
  }

  /* The order screen has always been able to render Zelle; it just was never fed. */
  const zelle = env('ZELLE_CONTACT');
  if (zelle) {
    methods.push({
      id: 'zelle', label: 'Zelle',
      name: env('ZELLE_NAME') || 'Aurum Peptides',
      handle: zelle,
      qr: '',
    });
  }

  return methods;
}
