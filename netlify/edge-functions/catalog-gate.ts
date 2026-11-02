// Server-side gate for the catalog. Nothing under these paths — product pages,
// category pages, cart/checkout, the order screen, packshot imagery, or the
// orders API — is served without a valid customer session. The session cookie
// is minted by netlify/functions/auth.mts and verified here with the same
// HMAC-SHA256 scheme (see netlify/functions/_session.mjs); the two files must
// agree on the cookie name and token format.
//
// With neither AUTH_SESSION_SECRET nor ADMIN_PASSWORD set this fails CLOSED:
// no token verifies, so the catalog stays locked rather than falling open.
import type { Config, Context } from '@netlify/edge-functions';

const SESSION_COOKIE = 'aur_session';

/* Must match netlify/functions/_session.mjs: AUTH_SESSION_SECRET when set,
   else a key derived from ADMIN_PASSWORD. */
async function signingSecret(): Promise<string> {
  const explicit = (Netlify.env.get('AUTH_SESSION_SECRET') || '').trim();
  if (explicit) return explicit;
  const admin = (Netlify.env.get('ADMIN_PASSWORD') || '').trim();
  if (!admin) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('auraa.session.v1:' + admin));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64urlToBytes = (s: string): Uint8Array | null => {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

async function verifySession(token: string | undefined, secret: string): Promise<boolean> {
  if (!token || !secret) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const sigBytes = b64urlToBytes(sig);
  if (!sigBytes) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
  if (!valid) return false;
  const payloadBytes = b64urlToBytes(body);
  if (!payloadBytes) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    return typeof payload?.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const secret = await signingSecret();
  const token = context.cookies.get(SESSION_COOKIE);

  if (await verifySession(token, secret)) {
    // Authorized: serve the page, but make sure gated content is never indexed
    // or cached for a later, logged-out visitor.
    const res = await context.next();
    res.headers.set('x-robots-tag', 'noindex, nofollow');
    res.headers.set('cache-control', 'private, no-store');
    return res;
  }

  // Unauthenticated. APIs and assets get a bare 401 with no product data;
  // pages redirect to login and return to the requested page afterwards.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/')) {
    return new Response(JSON.stringify({ ok: false, error: 'Please sign in to continue.' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const next = encodeURIComponent(url.pathname + url.search);
  return new Response(null, {
    status: 302,
    headers: {
      location: `/account/login/?next=${next}`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
};

export const config: Config = {
  path: [
    '/shop', '/shop/*',
    '/categories', '/categories/*',
    '/checkout', '/checkout/*',
    '/order', '/order/*',
    // Certificates list every product by name, and blog posts carry product cards
    // with prices, so both sit behind the same login (processor review, 2026-11-01).
    '/certificates', '/certificates/*',
    '/blog', '/blog/*',
    '/assets/packshots/*',
    '/api/orders',
  ],
};
