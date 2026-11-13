// PrymaLab supplier send: SKU map, payload, outcome mapping, the switch, the paid webhook,
// the hourly retry, the admin button and the tracking webhook. Blobs are stubbed in memory
// and every PrymaLab call goes to a fake fetch; nothing here reaches prymalab.net.
// Run with: npm test
import { register } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';

const mem = new Map();   // orders
const meta = new Map();  // prymalab-meta
const other = new Map(); // ratelimit, tagada-events
const makeStore = (m) => ({
  setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null),
  delete: async (k) => { m.delete(k); },
  list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }),
});
register(new URL('./_blobs-stub.mjs', import.meta.url));
globalThis.__FAKE_STORE__ = (name) => (name === 'orders' ? makeStore(mem) : name === 'prymalab-meta' ? makeStore(meta) : makeStore(other));

const BASE = new URL('../netlify/functions/', import.meta.url).href;
const P = await import(BASE + '_prymalab.mjs');
const catalog = (await import(BASE + '_catalog.json', { with: { type: 'json' } })).default.products;
const skuFile = (await import(BASE + '_prymalab-skus.json', { with: { type: 'json' } })).default;
const tagadaWebhook = (await import(BASE + 'tagada-webhook.mjs')).default;
const adminSend = (await import(BASE + 'admin-prymalab-send.mjs')).default;
const trackHook = (await import(BASE + 'prymalab-webhook.mjs')).default;
const { runRetry } = await import(BASE + 'prymalab-retry.mjs');
const retryDefault = (await import(BASE + 'prymalab-retry.mjs')).default;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, d)); };

/* ---- fake PrymaLab --------------------------------------------------------- */
const KEY = 'plk_test_KEY_must_never_leak_0123456789';
let calls = [];
let pl = {}; // per-path behaviour: (init) => Response
const resetPl = () => {
  calls = [];
  pl = {
    '/me': () => Response.json({ partner_id: '162', store_url: 'https://pureauraa.com' }),
    '/orders': (init) => {
      const b = JSON.parse(init.body);
      return Response.json({ order: { id: 'PL-9001', external_id: b.external_id, status: 'processing', items: b.items, payment: { status: 'paid', amount_paid: '41.50' } }, partner_cost: '41.50', shipping_charge: '8.00' }, { status: 201 });
    },
  };
};
resetPl();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://prymalab.net/')) {
    calls.push({ url: u, init });
    const path = u.replace(P.BASE, '');
    const h = pl[path];
    if (!h) return new Response('{}', { status: 404 });
    return h(init);
  }
  return new Response('{"id":"e"}', { status: 200 }); // emails etc.
};
const posts = () => calls.filter((c) => c.url.endsWith('/orders'));

let logs = [];
for (const k of ['log', 'warn', 'error']) {
  const orig = console[k];
  console[k] = (...a) => { logs.push(a.map(String).join(' ')); if (process.env.DEBUG || (k === 'log' && String(a[0]).startsWith('  '))) orig(...a); };
}
const say = (s) => process.stdout.write(s + '\n');

/* ---- helpers --------------------------------------------------------------- */
let n = 0;
const mkRef = () => 'AUR-T' + String(++n).padStart(5, '0');
const mkOrder = (patch = {}) => {
  const ref = mkRef();
  const o = {
    ref, createdAt: new Date().toISOString(), status: 'paid', paidAt: new Date().toISOString(),
    customer: { name: 'Acct Name', shipName: 'A Researcher', email: 'lab@example.com', phone: '+15550100',
      address1: '1 Test St', address2: 'Suite 2', city: 'Austin', state: 'TX', postal: '78701', country: 'US' },
    items: [{ slug: 'bpc-157', name: 'BPC-157', meta: '10 mg · Bundle of 3', variant: 10, bundleQty: 3, qty: 2, unitPrice: 71.99, lineTotal: 431.94 }],
    total: 431.94, totalFormatted: '$431.94', tracking: '',
    payment: { provider: 'tagadapay', orderId: 'o1', paymentId: 'p1', amountCents: 43194, draft: false },
    ...patch,
  };
  o.ref = ref;
  mem.set(ref, o);
  return ref;
};
const on = () => { process.env.PRYMALAB_SEND = 'on'; process.env.PRYMALAB_API_KEY = KEY; };
const off = () => { delete process.env.PRYMALAB_SEND; delete process.env.PRYMALAB_API_KEY; };
const store = { get: (k) => makeStore(mem).get(k), setJSON: (k, v) => makeStore(mem).setJSON(k, v), list: () => makeStore(mem).list() };

/* =========================================================================== */
say('\nPRYMALAB: SKU map');
const SPEC = {
  'bpc-157': { 5: 'BC5', 10: 'BC10' }, 'cjc-1295-dac': { 5: 'CD5' }, 'cjc-1295-no-dac': { 5: 'CND5' }, dsip: { 5: 'DS5' },
  epithalon: { 10: 'ET10', 50: 'ET50' }, 'ghk-cu': { 50: 'CU50', 100: 'CU100' }, glow: { 70: 'BBG70' }, klow: { 80: 'BBGK' },
  'glp-2-trz': { 10: 'TR10', 30: 'TR30', 60: 'TR60' }, 'glp-3-rt': { 10: 'RT10', 30: 'RT30', 60: 'RT60' }, 'mots-c': { 10: 'MS10' },
  nad: { 500: 'NJ500' }, tesamorelin: { 5: 'TSM5', 10: 'TSM10' }, 'thymosin-alpha-1': { 5: 'TA5', 10: 'TA10' },
  'bpc-157-tb-500': { 20: 'BB20' }, 'bac-water-10ml': { '10 mL': 'WA10' },
};
const flat = (o) => Object.entries(o).flatMap(([s, v]) => Object.entries(v).map(([k, sku]) => `${s}|${k}|${sku}`)).sort();
ok('data file equals the agreed SKU list exactly', JSON.stringify(flat(skuFile.skus)) === JSON.stringify(flat(SPEC)), flat(skuFile.skus).join(','));
const unknown = [];
const both = [];
for (const p of Object.values(catalog)) for (const v of p.variants) {
  const mapped = !!skuFile.skus[p.slug]?.[String(v.mgKey)];
  const held = (skuFile.notCarried[p.slug] || []).includes(String(v.mgKey));
  if (!mapped && !held) unknown.push(`${p.slug} ${v.mgKey}`);
  if (mapped && held) both.push(`${p.slug} ${v.mgKey}`);
}
ok('every catalog size is either mapped or listed as not carried', unknown.length === 0, unknown.join(', '));
ok('  no size is both', both.length === 0, both.join(', '));
for (const [s, k] of Object.entries(skuFile.skus).flatMap(([s, v]) => Object.keys(v).map((k) => [s, k]))) {
  if (!catalog[s]?.variants.some((v) => String(v.mgKey) === k)) unknown.push(`${s} ${k} not in catalog`);
}
ok('every mapped size exists in the catalog', unknown.length === 0, unknown.join(', '));

let m = P.mapItems([{ slug: 'bpc-157', variant: 10, bundleQty: 3, qty: 2 }]);
ok('bundle of 3, twice -> BC10 x6', m.lines.length === 1 && m.lines[0].sku === 'BC10' && m.lines[0].qty === 6 && !m.unmapped.length, JSON.stringify(m));
m = P.mapItems([{ slug: 'bac-water-10ml', variant: '10 mL', bundleQty: 5, qty: 1 }, { slug: 'glow', variant: 70, bundleQty: 1, qty: 1 }]);
ok('bundle of 5 water + GLOW -> WA10 x5, BBG70 x1', JSON.stringify(m.lines) === JSON.stringify([{ sku: 'WA10', qty: 5 }, { sku: 'BBG70', qty: 1 }]), JSON.stringify(m.lines));
m = P.mapItems([{ slug: 'bpc-157', variant: 5, bundleQty: 1, qty: 1 }, { slug: 'bpc-157', variant: 5, bundleQty: 3, qty: 1 }]);
ok('same SKU on two lines merges -> BC5 x4', m.lines.length === 1 && m.lines[0].qty === 4, JSON.stringify(m.lines));
for (const [slug, variant] of [['mots-c', 30], ['mots-c', 60], ['nad', 100], ['tesamorelin', 20], ['ahk-cu', 50], ['bac-water-30ml', '30 mL'], ['acetic-acid', '3 mL ×10'], ['bpc-157-tb-500', 40]]) {
  m = P.mapItems([{ slug: 'bpc-157', variant: 10, bundleQty: 1, qty: 1 }, { slug, name: slug, variant, bundleQty: 1, qty: 1 }]);
  ok(`${slug} ${variant} is unmapped`, m.unmapped.length === 1, JSON.stringify(m));
}

/* =========================================================================== */
say('\nPRYMALAB: payload carries nothing beyond ship_to');
const ref0 = mkOrder();
const body0 = P.orderBody(ref0, P.shipToOf(mem.get(ref0)), P.mapItems(mem.get(ref0).items).lines);
ok('top-level keys are external_id, ship_to, items only', JSON.stringify(Object.keys(body0)) === '["external_id","ship_to","items"]', Object.keys(body0));
ok('ship_to keys are the documented ones', JSON.stringify(Object.keys(body0.ship_to)) === '["name","address_1","address_2","city","state","postcode","country"]', Object.keys(body0.ship_to));
ok('ship_to name is the parcel name', body0.ship_to.name === 'A Researcher', body0.ship_to.name);
const raw0 = JSON.stringify(body0);
ok('no email, phone, price or payment id in the body', !/lab@example|5550100|71\.99|431|43194|"p1"|"o1"/.test(raw0), raw0);
ok('items are sku + quantity only', JSON.stringify(body0.items) === '[{"sku":"BC10","quantity":6}]', JSON.stringify(body0.items));
ok('external_id is the store order reference', body0.external_id === ref0);

/* =========================================================================== */
say('\nPRYMALAB: outcome per answer');
const L = [{ sku: 'BC10', qty: 6 }];
const R = 'AUR-ABC123';
const echo = (status, extra = {}, pay = { status: 'paid' }) => ({ status, data: { order: { id: 'PL-1', external_id: R, status: 'processing', items: [{ sku: 'BC10', quantity: 6 }], payment: pay, ...extra } } });
let o = P.outcome(echo(201), { ref: R, lines: L });
ok('201 paid -> submitted', o.state === 'submitted' && o.supplier_order_id === 'PL-1', JSON.stringify(o));
o = P.outcome(echo(200), { ref: R, lines: L });
ok('200 repeat -> submitted, says not created or charged twice', o.state === 'submitted' && o.detail.includes('not created or charged twice'), o.detail);
for (const s of ['terms', 'terms_due', 'none']) ok(`payment ${s} -> submitted`, P.outcome(echo(201, {}, { status: s }), { ref: R, lines: L }).state === 'submitted');
o = P.outcome(echo(201, {}, { status: 'unpaid', amount_due: '41.50' }), { ref: R, lines: L });
ok('201 unpaid -> held_balance with amount due', o.state === 'held_balance' && o.detail.includes('$41.50'), o.detail);
ok('201 without payment -> held_balance', P.outcome(echo(201, {}, null), { ref: R, lines: L }).state === 'held_balance');
ok('echoed different external_id -> conflict', P.outcome(echo(201, { external_id: 'AUR-ZZZ999' }), { ref: R, lines: L }).state === 'conflict');
ok('echoed different items -> conflict', P.outcome(echo(201, { items: [{ sku: 'BC5', quantity: 6 }] }), { ref: R, lines: L }).state === 'conflict');
ok('held as cancelled -> supplier_cancelled', P.outcome(echo(200, { status: 'cancelled' }), { ref: R, lines: L }).state === 'supplier_cancelled');
o = P.outcome({ status: 401, data: { error: 'bad key plk_abcdefSECRET' } }, { ref: R, lines: L });
ok('401 -> key_rejected', o.state === 'key_rejected', o.state);
ok('  a key echoed in the error is masked', !o.detail.includes('plk_abcdef') && o.detail.includes('[hidden]'), o.detail);
o = P.outcome({ status: 422, data: { code: 'no_address' } }, { ref: R, lines: L });
ok('422 -> rejected (no_address advice)', o.state === 'rejected' && o.detail.includes('delivery address'), o.detail);
for (const s of [429, 500, 502, 503]) ok(`${s} -> retrying`, P.outcome({ status: s, data: null }, { ref: R, lines: L }).state === 'retrying');
ok('network error -> retrying', P.outcome({ error: 'no answer within 6 seconds' }, { ref: R, lines: L }).state === 'retrying');
ok('302 redirect -> failed, not followed', P.outcome({ status: 302, data: null }, { ref: R, lines: L }).state === 'failed');
for (const s of [400, 403, 404]) ok(`${s} -> failed`, P.outcome({ status: s, data: null }, { ref: R, lines: L }).state === 'failed');
const allText = [echo(201), echo(200), { status: 401, data: {} }, { status: 422, data: {} }, { status: 500 }, { status: 302 }, { error: 'x' }]
  .map((r) => P.outcome(r, { ref: R, lines: L }).detail).join(' ');
ok('no em dash in any outcome text', !allText.includes('—'));

/* =========================================================================== */
say('\nPRYMALAB: the switch');
off();
let refA = mkOrder();
let before = JSON.stringify(mem.get(refA));
let res = await P.sendToPrymalab(store, refA, { via: 'admin' });
ok('switch unset -> nothing sent', res.sent === false && res.skipped === 'off' && calls.length === 0, JSON.stringify(res));
ok('  order untouched', JSON.stringify(mem.get(refA)) === before);
for (const v of ['ON', 'true', '1', 'yes', ' on-ish']) {
  process.env.PRYMALAB_SEND = v; process.env.PRYMALAB_API_KEY = KEY;
  res = await P.sendToPrymalab(store, refA, { via: 'admin' });
  ok(`PRYMALAB_SEND="${v}" -> off`, res.skipped === 'off' && calls.length === 0);
}
process.env.PRYMALAB_SEND = 'on'; delete process.env.PRYMALAB_API_KEY;
res = await P.sendToPrymalab(store, refA, { via: 'admin' });
ok('switch on but no key -> nothing sent', res.skipped === 'off' && calls.length === 0, JSON.stringify(res));
ok('  order untouched', JSON.stringify(mem.get(refA)) === before);
ok('  nothing stamped as the sending start', meta.size === 0, meta.size);
const r0 = await runRetry();
ok('hourly retry with switch off reads and sends nothing', r0.off === true && calls.length === 0, JSON.stringify(r0));

/* =========================================================================== */
say('\nPRYMALAB: a send, and the same order again');
on(); resetPl(); logs = [];
res = await P.sendToPrymalab(store, refA, { via: 'paid-webhook' });
ok('sent -> submitted', res.sent && res.state === 'submitted', JSON.stringify(res));
ok('  asked /me first, then POST /orders', calls.length === 2 && calls[0].url === P.BASE + '/me' && calls[1].url === P.BASE + '/orders', calls.map((c) => c.url));
ok('  documented host only, redirects not followed', calls.every((c) => c.url.startsWith('https://prymalab.net/wp-json/prymalab/v1/') && c.init.redirect === 'manual'));
ok('  bearer key header', calls[1].init.headers.authorization === 'Bearer ' + KEY);
const sentBody = JSON.parse(calls[1].init.body);
ok('  body: external_id = order ref, BC10 x6', sentBody.external_id === refA && sentBody.items[0].quantity === 6);
const rec = mem.get(refA).prymalab;
ok('  recorded on the order: id, state, detail, charged', rec.state === 'submitted' && rec.supplier_order_id === 'PL-9001' && rec.detail && rec.charged?.partner_cost_cents === 4150, JSON.stringify(rec));
ok('  order status unchanged (still paid)', mem.get(refA).status === 'paid');
ok('  the key is nowhere in the order, the result or the logs',
  !JSON.stringify(mem.get(refA)).includes(KEY) && !JSON.stringify(res).includes(KEY) && !logs.join('\n').includes(KEY) && !logs.join('\n').includes('plk_'));
ok('  no address in the logs', !logs.join('\n').includes('1 Test St'));
calls = [];
res = await P.sendToPrymalab(store, refA, { via: 'admin' });
ok('already submitted -> not sent again', res.sent === false && res.skipped === 'already' && calls.length === 0, JSON.stringify(res));

// The same external_id again after a lost answer: PrymaLab answers 200 with the order it already has.
const refB = mkOrder();
resetPl();
pl['/orders'] = () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); };
res = await P.sendToPrymalab(store, refB, { via: 'paid-webhook' });
ok('lost answer -> retrying', res.state === 'retrying', JSON.stringify(res));
resetPl();
pl['/orders'] = (init) => { const b = JSON.parse(init.body); return Response.json({ duplicate: true, order: { id: 'PL-9002', external_id: b.external_id, items: b.items, payment: { status: 'paid' } } }, { status: 200 }); };
res = await P.sendToPrymalab(store, refB, { via: 'retry', requireRecord: true });
ok('retry sends the SAME external_id', JSON.parse(posts()[0].init.body).external_id === refB);
ok('  200 repeat -> submitted, not twice', res.state === 'submitted' && mem.get(refB).prymalab.detail.includes('not created or charged twice'), mem.get(refB).prymalab.detail);
ok('  firstAt kept from the first try, attempts logged', mem.get(refB).prymalab.attempts.length === 2);

/* =========================================================================== */
say('\nPRYMALAB: holds');
resetPl();
const refU = mkOrder({ items: [{ slug: 'bpc-157', name: 'BPC-157', meta: '10 mg', variant: 10, bundleQty: 1, qty: 1 }, { slug: 'mots-c', name: 'MOTS-c', meta: '30 mg', variant: 30, bundleQty: 1, qty: 1 }] });
res = await P.sendToPrymalab(store, refU, { via: 'paid-webhook' });
ok('an unmapped size holds the whole order, nothing sent', res.state === 'held' && calls.length === 0, JSON.stringify(res));
ok('  admin sees why (names the item)', mem.get(refU).prymalab.detail.includes('MOTS-c') && mem.get(refU).prymalab.unmapped.length === 1, mem.get(refU).prymalab.detail);
const refD = mkOrder({ payment: { draft: true } });
res = await P.sendToPrymalab(store, refD, { via: 'paid-webhook' });
ok('a TagadaPay test payment is never sent', res.state === 'held' && calls.length === 0 && mem.get(refD).prymalab.detail.includes('test payment'));
const refNA = mkOrder({ customer: { name: 'X', email: 'a@b.co', address1: '', city: 'Austin', state: 'TX', postal: '78701', country: 'US' } });
res = await P.sendToPrymalab(store, refNA, { via: 'paid-webhook' });
ok('a missing street holds, nothing sent', res.state === 'held' && calls.length === 0 && mem.get(refNA).prymalab.detail.includes('street'), mem.get(refNA).prymalab?.detail);
pl['/me'] = () => Response.json({ partner_id: '999' });
const refW = mkOrder();
res = await P.sendToPrymalab(store, refW, { via: 'paid-webhook' });
ok('a key that belongs to another account holds, no order posted', res.state === 'held' && posts().length === 0, JSON.stringify(res));
pl['/me'] = () => Response.json({ partner_id: '162', store_url: 'https://other-brand.com' });
calls = [];
res = await P.sendToPrymalab(store, mkOrder(), { via: 'paid-webhook' });
ok('a key registered to another store holds', res.state === 'held' && posts().length === 0, JSON.stringify(res));
pl['/me'] = () => new Response('{}', { status: 401 });
calls = [];
res = await P.sendToPrymalab(store, mkOrder(), { via: 'paid-webhook' });
ok('/me 401 -> key_rejected, no order posted', res.state === 'key_rejected' && posts().length === 0);
resetPl();
for (const [label, patch] of [['not paid', { status: 'payment_review' }], ['refunded', { status: 'refunded' }], ['has tracking', { tracking: '1Z' }], ['shipped', { status: 'shipped' }]]) {
  res = await P.sendToPrymalab(store, mkOrder(patch), { via: 'paid-webhook' });
  ok(`${label} -> not sent`, res.sent === false && calls.length === 0, JSON.stringify(res));
}

/* =========================================================================== */
say('\nTAGADA WEBHOOK: paid order goes to PrymaLab, and its failure never fails the webhook');
const TSECRET = 'whsec_t';
process.env.TAGADA_WEBHOOK_SECRET = TSECRET;
const signT = (raw) => 'sha256=' + createHmac('sha256', TSECRET).update(raw, 'utf8').digest('hex');
const deliverT = (ev) => { const raw = JSON.stringify(ev); return tagadaWebhook(new Request('https://x/wh', { method: 'POST', headers: { 'x-tagadapay-signature': signT(raw) }, body: raw })); };
const paidEv = (ref, cents) => ({ id: randomUUID(), type: 'order/paid', createdAt: new Date().toISOString(),
  data: { orderId: 'otp', paymentId: 'ptp', draft: false, order_metadata: { orderRef: ref },
    order: { orderNumber: 7, currency: 'USD', paidAmount: cents, totalAdjustedAmount: cents, paidAt: new Date().toISOString(),
      shippingAddress: { firstName: 'Parcel', lastName: 'Person', address1: '9 Lab Rd', city: 'Boise', state: 'ID', postal: '83702', country: 'US', phone: '+15550199' } } } });
const pending = (patch = {}) => mkOrder({ status: 'pending_payment', paidAt: undefined, payment: undefined, customer: { name: 'Acct Name', email: 'lab@example.com' }, ...patch });

resetPl();
let refT = pending();
let r = await deliverT(paidEv(refT, 43194)); let j = await r.json();
ok('paid -> 200 paid', r.status === 200 && j.status === 'paid', JSON.stringify(j));
ok('  PrymaLab got it: submitted', mem.get(refT).prymalab?.state === 'submitted', JSON.stringify(mem.get(refT).prymalab));
ok('  shipped to the TagadaPay parcel name and address', JSON.parse(posts()[0].init.body).ship_to.name === 'Parcel Person' && JSON.parse(posts()[0].init.body).ship_to.address_1 === '9 Lab Rd');
ok('  order still paid (not shipped until tracking)', mem.get(refT).status === 'paid');

resetPl();
pl['/orders'] = () => new Response('oops', { status: 500 });
refT = pending();
r = await deliverT(paidEv(refT, 43194)); j = await r.json();
ok('PrymaLab 500 -> webhook still 200 paid', r.status === 200 && j.status === 'paid' && mem.get(refT).status === 'paid', JSON.stringify(j));
ok('  queued as retrying', mem.get(refT).prymalab.state === 'retrying');

resetPl();
pl['/me'] = (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
refT = pending();
const t0 = Date.now();
const keepAlive = setInterval(() => {}, 500); // AbortSignal.timeout timers are unref'd; a live request keeps the process up on Netlify
r = await deliverT(paidEv(refT, 43194)); j = await r.json();
clearInterval(keepAlive);
const took = Date.now() - t0;
ok(`PrymaLab hangs -> webhook answers within its budget (${took} ms)`, r.status === 200 && j.status === 'paid' && took < 5000, took);
ok('  queued as retrying', mem.get(refT).prymalab.state === 'retrying');

resetPl(); off();
refT = pending();
r = await deliverT(paidEv(refT, 43194)); j = await r.json();
ok('switch off -> webhook 200 paid, no PrymaLab call, no record', r.status === 200 && j.status === 'paid' && calls.length === 0 && !mem.get(refT).prymalab);
on();
r = await deliverT(paidEv(refT, 43194)); j = await r.json();
ok('a repeat paid event for a settled order sends nothing (no backfill on replay)', j.already === 'paid' && calls.length === 0, JSON.stringify(j));

/* =========================================================================== */
say('\nHOURLY RETRY');
resetPl();
for (const k of [...mem.keys()]) mem.delete(k);
const fresh = mkOrder({ prymalab: { state: 'held_balance', firstAt: new Date().toISOString(), detail: 'x' } });
const old = mkOrder({ prymalab: { state: 'retrying', firstAt: new Date(Date.now() - 4 * 86400000).toISOString(), detail: 'last' } });
const done = mkOrder({ prymalab: { state: 'submitted', firstAt: new Date().toISOString() } });
const heldU = mkOrder({ prymalab: { state: 'held', firstAt: new Date().toISOString() } });
const refunded = mkOrder({ status: 'refunded', prymalab: { state: 'retrying', firstAt: new Date().toISOString() } });
const untracked = mkOrder(); // paid, never queued: no backfill
const rr = await runRetry();
ok('retries only the queued, in-window, paid order', rr.tried === 1 && posts().length === 1 && JSON.parse(posts()[0].init.body).external_id === fresh, JSON.stringify(rr));
ok('  it is now submitted', mem.get(fresh).prymalab.state === 'submitted');
ok('  older than 3 days -> stopped, not sent', mem.get(old).prymalab.state === 'stopped' && mem.get(old).prymalab.detail.includes('3 days'));
ok('  submitted, held, refunded and never-queued orders untouched', mem.get(done).prymalab.state === 'submitted' && mem.get(heldU).prymalab.state === 'held' && mem.get(refunded).prymalab.state === 'retrying' && !mem.get(untracked).prymalab);
const rd = await retryDefault();
ok('scheduled handler answers 204', rd.status === 204);

/* =========================================================================== */
say('\nADMIN: Send to PrymaLab');
process.env.ADMIN_PASSWORD = 'test-password';
const AUTH = { authorization: 'Bearer test-password' };
const adm = (body, headers = {}) => adminSend(new Request('https://x/api/admin/orders/prymalab', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
resetPl();
const refH = mkOrder({ prymalab: { state: 'stopped', firstAt: new Date().toISOString() } });
r = await adm({ ref: refH });
ok('no password -> 401, nothing sent', r.status === 401 && calls.length === 0, r.status);
r = await adm({ ref: refH }, { authorization: 'Bearer wrong' });
ok('wrong password -> 401', r.status === 401 && calls.length === 0, r.status);
r = await adminSend(new Request('https://x', { method: 'GET' }));
ok('GET -> 405', r.status === 405);
r = await adm({ ref: '../etc' }, AUTH);
ok('malformed ref -> 400', r.status === 400);
off();
before = JSON.stringify(mem.get(refH));
r = await adm({ ref: refH }, AUTH); j = await r.json();
ok('switch off -> 409 and the order is unchanged', r.status === 409 && j.skipped === 'off' && JSON.stringify(mem.get(refH)) === before && calls.length === 0, JSON.stringify(j));
on();
r = await adm({ ref: refH }, AUTH); j = await r.json();
ok('held order -> sent, 200 submitted', r.status === 200 && j.state === 'submitted' && mem.get(refH).prymalab.state === 'submitted', JSON.stringify(j).slice(0, 200));
ok('  reply never carries the key', !JSON.stringify(j).includes(KEY));
calls = [];
r = await adm({ ref: refH }, AUTH); j = await r.json();
ok('again -> 409 already with PrymaLab', r.status === 409 && j.skipped === 'already' && calls.length === 0);
meta.set('since', { at: new Date(Date.now() - 60000).toISOString() });
const preStart = mkOrder({ createdAt: new Date(Date.now() - 86400000).toISOString(), paidAt: new Date(Date.now() - 86400000).toISOString() });
r = await adm({ ref: preStart }, AUTH); j = await r.json();
ok('an order paid before sending began -> 409, never backfilled', r.status === 409 && j.skipped === 'before_start' && calls.length === 0, JSON.stringify(j));

/* =========================================================================== */
say('\nPRYMALAB WEBHOOK: tracking');
const WSECRET = 'abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd';
const signP = (raw, s = WSECRET) => createHmac('sha256', s).update(raw, 'utf8').digest('hex');
const deliverP = (ev, { sig, event = 'order.fulfilled' } = {}) => {
  const raw = JSON.stringify(ev);
  return trackHook(new Request('https://x/api/webhooks/prymalab', { method: 'POST', headers: { 'x-prymalab-signature': sig ?? signP(raw), 'x-prymalab-event': event }, body: raw }));
};
const fulfilled = (ref, extra = {}) => ({ event: 'order.fulfilled', partner_id: '162', data: { order: { id: 'PL-9001', external_id: ref, status: 'fulfilled', carrier: 'USPS', tracking_number: '9400TEST', shipped_at: new Date().toISOString(), ...extra } } });
const refS = mkOrder({ prymalab: { state: 'submitted', supplier_order_id: 'PL-9001', firstAt: new Date().toISOString() } });
delete process.env.PRYMALAB_WEBHOOK_SECRET;
r = await deliverP(fulfilled(refS));
ok('no secret -> 503, nothing changed', r.status === 503 && mem.get(refS).status === 'paid', r.status);
process.env.PRYMALAB_WEBHOOK_SECRET = WSECRET;
r = await deliverP(fulfilled(refS), { sig: '0'.repeat(64) });
ok('bad signature -> 401', r.status === 401 && !mem.get(refS).tracking, r.status);
r = await deliverP(fulfilled(refS), { sig: signP(JSON.stringify(fulfilled(refS)), 'wrong-secret') });
ok('signed with the wrong secret -> 401', r.status === 401 && !mem.get(refS).tracking, r.status);
r = await deliverP(fulfilled(refS), { sig: '' });
ok('no signature -> 401', r.status === 401);
r = await trackHook(new Request('https://x', { method: 'GET' }));
ok('GET -> 405', r.status === 405);
r = await deliverP({ ...fulfilled(refS), partner_id: '163' }); j = await r.json();
ok('another account -> ignored', j.ignored === 'another account' && !mem.get(refS).tracking);
r = await deliverP(fulfilled(refS, { id: 'PL-OTHER' })); j = await r.json();
ok('another supplier order id -> ignored', j.ignored === 'another supplier order' && !mem.get(refS).tracking);
const refNot = mkOrder();
r = await deliverP(fulfilled(refNot)); j = await r.json();
ok('an order this store never sent -> ignored', j.ignored === 'not an order this store sent' && !mem.get(refNot).tracking);
r = await deliverP(fulfilled(refS)); j = await r.json();
ok('verified fulfilled -> tracking written, order shipped', r.status === 200 && j.shipped === true && mem.get(refS).tracking === '9400TEST' && mem.get(refS).status === 'shipped', JSON.stringify(j));
r = await deliverP(fulfilled(refS, { tracking_number: 'SECOND' })); j = await r.json();
ok('a second tracking event never overwrites (written once)', j.shipped === false && mem.get(refS).tracking === '9400TEST');
const refHB = mkOrder({ prymalab: { state: 'held_balance', supplier_order_id: 'PL-9001', firstAt: new Date().toISOString() } });
r = await deliverP({ partner_id: '162', data: { order: { id: 'PL-9001', external_id: refHB, status: 'processing' } } }, { event: 'order.processing' });
ok('processing on a balance-held order -> submitted (leaves the retry queue)', mem.get(refHB).prymalab.state === 'submitted' && mem.get(refHB).status === 'paid');
const refC = mkOrder({ prymalab: { state: 'submitted', supplier_order_id: 'PL-9001', firstAt: new Date().toISOString() } });
r = await deliverP({ partner_id: '162', data: { order: { id: 'PL-9001', external_id: refC, status: 'cancelled' } } }, { event: 'order.cancelled' });
ok('cancelled -> supplier_cancelled, order not shipped', mem.get(refC).prymalab.state === 'supplier_cancelled' && mem.get(refC).status === 'paid' && !mem.get(refC).tracking);

const refRt = mkOrder({ prymalab: { state: 'retrying', firstAt: new Date().toISOString() } });
r = await deliverP(fulfilled(refRt)); j = await r.json();
ok('tracking for an order whose answer was lost (retrying) is accepted, leaves the queue', j.shipped === true && mem.get(refRt).prymalab.state === 'submitted' && mem.get(refRt).prymalab.supplier_order_id === 'PL-9001');
const refHeld = mkOrder({ prymalab: { state: 'held', firstAt: new Date().toISOString() } });
r = await deliverP(fulfilled(refHeld)); j = await r.json();
ok('tracking for a held (never sent) order is ignored', j.ignored === 'not an order this store sent' && !mem.get(refHeld).tracking);

globalThis.fetch = realFetch;
say(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
