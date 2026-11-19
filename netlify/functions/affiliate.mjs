// Public affiliate endpoints (not behind the catalog gate: /affiliates/ is for signed-out visitors).
//   GET  /api/affiliate/code?code=X[&set=1]  validates with the partner app; with set=1 and a
//                                            valid code, stores the first-party aur_ref cookie
//   POST /api/affiliate/apply                forwards the application form to the partner app
// The browser talks only to this site, so the partner app needs no CORS and no key leaves it.
import { json, fail, rateLimit, clientIp } from './_lib.mjs';
import { validateCode, applyToProgram, normalizeCode, refCookie } from './_affiliate.mjs';

const PAYOUTS = new Set(['PayPal', 'Zelle', 'Cash App', 'Bank transfer', 'Crypto']);

export default async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.replace(/\/+$/, '').split('/').pop();

  if (action === 'code') {
    if (req.method !== 'GET') return fail('Method not allowed.', 405);
    const l = await rateLimit({ bucket: 'aff-code', id: clientIp(req), max: 60, windowMs: 10 * 60 * 1000 });
    if (!l.ok) return fail('Too many attempts. Try again shortly.', 429);
    const code = normalizeCode(url.searchParams.get('code'));
    if (!code) return json({ ok: true, valid: false });
    const r = await validateCode(code);
    if (r.error) return json({ ok: false, error: 'We could not check that code right now.' }, 502);
    if (!r.valid) return json({ ok: true, valid: false });
    const res = json({ ok: true, valid: true, code });
    if (url.searchParams.get('set') === '1') res.headers.append('set-cookie', refCookie(code));
    return res;
  }

  if (action === 'apply') {
    if (req.method !== 'POST') return fail('Method not allowed.', 405);
    const l = await rateLimit({ bucket: 'aff-apply', id: clientIp(req), max: 5, windowMs: 60 * 60 * 1000 });
    if (!l.ok) return fail('Too many applications from this connection. Please try again later.', 429);
    let body;
    try { body = await req.json(); } catch { return fail('We could not read that request.', 400); }
    // Honeypot: a bot gets a convincing success and nothing is forwarded.
    if (typeof body.company_url === 'string' && body.company_url.trim()) {
      console.warn('[affiliate] honeypot tripped');
      return json({ ok: true });
    }
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const f = {
      name: str(body.name, 120),
      email: str(body.email, 200),
      socials: str(body.socials, 500),
      audience: str(body.audience, 1000),
      promo: str(body.promo, 1000),
      payout_method: str(body.payout_method, 40),
      company_url: '',
    };
    const website = str(body.website, 300);
    if (website) f.website = website;
    for (const k of ['name', 'email', 'socials', 'audience', 'promo', 'payout_method']) {
      if (!f[k]) return fail('Please complete every required field.');
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return fail('That email address does not look right.');
    if (!PAYOUTS.has(f.payout_method)) return fail('Please choose a payout method.');
    if (body.researchConfirm !== true) return fail('Please confirm the research-use acknowledgment.');
    const r = await applyToProgram(f);
    if (r.ok) return json({ ok: true });
    if (r.status === 400 && r.error) return fail(r.error.slice(0, 200), 400);
    return fail('We could not send your application right now. Please try again in a few minutes.', 502);
  }

  return fail('Not found.', 404);
};

// Routed by path (not a toml redirect) so the handler always sees /api/affiliate/<action>.
export const config = { path: ['/api/affiliate/code', '/api/affiliate/apply'] };
