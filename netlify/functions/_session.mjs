// Stateless session tokens for customer accounts.
// ---------------------------------------------------------------------------
// token = base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload, secret))
// carried in an HttpOnly cookie. The edge gate (netlify/edge-functions/
// catalog-gate.ts) verifies the same format with Web Crypto, so the two files
// must agree on the cookie name and signing scheme. The secret comes from the
// AUTH_SESSION_SECRET environment variable; with it unset everything fails
// CLOSED — no sessions verify and none can be minted.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'aur_session';
export const SESSION_DAYS = 30;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* AUTH_SESSION_SECRET wins when set. Otherwise the key is derived from
   ADMIN_PASSWORD, which this site always has configured — an attacker who
   knows that password owns the store outright, so deriving a signing key
   from it adds no new exposure, and it means accounts work without any
   extra setup. The edge gate derives the identical key (catalog-gate.ts). */
const secret = () => {
  const explicit = (process.env.AUTH_SESSION_SECRET || '').trim();
  if (explicit) return explicit;
  const admin = (process.env.ADMIN_PASSWORD || '').trim();
  return admin ? createHash('sha256').update('auraa.session.v1:' + admin).digest('hex') : '';
};

export const sessionConfigured = () => Boolean(secret());

export function signSession(user) {
  const key = secret();
  if (!key) throw new Error('AUTH_SESSION_SECRET is not set');
  const payload = JSON.stringify({
    sub: user.id,
    email: user.email,
    name: user.name,
    exp: Date.now() + SESSION_DAYS * 864e5,
  });
  const body = b64url(payload);
  const sig = b64url(createHmac('sha256', key).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySessionToken(token) {
  const key = secret();
  if (!key || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  let given;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload; // { sub, email, name, exp }
}

export function readSession(req) {
  const cookies = req.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? verifySessionToken(decodeURIComponent(match[1])) : null;
}

export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;

export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
