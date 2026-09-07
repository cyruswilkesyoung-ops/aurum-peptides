// The three order endpoints, driven over real Request objects.
// Netlify Blobs is stubbed in memory so the write path runs off-platform.
// Run with: npm test
// Exercises the real orders.mjs handler over real Request objects. Netlify Blobs is
// stubbed with an in-memory store so the write path runs without a Netlify environment.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const mem = new Map();          // orders
const rl  = new Map();          // rate-limit counters
const makeStore = (m) => ({
  setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => (m.has(k) ? m.get(k) : null),
  list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }),
});
const fakeStore = (name) => (name === 'ratelimit' ? makeStore(rl) : makeStore(mem));
register(new URL('./_blobs-stub.mjs', import.meta.url));
globalThis.__FAKE_STORE__ = fakeStore;
const resetLimits = () => rl.clear();

const BASE = new URL('../netlify/functions/', import.meta.url).href;
const orders = (await import(BASE + 'orders.mjs')).default;
const adminList = (await import(BASE + 'admin-orders.mjs')).default;
const adminUpd = (await import(BASE + 'admin-orders-update.mjs')).default;

let pass = 0, fail = 0;
const ok = (n, c, d='') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, d)); };
const post = (h, body, headers={}) => h(new Request('https://x/api', {
  method:'POST', headers:{ 'content-type':'application/json', ...headers }, body: JSON.stringify(body) }));

const good = {
  name:'A Researcher', email:'lab@example.com', address1:'1 Test St', city:'Austin',
  state:'TX', postal:'78701', country:'United States', notes:'', company:'',
  ageConfirm:true, researchConfirm:true,
  items:[{ slug:'bpc-157', variant:10, bundleQty:3, qty:1 }],
};

console.log('\nORDERS — refuses before writing when it cannot be paid');
delete process.env.CRYPTO_BTC; delete process.env.CASHAPP_HANDLE;
let r = await post(orders, good); let j = await r.json();
ok('503 when no payment method configured', r.status === 503 && j.ok === false, r.status);
ok('  nothing was persisted', mem.size === 0, mem.size);

process.env.CRYPTO_BTC = 'bc1qexampleaddress';
process.env.CASHAPP_HANDLE = 'aurum';
process.env.ADMIN_PASSWORD = 'test-password';

resetLimits();
console.log('\nORDERS — validation');
r = await post(orders, { ...good, company:'spambot' }); j = await r.json();
ok('honeypot -> 200 with generic failure', r.status === 200 && j.ok === false, r.status);
ok('  honeypot order not persisted', mem.size === 0, mem.size);

for (const [name, patch, expect] of [
  ['missing age consent',   { ageConfirm:false },      '21 or older'],
  ['missing RUO consent',   { researchConfirm:false }, 'research-use'],
  ['blank required field',  { city:'' },               'every required field'],
  ['malformed email',       { email:'not-an-email' },  'does not look right'],
  ['empty cart',            { items:[] },              'empty'],
  ['unknown product',       { items:[{slug:'nope',variant:1,bundleQty:1,qty:1}] }, 'no longer carry'],
]) {
  r = await post(orders, { ...good, ...patch }); j = await r.json();
  ok(name + ' -> 400', r.status === 400 && j.error.includes(expect), `${r.status} ${j.error}`);
}
ok('no invalid order reached storage', mem.size === 0, mem.size);

resetLimits();
console.log('\nORDERS — the happy path');
r = await post(orders, good); j = await r.json();
ok('200 ok', r.status === 200 && j.ok === true, r.status);
ok('  ref shape', /^AUR-[A-Z0-9]{6}$/.test(j.order.ref), j.order.ref);
ok('  total is server-computed 215.97', j.order.total === 215.97, j.order.total);
ok('  totalFormatted for the order page', j.order.totalFormatted === '$215.97', j.order.totalFormatted);
ok('  both payment methods offered', j.methods.length === 2, j.methods.map(m=>m.id).join(','));
ok('  crypto address surfaced', j.methods[0].coins[0].address === 'bc1qexampleaddress');
ok('  confirmWindow + supportEmail present', !!j.confirmWindow && !!j.supportEmail);
ok('  persisted exactly one order', mem.size === 1, mem.size);
const ref = j.order.ref;
ok('  stored status is pending_payment', mem.get(ref).status === 'pending_payment');
ok('  stored item carries name/meta/lineTotal for admin',
   mem.get(ref).items[0].name === 'BPC-157' && mem.get(ref).items[0].meta === '10 mg · Bundle of 3'
   && mem.get(ref).items[0].lineTotal === 215.97);

resetLimits();
console.log('\nADMIN — auth');
r = await post(adminList, {}); ok('no bearer -> 401', r.status === 401, r.status);
r = await post(adminList, {}, { authorization:'Bearer wrong' }); ok('wrong password -> 401', r.status === 401, r.status);
const AUTH = { authorization: 'Bearer test-password' };
r = await post(adminList, {}, AUTH); j = await r.json();
ok('correct password -> 200', r.status === 200 && j.ok, r.status);
ok('  returns the order', j.orders.length === 1 && j.orders[0].ref === ref);
ok('  totals.count = 1', j.totals.count === 1, j.totals.count);
ok('  revenue excludes pending_payment', j.totals.revenue === 0, j.totals.revenue);

resetLimits();
console.log('\nADMIN — update');
r = await post(adminUpd, { ref, status:'paid', notify:true }, AUTH); j = await r.json();
ok('status -> paid', r.status === 200 && mem.get(ref).status === 'paid');
ok('  emailed:false, no provider configured', j.emailed === false);
r = await post(adminList, {}, AUTH); j = await r.json();
ok('  revenue now counts it', j.totals.revenue === 215.97, j.totals.revenue);
r = await post(adminUpd, { ref, tracking:'1Z999', status:'shipped', notify:false }, AUTH);
ok('tracking stored', mem.get(ref).tracking === '1Z999' && mem.get(ref).status === 'shipped');
r = await post(adminUpd, { ref, status:'teleported' }, AUTH);
ok('unknown status rejected', r.status === 400, r.status);
r = await post(adminUpd, { ref:'../../etc/passwd' }, AUTH);
ok('malformed ref rejected before any lookup', r.status === 400, r.status);
r = await post(adminUpd, { ref:'AUR-ZZZZZZ' }, AUTH);
ok('unknown ref -> 404', r.status === 404, r.status);

resetLimits();
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
for (const [n,h] of [['orders',orders],['admin-orders',adminList],['admin-update',adminUpd]]) {
  const res = await h(new Request('https://x/api', { method:'GET' }));
  ok(`${n} rejects GET`, res.status === 405, res.status);
}

/* ===========================================================================
   EMAIL — the point of these is that notification can never cost a sale.
   Every failure mode a provider can produce is exercised against a real order.
   =========================================================================== */
console.log('\nEMAIL NOTIFICATIONS');
resetLimits();

const realFetch = globalThis.fetch;
let sentTo = null, sentBody = null, calls = 0;
const stubFetch = (impl) => { globalThis.fetch = async (url, init) => {
  calls++; sentTo = String(url); sentBody = JSON.parse(init.body);
  return impl();
}; };
const okResp   = () => new Response(JSON.stringify({ id:'e_1' }), { status:200 });
const errResp  = () => new Response('domain not verified', { status:403 });
const hangResp = () => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('aborted'), { name:'AbortError' })), 20));

const placeOrder = async () => { const rr = await post(orders, good); return [rr, await rr.json()]; };

// No key: orders must behave exactly as before this feature existed.
delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.ADMIN_EMAIL;
calls = 0;
let [er, ej] = await placeOrder();
ok('no key configured -> order still succeeds', er.status === 200 && ej.ok === true, er.status);
ok('  and no request was attempted', calls === 0, calls);

process.env.RESEND_API_KEY = 'rk_test';
process.env.EMAIL_FROM = 'orders@aurumpeptides.com';
process.env.ADMIN_EMAIL = 'cyrus@example.com';

// Provider accepts.
stubFetch(okResp); calls = 0; resetLimits();
[er, ej] = await placeOrder();
ok('owner is emailed when an order lands', calls === 1 && sentTo.includes('api.resend.com'), calls);
ok('  addressed to ADMIN_EMAIL', sentBody?.to?.[0] === 'cyrus@example.com', sentBody?.to);
ok('  subject carries the ref and the total',
   /AUR-[A-Z0-9]{6}/.test(sentBody.subject) && sentBody.subject.includes('$'), sentBody?.subject);
ok('  body has the shipping address', sentBody.text.includes('1 Test St'));
ok('  body links the admin panel', sentBody.text.includes('/admin/'));
ok('  the API key is not in the payload', !JSON.stringify(sentBody).includes('rk_test'));

// Provider rejects. This is the realistic failure: unverified sending domain.
stubFetch(errResp); resetLimits();
[er, ej] = await placeOrder();
ok('provider 403 -> order STILL succeeds', er.status === 200 && ej.ok === true, er.status);
ok('  buyer still gets payment instructions', Array.isArray(ej.methods) && ej.methods.length > 0);

// Provider hangs past the timeout.
stubFetch(hangResp); resetLimits();
[er, ej] = await placeOrder();
ok('provider timeout -> order STILL succeeds', er.status === 200 && ej.ok === true, er.status);

// Provider throws outright.
globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); }; resetLimits();
[er, ej] = await placeOrder();
ok('provider unreachable -> order STILL succeeds', er.status === 200 && ej.ok === true, er.status);
const storedRef = ej.order.ref;
ok('  the order is in the store regardless', mem.has(storedRef));

// Buyer notification on status change.
stubFetch(okResp); calls = 0;
let ur = await post(adminUpd, { ref: storedRef, status:'paid', notify:true }, { authorization:'Bearer test-password' });
let uj = await ur.json();
ok('mark paid + notify -> buyer emailed', uj.emailed === true && sentBody.to[0] === 'lab@example.com', uj.emailed);
ok('  subject names the ref', sentBody.subject.includes(storedRef), sentBody.subject);

stubFetch(okResp);
ur = await post(adminUpd, { ref: storedRef, status:'shipped', tracking:'9400111899', notify:true }, { authorization:'Bearer test-password' });
uj = await ur.json();
ok('mark shipped + notify -> tracking is in the email', sentBody.text.includes('9400111899'), uj.emailed);

// The honest-reporting rule: a failed send must never report success.
stubFetch(errResp);
ur = await post(adminUpd, { ref: storedRef, status:'cancelled', notify:true }, { authorization:'Bearer test-password' });
uj = await ur.json();
ok('provider refused -> emailed:false, never a false claim', uj.emailed === false, uj.emailed);
ok('  but the status change still saved', uj.order.status === 'cancelled', uj.order?.status);

// notify:false must not send anything at all.
stubFetch(okResp); calls = 0;
await post(adminUpd, { ref: storedRef, status:'paid', notify:false }, { authorization:'Bearer test-password' });
ok('notify:false sends nothing', calls === 0, calls);

globalThis.fetch = realFetch;
delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; delete process.env.ADMIN_EMAIL;


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
