// Affiliate program: referral cookie capture + validation, server-side re-validation on
// orders, the signed order report, and the rule that the partner app can never block or
// fail an order. The partner app is a fake fetch; nothing leaves the machine.
// Run with: npm test
import { register } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const mem = new Map(), rl = new Map();
const makeStore = (m) => ({
  setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => (m.has(k) ? m.get(k) : null),
  delete: async (k) => { m.delete(k); },
  list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }),
});
register(new URL('./_blobs-stub.mjs', import.meta.url));
globalThis.__FAKE_STORE__ = (name) => (name === 'ratelimit' ? makeStore(rl) : makeStore(mem));

const BASE = new URL('../netlify/functions/', import.meta.url).href;
process.env.AUTH_SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_PASSWORD = 'test-password';
const SECRET = 'unit-test-secret-not-real';
process.env.AFFILIATE_ORDER_WEBHOOK_SECRET = SECRET;
process.env.AFFILIATE_APP_URL = 'https://app.example';
const orders = (await import(BASE + 'orders.mjs')).default;
const affiliate = (await import(BASE + 'affiliate.mjs')).default;
const adminUpd = (await import(BASE + 'admin-orders-update.mjs')).default;
const resend = (await import(BASE + 'admin-affiliate-resend.mjs')).default;
const lib = await import(BASE + '_affiliate.mjs');
const { signSession, SESSION_COOKIE } = await import(BASE + '_session.mjs');
const session = `${SESSION_COOKIE}=${encodeURIComponent(signSession({ id: 1, email: 'lab@example.com', name: 'A Researcher' }))}`;

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, d)); };

/* ---- fake partner app ---- */
let appMode = 'up';           // up | down | slow | error500
let calls = [];
const VALID = new Set(['GOOD1', 'ALICE']);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://app.example')) return realFetch(url, init);
  calls.push({ url: u, init });
  if (appMode === 'down') throw new TypeError('fetch failed');
  if (appMode === 'slow') {
    await new Promise((res, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  }
  if (appMode === 'error500') return new Response('boom', { status: 500 });
  if (u.includes('/api/affiliates/code/')) {
    const code = decodeURIComponent(u.split('/code/')[1]);
    return Response.json({ valid: VALID.has(code) });
  }
  if (u.endsWith('/api/affiliates/apply')) {
    const b = JSON.parse(init.body);
    return b.email === 'reject@example.com' ? Response.json({ error: 'Email already applied' }, { status: 400 }) : Response.json({ ok: true }, { status: 201 });
  }
  if (u.endsWith('/api/affiliates/order')) return Response.json({ ok: true });
  return new Response('nope', { status: 404 });
};
const reset = () => { calls = []; appMode = 'up'; rl.clear(); };

globalThis.__TAGADA_STUB__ = async (order) => ({ url: `https://pay.example/${order.ref}`, funnelSessionId: 'f', checkoutToken: 't', promotionId: null, discountCents: 0 });
const good = { name: 'A Researcher', email: 'lab@example.com', notes: '', company: '', ageConfirm: true, researchConfirm: true,
  items: [{ slug: 'bpc-157', variant: 10, bundleQty: 3, qty: 1 }] };
const placeOrder = (cookie = '') => orders(new Request('https://x/api/orders', { method: 'POST',
  headers: { 'content-type': 'application/json', cookie: [session, cookie].filter(Boolean).join('; ') }, body: JSON.stringify(good) }));
const codeReq = (qs) => affiliate(new Request(`https://x/api/affiliate/code?${qs}`));

console.log('\nCODE CHECK + COOKIE');
reset();
let r = await codeReq('code=GOOD1&set=1'); let j = await r.json();
const sc = r.headers.get('set-cookie') || '';
ok('valid code -> valid:true', j.valid === true, JSON.stringify(j));
ok('  cookie aur_ref set, 30 days, first-party, Lax, Secure', /^aur_ref=GOOD1;/.test(sc) && /Max-Age=2592000/.test(sc) && /SameSite=Lax/.test(sc) && /Secure/.test(sc) && !/Domain=/i.test(sc), sc);
r = await codeReq('code=NOPE1&set=1'); j = await r.json();
ok('bad code -> valid:false, NO cookie', j.valid === false && !r.headers.get('set-cookie'));
r = await codeReq('code=GOOD1'); 
ok('valid code without set=1 sets no cookie', !r.headers.get('set-cookie'));
calls = [];
r = await codeReq('code=' + encodeURIComponent('../admin?x=1')); j = await r.json();
ok('malformed code never reaches the app', j.valid === false && calls.length === 0);
appMode = 'down'; r = await codeReq('code=GOOD1&set=1');
ok('app down -> 502, no cookie', r.status === 502 && !r.headers.get('set-cookie'), r.status);
reset();

r = await codeReq('code=good1&set=1'); j = await r.json();
ok('lower-case code is accepted and the cookie is stored UPPER case', j.valid === true && /^aur_ref=GOOD1;/.test(r.headers.get('set-cookie') || ''));
ok('  app is asked about the upper-case form', calls.at(-1).url.endsWith('/code/GOOD1'));
reset();

console.log('\nAPPLY FORM');
const apply = (b) => affiliate(new Request('https://x/api/affiliate/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
const app = { name: 'Pat', email: 'pat@example.com', socials: '@pat', audience: 'x', promo: 'y', payout_method: 'PayPal', website: '', company_url: '', researchConfirm: true };
r = await apply(app); j = await r.json();
ok('valid application -> ok', r.status === 200 && j.ok === true);
const sent = JSON.parse(calls.at(-1).init.body);
ok('  forwarded with empty honeypot, no ack field, no website when blank', sent.company_url === '' && !('researchConfirm' in sent) && !('website' in sent));
calls = [];
r = await apply({ ...app, company_url: 'http://spam' }); j = await r.json();
ok('honeypot -> fake success, nothing forwarded', j.ok === true && calls.length === 0);
r = await apply({ ...app, email: 'reject@example.com' }); j = await r.json();
ok('app 400 message passed through', r.status === 400 && j.error === 'Email already applied');
r = await apply({ ...app, payout_method: 'Gold' });
ok('unknown payout method refused', r.status === 400);
r = await apply({ ...app, researchConfirm: false });
ok('research acknowledgment required', r.status === 400);
rl.clear(); appMode = 'down'; r = await apply(app);
ok('app down -> 502 with friendly error', r.status === 502 && (await r.json()).ok === false);
reset();

console.log('\nORDERS — server-side re-validation');
mem.clear();
r = await placeOrder('aur_ref=GOOD1'); j = await r.json();
let o = mem.get(j.order?.ref);
ok('valid cookie -> order saved with code, verified', r.status === 200 && o?.affiliate?.code === 'GOOD1' && o.affiliate.verified === true);
ok('  app was asked to re-validate', calls.some((c) => c.url.endsWith('/code/GOOD1')));
mem.clear(); calls = [];
r = await placeOrder('aur_ref=FORGED9'); j = await r.json(); o = mem.get(j.order?.ref);
ok('forged cookie -> order succeeds, code NOT saved, nothing reported', r.status === 200 && !o.affiliate && !calls.some((c) => c.url.endsWith('/order')));
mem.clear(); calls = [];
r = await placeOrder(); j = await r.json(); o = mem.get(j.order?.ref);
ok('no cookie -> no app calls at all', r.status === 200 && !o.affiliate && calls.length === 0);
r = await placeOrder('aur_ref=' + encodeURIComponent('GOOD1;<script>')); j = await r.json(); o = mem.get(j.order?.ref);
ok('malformed cookie ignored', r.status === 200 && !o.affiliate);

mem.clear();
r = await placeOrder('aur_ref=good1'); j = await r.json(); o = mem.get(j.order?.ref);
ok('lower-case cookie -> order saved with the upper-case code', o?.affiliate?.code === 'GOOD1');
ok('  report body carries the upper-case code', JSON.parse(calls.find((c) => c.url.endsWith('/api/affiliates/order')).init.body).code === 'GOOD1');
r = await placeOrder('aur_ref=AB'); j = await r.json(); o = mem.get(j.order?.ref);
ok('2-character code (app minimum is 3) ignored', !o.affiliate);

console.log('\nSIGNATURE');
reset(); mem.clear();
r = await placeOrder('aur_ref=GOOD1'); j = await r.json(); o = mem.get(j.order.ref);
const rep = calls.find((c) => c.url.endsWith('/api/affiliates/order'));
const h = rep.init.headers;
const raw = rep.init.body;
ok('pending order reported', !!rep && JSON.parse(raw).status === 'pending');
ok('  timestamp is unix seconds', /^\d{10}$/.test(h['x-auraa-timestamp']) && Math.abs(Date.now() / 1000 - Number(h['x-auraa-timestamp'])) < 10);
ok('  signature = hex HMAC-SHA256(secret, `${ts}.${rawBody}`)', h['x-auraa-signature'] === createHmac('sha256', SECRET).update(`${h['x-auraa-timestamp']}.${raw}`).digest('hex') && /^[0-9a-f]{64}$/.test(h['x-auraa-signature']));
const body = JSON.parse(raw);
ok('  body has exactly order_id, code, subtotal_cents, status, created_at', Object.keys(body).sort().join() === 'code,created_at,order_id,status,subtotal_cents');
ok('  subtotal_cents is the order subtotal in cents, shipping excluded', body.subtotal_cents === Math.round(o.subtotal * 100) && body.order_id === o.ref && body.code === 'GOOD1');
ok('  secret never in the body or logs of the request', !raw.includes(SECRET) && !JSON.stringify(h).includes(SECRET));
ok('signOrderBody matches independent HMAC', lib.signOrderBody('k', '1700000000', '{"a":1}') === createHmac('sha256', 'k').update('1700000000.{"a":1}').digest('hex'));

console.log('\nNEVER BLOCKS AN ORDER');
for (const mode of ['down', 'error500']) {
  reset(); mem.clear(); appMode = mode;
  r = await placeOrder('aur_ref=GOOD1'); j = await r.json(); o = mem.get(j.order?.ref);
  ok(`app ${mode}: order still succeeds and is saved`, r.status === 200 && j.ok === true && !!o);
  ok(`  code kept, marked unverified`, o?.affiliate?.code === 'GOOD1' && o.affiliate.verified === false);
}
reset(); mem.clear(); appMode = 'slow';
const t0 = Date.now();
r = await placeOrder('aur_ref=GOOD1'); j = await r.json();
ok('app hanging: order succeeds inside the timeouts (<9s)', r.status === 200 && j.ok === true && Date.now() - t0 < 9000, `${Date.now() - t0}ms`);
reset();
{
  const out = await lib.reportAffiliateOrder({ ref: 'AUR-AAAAAA', subtotal: 10, createdAt: 'x', affiliate: { code: 'GOOD1' } }, 'paid');
  ok('reportAffiliateOrder resolves (not throws) when app is up', out.ok === true);
  appMode = 'down';
  const out2 = await lib.reportAffiliateOrder({ ref: 'AUR-AAAAAA', subtotal: 10, createdAt: 'x', affiliate: { code: 'GOOD1' } }, 'paid');
  ok('  resolves (not throws) when app is down', out2.ok === false);
  appMode = 'up'; calls = [];
  const out3 = await lib.reportAffiliateOrder({ ref: 'AUR-AAAAAA', subtotal: 10, createdAt: 'x' }, 'paid');
  ok('  no code on the order -> nothing sent', out3.sent === false && calls.length === 0);
  const saved = process.env.AFFILIATE_ORDER_WEBHOOK_SECRET; delete process.env.AFFILIATE_ORDER_WEBHOOK_SECRET;
  const out4 = await lib.reportAffiliateOrder({ ref: 'AUR-AAAAAA', subtotal: 10, createdAt: 'x', affiliate: { code: 'GOOD1' } }, 'paid');
  ok('  secret unset -> nothing sent, no throw', out4.sent === false && calls.length === 0);
  process.env.AFFILIATE_ORDER_WEBHOOK_SECRET = saved;
}

console.log('\nADMIN STATUS CHANGES');
reset(); mem.clear();
r = await placeOrder('aur_ref=GOOD1'); j = await r.json(); const ref = j.order.ref;
const upd = (b) => adminUpd(new Request('https://x/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-password' }, body: JSON.stringify({ ref, ...b }) }));
calls = [];
r = await upd({ status: 'paid' });
ok('paid -> reported as paid', r.status === 200 && calls.some((c) => c.url.endsWith('/order') && JSON.parse(c.init.body).status === 'paid'));
calls = []; r = await upd({ status: 'paid' });
ok('no change -> nothing reported', calls.length === 0);
calls = []; r = await upd({ status: 'refunded' });
ok('refunded -> reported', calls.some((c) => JSON.parse(c.init.body || '{}').status === 'refunded'));
calls = []; r = await upd({ status: 'cancelled' });
ok('cancelled -> reported', calls.some((c) => JSON.parse(c.init.body || '{}').status === 'cancelled'));
appMode = 'down'; r = await upd({ status: 'paid' });
ok('app down: admin update still succeeds and saves', r.status === 200 && mem.get(ref).status === 'paid');
reset();
r = await resend(new Request('https://x/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) }));
ok('resend without admin password -> 401', r.status === 401);
r = await resend(new Request('https://x/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-password' }, body: JSON.stringify({ ref }) }));
ok('resend with password -> sends current status', r.status === 200 && calls.some((c) => c.url.endsWith('/order')));

console.log('\nWIRING');
const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const gate = readFileSync(new URL('../netlify/edge-functions/catalog-gate.ts', import.meta.url), 'utf8');
const gatePaths = gate.slice(gate.indexOf('path: ['));
ok('/affiliates and /api/affiliate are NOT in the catalog gate', !/'\/affiliates|'\/api\/affiliate/.test(gatePaths));
ok('admin resend route is forced', /from = "\/api\/admin\/orders\/affiliate"\n\s+to = "\/\.netlify\/functions\/admin-affiliate-resend"\n\s+status = 200\n\s+force = true/.test(toml));
ok('page exists, in sitemap, in footer of the home page', readFileSync(new URL('../affiliates/index.html', import.meta.url), 'utf8').includes('id="affForm"')
  && readFileSync(new URL('../sitemap.xml', import.meta.url), 'utf8').includes('/affiliates/')
  && readFileSync(new URL('../index.html', import.meta.url), 'utf8').includes('href="/affiliates/"'));
const page = readFileSync(new URL('../affiliates/index.html', import.meta.url), 'utf8');
ok('page has partner sign-in link and honeypot', page.includes('https://auraa-partners.vercel.app/affiliate') && page.includes('name="company_url"'));
ok('page states no commission percentage', !/\d\s*%/.test(page.slice(page.indexOf('<main'), page.indexOf('</main>'))));
ok('no em dashes in the page copy', !page.slice(page.indexOf('<main'), page.indexOf('</main>')).includes('—'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
