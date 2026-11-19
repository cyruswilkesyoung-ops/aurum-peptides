// POST /api/admin/scraper-ticket: the "Affiliate Scraper Tool" tab in /admin/ calls this with the
// admin password (Bearer, same ADMIN_PASSWORD guard and failed-login cap as every admin endpoint).
// It returns a link to the standalone scraper app carrying a 60 second ticket.
//
// ticket = base64url(JSON payload) "." base64url(HMAC-SHA256(first part, SSO_TICKET_SECRET))
// The scraper app checks the signature, the audience and the clock, then spends the nonce in its own
// database so a ticket works once. The secret lives only in Netlify and Vercel env, never in the repo.
import { createHmac, randomBytes } from 'node:crypto';
import { json, fail, adminOk, rateLimit, clientIp } from './_lib.mjs';

export const TICKET_AUDIENCE = 'auraa-affiliate-scraper';
export const TICKET_SECONDS = 60;
const DEFAULT_APP_URL = 'https://auraa-affiliate-scraper.vercel.app';

export function mintTicket(secret, now = Math.floor(Date.now() / 1000)) {
  const payload = {
    v: 1,
    aud: TICKET_AUDIENCE,
    sub: 'auraa-admin',
    email: 'admin',
    iat: now,
    exp: now + TICKET_SECONDS,
    nonce: randomBytes(24).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);
  if (!adminOk(req)) {
    const l = await rateLimit({ bucket: 'admin-auth', id: clientIp(req), max: 10, windowMs: 15 * 60 * 1000 });
    if (!l.ok) {
      console.warn('[admin] auth attempts rate limited', clientIp(req));
      return fail('Too many attempts. Try again later.', 429);
    }
    return fail('Not authorised.', 401);
  }
  // Fails closed: no secret (or a short one), no ticket.
  const secret = (process.env.SSO_TICKET_SECRET || '').trim();
  if (secret.length < 32) return fail('The Affiliate Scraper Tool is not set up yet.', 503);
  const base = (process.env.SCRAPER_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
  return json({ ok: true, url: `${base}/sso?t=${encodeURIComponent(mintTicket(secret))}`, expiresIn: TICKET_SECONDS });
};
