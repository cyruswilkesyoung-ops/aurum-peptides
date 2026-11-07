// The order endpoints and the TagadaPay webhook, driven over real Request objects.
// Netlify Blobs is stubbed in memory so the write path runs off-platform; the
// TagadaPay hand-off is stubbed via globalThis.__TAGADA_STUB__ (orders.mjs checks
// for it the same way _lib.mjs checks __FAKE_STORE__). The webhook is NOT stubbed:
// its HMAC verification runs for real against signed test payloads.
// Run with: npm test
import { register } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';

const mem = new Map();          // orders
const rl  = new Map();          // rate-limit counters
const evts = new Map();         // webhook event ledger
const makeStore = (m) => ({
  setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => (m.has(k) ? m.get(k) : null),
  delete: async (k) => { m.delete(k); },
  list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }),
});
const fakeStore = (name) =>
  name === 'ratelimit' ? makeStore(rl) : name === 'tagada-events' ? makeStore(evts) : makeStore(mem);
register(new URL('./_blobs-stub.mjs', import.meta.url));
globalThis.__FAKE_STORE__ = fakeStore;
const resetLimits = () => rl.clear();

const BASE = new URL('../netlify/functions/', import.meta.url).href;
const orders = (await import(BASE + 'orders.mjs')).default;
const orderStatus = (await import(BASE + 'order-status.mjs')).default;
const webhook = (await import(BASE + 'tagada-webhook.mjs')).default;
const adminList = (await import(BASE + 'admin-orders.mjs')).default;
const adminUpd = (await import(BASE + 'admin-orders-update.mjs')).default;

// The catalog is account-gated, so /api/orders requires a customer session.
// Tests sign one exactly the way auth.mts does.
process.env.AUTH_SESSION_SECRET = 'test-session-secret';
const { signSession, SESSION_COOKIE } = await import(BASE + '_session.mjs');
const SESSION = {
  cookie: `${SESSION_COOKIE}=${encodeURIComponent(signSession({ id: 1, email: 'lab@example.com', name: 'A Researcher' }))}`,
};

let pass = 0, fail = 0;
const ok = (n, c, d='') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, d)); };
const post = (h, body, headers={}) => h(new Request('https://x/api', {
  method:'POST', headers:{ 'content-type':'application/json', ...SESSION, ...headers }, body: JSON.stringify(body) }));

const good = {
  name:'A Researcher', email:'lab@example.com', notes:'', company:'',
  ageConfirm:true, researchConfirm:true,
  items:[{ slug:'bpc-157', variant:10, bundleQty:3, qty:1 }],
};

/* The TagadaPay hand-off is stubbed to succeed unless a test says otherwise.
   stubCalls records what orders.mjs passed in so the metadata contract
   (ref in the session, shipping pinned) is pinned by assertions. */
let stubCalls = [];
let stubImpl = async (order) => ({
  url: `https://pay.example/checkout?o=${order.ref}`,
  funnelSessionId: 'fs_test',
  checkoutToken: 'ct_test',
  promotionId: order.subtotal * 100 < 0 ? null : 'promo_test',
  discountCents: 2400,
  shippingCents: 0,
});
globalThis.__TAGADA_STUB__ = (order, opts) => { stubCalls.push({ order, opts }); return stubImpl(order); };

process.env.ADMIN_PASSWORD = 'test-password';
delete process.env.TAGADA_WEBHOOK_SECRET;

console.log('\nORDERS — account gate');
let r = await post(orders, good, { cookie: '' }); let j = await r.json();
ok('no session -> 401', r.status === 401 && j.ok === false, r.status);
r = await post(orders, good, { cookie: `${SESSION_COOKIE}=tampered.token` }); j = await r.json();
ok('bad session -> 401', r.status === 401 && j.ok === false, r.status);
ok('  nothing was persisted', mem.size === 0, mem.size);

resetLimits();
console.log('\nORDERS — validation');
r = await post(orders, { ...good, company:'spambot' }); j = await r.json();
ok('honeypot -> 200 with generic failure', r.status === 200 && j.ok === false, r.status);
ok('  honeypot order not persisted', mem.size === 0, mem.size);

for (const [name, patch, expect] of [
  ['missing age consent',   { ageConfirm:false },      '21 or older'],
  ['missing RUO consent',   { researchConfirm:false }, 'research-use'],
  ['blank required field',  { name:'' },               'every required field'],
  ['malformed email',       { email:'not-an-email' },  'does not look right'],
  ['empty cart',            { items:[] },              'empty'],
  ['unknown product',       { items:[{slug:'nope',variant:1,bundleQty:1,qty:1}] }, 'no longer carry'],
]) {
  r = await post(orders, { ...good, ...patch }); j = await r.json();
  ok(name + ' -> 400', r.status === 400 && j.error.includes(expect), `${r.status} ${j.error}`);
}
ok('no invalid order reached storage', mem.size === 0, mem.size);
ok('no invalid order reached TagadaPay', stubCalls.length === 0, stubCalls.length);

resetLimits();
console.log('\nORDERS — the happy path hands off to TagadaPay');
r = await post(orders, good); j = await r.json();
ok('200 ok', r.status === 200 && j.ok === true, r.status);
ok('  ref shape', /^AUR-[A-Z0-9]{6}$/.test(j.order.ref), j.order.ref);
ok('  total is server-computed 215.97', j.order.total === 215.97, j.order.total);
ok('  redirect url returned', j.url === `https://pay.example/checkout?o=${j.order.ref}`, j.url);
ok('  persisted exactly one order', mem.size === 1, mem.size);
const ref = j.order.ref;
const stored = mem.get(ref);
ok('  stored status is pending_payment', stored.status === 'pending_payment');
ok('  stored item carries name/meta/lineTotal for admin',
   stored.items[0].name === 'BPC-157' && stored.items[0].meta === '10 mg · Bundle of 3'
   && stored.items[0].lineTotal === 215.97);
ok('  tagada hand-off recorded on the order',
   stored.tagada?.checkoutToken === 'ct_test' && stored.tagada?.funnelSessionId === 'fs_test', JSON.stringify(stored.tagada));
ok('  hand-off received the origin and the buyer',
   stubCalls[0].opts.origin === 'https://x' && stubCalls[0].opts.customer.email === 'lab@example.com',
   JSON.stringify(stubCalls[0].opts));
ok('  hand-off received server-priced items, not the client cart',
   stubCalls[0].order.items[0].unitPrice === 71.99, stubCalls[0].order.items[0].unitPrice);

resetLimits();
console.log('\nORDERS — a failed hand-off never strands a pending row');
const { CheckoutUnavailable } = await import(BASE + '_tagada.mjs');
stubImpl = async () => { throw new CheckoutUnavailable('We could not reach our payment provider. Please try again.', { retryable: true, status: 502 }); };
r = await post(orders, good); j = await r.json();
ok('hand-off failure -> 502 with the buyer-facing message', r.status === 502 && j.error.includes('payment provider'), `${r.status} ${j.error}`);
ok('  marked retryable so the page offers "try again"', j.retryable === true, j.retryable);
ok('  the order row was removed again', mem.size === 1, mem.size);
stubImpl = async () => { throw new CheckoutUnavailable('Online payment is not configured yet. Please contact support.', { retryable: false, status: 503 }); };
r = await post(orders, good); j = await r.json();
ok('config failure -> 503, not retryable', r.status === 503 && j.retryable === false, r.status);
stubImpl = async (order) => ({ url: `https://pay.example/checkout?o=${order.ref}`, funnelSessionId: 'fs_test', checkoutToken: 'ct_test', promotionId: null, discountCents: 2400, shippingCents: 0 });

resetLimits();
console.log('\nORDER STATUS — what the thank-you page may see');
const get = (url, headers={}) => orderStatus(new Request(url, { method:'GET', headers: { ...SESSION, ...headers } }));
r = await get(`https://x/api/order-status?ref=${ref}`, { cookie: '' });
ok('no session -> 401', r.status === 401, r.status);
r = await get('https://x/api/order-status?ref=../etc');
ok('malformed ref -> 400', r.status === 400, r.status);
r = await get('https://x/api/order-status?ref=AUR-ZZZZZZ');
ok('unknown ref -> 404', r.status === 404, r.status);
r = await get(`https://x/api/order-status?ref=${ref}`); j = await r.json();
ok('known ref -> status + total', j.ok && j.order.status === 'pending_payment' && j.order.totalFormatted === '$215.97', JSON.stringify(j.order));
ok('  no address or payment internals leak', !('customer' in j.order) && !('tagada' in j.order) && !('payment' in j.order));

/* ===========================================================================
   WEBHOOK — signature, replay, idempotency, amount check, status transitions.
   =========================================================================== */
console.log('\nWEBHOOK — authentication');
const SECRET = 'whsec_test_secret';
const sign = (raw, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
const deliver = (event, { secret, mangle } = {}) => {
  const raw = JSON.stringify(event);
  return webhook(new Request('https://x/.netlify/functions/tagada-webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tagadapay-signature': mangle || sign(raw, secret || SECRET) },
    body: raw,
  }));
};
const paidEvent = (orderRef, cents, extra = {}) => ({
  id: randomUUID(),
  type: 'order/paid',
  createdAt: new Date().toISOString(),
  data: {
    orderId: 'order_tp1', paymentId: 'pay_tp1', draft: false,
    order_metadata: { cartCustomAttributes: [{ name: 'orderRef', value: orderRef }] },
    order: {
      status: 'paid', orderNumber: 1042, currency: 'USD',
      paidAmount: cents, totalAdjustedAmount: cents, paidAt: new Date().toISOString(),
      shippingAddress: { firstName: 'A', lastName: 'Researcher', address1: '1 Test St', address2: '',
        city: 'Austin', state: 'TX', postal: '78701', country: 'US', phone: '+15550100' },
    },
    ...extra,
  },
});

r = await webhook(new Request('https://x/wh', { method: 'GET' }));
ok('rejects GET', r.status === 405, r.status);
r = await deliver(paidEvent(ref, 21597));
ok('no secret configured -> 503 so TagadaPay retries', r.status === 503, r.status);

process.env.TAGADA_WEBHOOK_SECRET = SECRET;
r = await deliver(paidEvent(ref, 21597), { mangle: 'sha256=' + '0'.repeat(64) });
ok('wrong signature -> 401', r.status === 401, r.status);
r = await deliver(paidEvent(ref, 21597), { secret: 'the-wrong-secret' });
ok('signature with the wrong key -> 401', r.status === 401, r.status);
ok('  order untouched by rejected deliveries', mem.get(ref).status === 'pending_payment');

console.log('\nWEBHOOK — replay defences');
const stale = paidEvent(ref, 21597);
stale.createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
r = await deliver(stale); j = await r.json();
ok('3h-old event -> acknowledged but ignored', r.status === 200 && j.ignored === 'stale', JSON.stringify(j));
ok('  order still pending', mem.get(ref).status === 'pending_payment');

console.log('\nWEBHOOK — order/paid with matching amount');
// Wire the email stub so the paid path's notifications can be asserted.
const realFetch = globalThis.fetch;
let emails = [];
globalThis.fetch = async (url, init) => {
  // Only Resend calls are emails; anything else (e.g. the webhook's best-effort
  // promotion cleanup against the TagadaPay API) is swallowed with a 200.
  if (String(url).includes('api.resend.com')) emails.push(JSON.parse(init.body));
  return new Response('{"id":"e"}', { status: 200 });
};
process.env.RESEND_API_KEY = 'rk_test';
process.env.EMAIL_FROM = 'orders@pureauraa.com';
process.env.ADMIN_EMAIL = 'cyrus@example.com';

const evPaid = paidEvent(ref, 21597);
r = await deliver(evPaid); j = await r.json();
ok('matching amount -> 200 paid', r.status === 200 && j.status === 'paid', JSON.stringify(j));
ok('  order marked paid', mem.get(ref).status === 'paid');
ok('  shipping address from TagadaPay written onto the order',
   mem.get(ref).customer.address1 === '1 Test St' && mem.get(ref).customer.city === 'Austin', JSON.stringify(mem.get(ref).customer));
ok('  payment details recorded', mem.get(ref).payment.orderId === 'order_tp1' && mem.get(ref).payment.amountCents === 21597);
ok('  buyer AND owner emailed', emails.length === 2 &&
   emails.some((e) => e.to[0] === 'lab@example.com') && emails.some((e) => e.to[0] === 'cyrus@example.com'), emails.map((e) => e.to).join(','));
ok('  owner email says PAID and carries the address',
   emails.find((e) => e.to[0] === 'cyrus@example.com').text.includes('PAID') &&
   emails.find((e) => e.to[0] === 'cyrus@example.com').text.includes('1 Test St'));

emails = [];
r = await deliver(evPaid); j = await r.json();
ok('replayed event id -> duplicate, no second email', j.duplicate === true && emails.length === 0, JSON.stringify(j));
r = await deliver(paidEvent(ref, 21597)); j = await r.json();
ok('fresh paid event for a settled order -> no-op', j.already === 'paid' && emails.length === 0, JSON.stringify(j));

console.log('\nWEBHOOK — order/paid with a WRONG amount is held, never confirmed');
resetLimits();
stubImpl = async (order) => ({ url: 'https://pay.example/x', funnelSessionId: 'fs', checkoutToken: 'ct', promotionId: null, discountCents: 0, shippingCents: 995 });
r = await post(orders, { ...good, items: [{ slug:'bac-water-10ml', variant:'10 mL', bundleQty:1, qty:1 }] }); j = await r.json();
const ref2 = j.order.ref; // $19.95 total
emails = [];
r = await deliver(paidEvent(ref2, 1)); j = await r.json(); // paid 1¢, expected 1995¢
ok('mismatch -> held as payment_review', j.held === 'payment_review' && mem.get(ref2).status === 'payment_review', JSON.stringify(j));
ok('  buyer NOT emailed, owner alerted once',
   emails.length === 1 && emails[0].to[0] === 'cyrus@example.com' && emails[0].subject.includes('mismatch'), emails.map((e) => e.subject).join(','));

console.log('\nWEBHOOK — order/failed and order/refunded');
resetLimits();
r = await post(orders, good); j = await r.json();
const ref3 = j.order.ref;
const failedEvent = { id: randomUUID(), type: 'order/failed', createdAt: new Date().toISOString(),
  data: { orderId: 'order_tp3', draft: false, order_metadata: { cartCustomAttributes: [{ name: 'orderRef', value: ref3 }] } } };
r = await deliver(failedEvent); j = await r.json();
ok('failed on pending -> payment_failed', mem.get(ref3).status === 'payment_failed', mem.get(ref3).status);
const failedOnPaid = { ...failedEvent, id: randomUUID(), data: { ...failedEvent.data, order_metadata: { cartCustomAttributes: [{ name: 'orderRef', value: ref }] } } };
r = await deliver(failedOnPaid);
ok('failed after paid never un-pays', mem.get(ref).status === 'paid', mem.get(ref).status);

emails = [];
const refundEvent = { id: randomUUID(), type: 'order/refunded', createdAt: new Date().toISOString(),
  data: { orderId: 'order_tp1', refundAmount: 21597, totalRefundedAmount: 21597,
    order_metadata: { cartCustomAttributes: [{ name: 'orderRef', value: ref }] } } };
r = await deliver(refundEvent); j = await r.json();
ok('refund -> status refunded with amount recorded',
   mem.get(ref).status === 'refunded' && mem.get(ref).refund.amountCents === 21597, JSON.stringify(mem.get(ref).refund));
ok('  owner alerted about the refund', emails.length === 1 && emails[0].subject.includes('refunded'), emails.map((e) => e.subject).join(','));

console.log('\nWEBHOOK — events that match nothing');
emails = [];
const orphan = paidEvent('AUR-QQQQQQ', 5000);
r = await deliver(orphan); j = await r.json();
ok('verified-but-unmatched -> 200 unmatched (no retry storm)', r.status === 200 && j.unmatched === true, JSON.stringify(j));
ok('  owner alerted — money may lack a row', emails.length === 1 && emails[0].to[0] === 'cyrus@example.com', emails.length);
const otherType = { id: randomUUID(), type: 'checkout/initiated', createdAt: new Date().toISOString(), data: {} };
r = await deliver(otherType); j = await r.json();
ok('unsubscribed event type -> acknowledged, ignored', j.ignored === 'checkout/initiated', JSON.stringify(j));

globalThis.fetch = realFetch;
delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.ADMIN_EMAIL;

console.log('\nADMIN — auth');
resetLimits();
r = await post(adminList, {}); ok('no bearer -> 401', r.status === 401, r.status);
r = await post(adminList, {}, { authorization:'Bearer wrong' }); ok('wrong password -> 401', r.status === 401, r.status);
const AUTH = { authorization: 'Bearer test-password' };
r = await post(adminList, {}, AUTH); j = await r.json();
ok('correct password -> 200', r.status === 200 && j.ok, r.status);
ok('  returns the orders', j.orders.length === mem.size, `${j.orders.length} vs ${mem.size}`);
ok('  revenue excludes refunded, held and pending orders', j.totals.revenue === 0, j.totals.revenue);

console.log('\nADMIN — update still works as the manual override');
r = await post(adminUpd, { ref: ref3, status:'paid', notify:false }, AUTH); j = await r.json();
ok('a human can still mark paid', r.status === 200 && mem.get(ref3).status === 'paid');
r = await post(adminUpd, { ref: ref3, tracking:'1Z999', status:'shipped', notify:false }, AUTH);
ok('tracking stored', mem.get(ref3).tracking === '1Z999' && mem.get(ref3).status === 'shipped');
r = await post(adminUpd, { ref: ref3, status:'teleported' }, AUTH);
ok('unknown status rejected', r.status === 400, r.status);
r = await post(adminUpd, { ref:'../../etc/passwd' }, AUTH);
ok('malformed ref rejected before any lookup', r.status === 400, r.status);

console.log('\nRATE LIMITING');
resetLimits();
let last;
for (let i = 0; i < 9; i++) last = await post(orders, good);
ok('9th order from one IP -> 429', last.status === 429, last.status);
ok('  Retry-After header set', !!last.headers.get('retry-after'), last.headers.get('retry-after'));
const before = mem.size;
await post(orders, good);
ok('  throttled request writes nothing', mem.size === before, `${mem.size} vs ${before}`);

resetLimits();
let bad429;
for (let i = 0; i < 11; i++) bad429 = await post(adminList, {}, { authorization:'Bearer wrong' });
ok('11th bad admin password -> 429', bad429.status === 429, bad429.status);
resetLimits();
for (let i = 0; i < 20; i++) await post(adminList, {}, AUTH);
const stillOk = await post(adminList, {}, AUTH);
ok('  successful admin calls are never throttled', stillOk.status === 200, stillOk.status);

resetLimits();
console.log('\nMETHOD GUARD');
for (const [n,h] of [['orders',orders],['admin-orders',adminList],['admin-update',adminUpd],['tagada-webhook',webhook]]) {
  const res = await h(new Request('https://x/api', { method:'GET' }));
  ok(`${n} rejects GET`, res.status === 405, res.status);
}
const postStatus = await orderStatus(new Request('https://x/api', { method:'POST', headers: SESSION }));
ok('order-status rejects POST', postStatus.status === 405, postStatus.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
