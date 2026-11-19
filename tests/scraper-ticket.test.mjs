// The Affiliate Scraper Tool sign-in ticket endpoint: bad password 401, no secret 503, a good ticket
// verifies exactly the way the scraper app verifies it, and forged / expired / wrong-audience tickets fail.
// Run with: npm test
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

const rl = new Map();
const makeStore = (m) => ({
  setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
  get: async (k) => (m.has(k) ? m.get(k) : null),
  delete: async (k) => { m.delete(k); },
  list: async () => ({ blobs: [...m.keys()].map((key) => ({ key })) }),
});
register(new URL('./_blobs-stub.mjs', import.meta.url));
globalThis.__FAKE_STORE__ = () => makeStore(rl);

const BASE = new URL('../netlify/functions/', import.meta.url).href;
const { default: handler, mintTicket } = await import(BASE + 'admin-scraper-ticket.mjs');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, d)); };
const call = (headers = {}, method = 'POST') => handler(new Request('https://x/api/admin/scraper-ticket', { method, headers }));

// The scraper app's verifier (app/lib/sso.ts), restated here so a drift in either side fails a test.
function verify(ticket, secret, now = Math.floor(Date.now() / 1000)) {
  const [body, sig] = String(ticket).split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', secret).update(body).digest('base64url');
  if (want !== sig) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (p.v !== 1 || p.aud !== 'auraa-affiliate-scraper' || !p.nonce || p.nonce.length < 16) return null;
  if (p.exp < now || p.iat > now + 30 || p.exp - p.iat > 120) return null;
  return p;
}

const SECRET = 's'.repeat(48);
process.env.ADMIN_PASSWORD = 'test-password';
process.env.SSO_TICKET_SECRET = SECRET;
const AUTH = { authorization: 'Bearer test-password' };

console.log('\nSCRAPER TICKET');
let r = await call();
ok('no password -> 401', r.status === 401, r.status);
r = await call({ authorization: 'Bearer wrong' });
ok('wrong password -> 401', r.status === 401, r.status);
let j = await r.json();
ok('  nothing minted for a bad password', j.ok === false && !j.url);
r = await call(AUTH, 'GET');
ok('GET -> 405', r.status === 405, r.status);

r = await call(AUTH); j = await r.json();
ok('good password -> 200 with a link', r.status === 200 && j.ok === true && j.url.includes('/sso?t='), r.status);
const t = decodeURIComponent(new URL(j.url).searchParams.get('t'));
const p = verify(t, SECRET);
ok('  ticket verifies with the shared secret', !!p);
ok('  lives 60 seconds', p && p.exp - p.iat === 60);
ok('  every ticket has its own nonce', (verify(decodeURIComponent(new URL((await (await call(AUTH)).json()).url).searchParams.get('t')), SECRET)).nonce !== p.nonce);
ok('  not served from a cache', r.headers.get('cache-control') === 'no-store');

const now = Math.floor(Date.now() / 1000);
ok('forged (other secret) ticket rejected', verify(mintTicket('x'.repeat(48)), SECRET) === null);
ok('expired ticket rejected', verify(mintTicket(SECRET, now - 600), SECRET) === null);
const [body, sig] = t.split('.');
const edited = Buffer.from(JSON.stringify({ ...p, exp: now + 99999 })).toString('base64url');
ok('edited payload rejected', verify(`${edited}.${sig}`, SECRET) === null);
const wrongAud = (() => { const b = Buffer.from(JSON.stringify({ ...p, aud: 'other' })).toString('base64url'); return `${b}.${createHmac('sha256', SECRET).update(b).digest('base64url')}`; })();
ok('wrong audience rejected', verify(wrongAud, SECRET) === null);

process.env.SSO_TICKET_SECRET = 'short';
r = await call(AUTH);
ok('short secret -> 503, no ticket', r.status === 503, r.status);
delete process.env.SSO_TICKET_SECRET;
r = await call(AUTH);
ok('no secret -> 503, no ticket', r.status === 503, r.status);

rl.clear();
process.env.SSO_TICKET_SECRET = SECRET;
for (let i = 0; i < 10; i++) await call({ authorization: 'Bearer nope' });
r = await call({ authorization: 'Bearer nope' });
ok('guessing is capped (429 after 10 failures)', r.status === 429, r.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
