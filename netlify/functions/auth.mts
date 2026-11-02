// Customer accounts: signup, login, logout, me, password reset.
// POST /api/auth/:action (me is GET). Accounts are active immediately on
// signup — no email-confirmation step and no manual approval, by design.
import type { Config, Context } from '@netlify/functions';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, lt } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users, passwordResetTokens } from '../../db/schema.js';
import { json, fail, rateLimit, clientIp } from './_lib.mjs';
import {
  signSession, readSession, sessionCookie, clearSessionCookie, sessionConfigured,
} from './_session.mjs';
import { sendEmail, emailConfigured } from './_email.mjs';

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;

const SCRYPT_PREFIX = 'scrypt$16384$8$1';

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `${SCRYPT_PREFIX}$${salt}$${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, , , , salt, hex] = parts;
  const expected = Buffer.from(hex, 'hex');
  const got = await scrypt(password, salt, expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const normEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 200) : '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const withSession = (body: Record<string, unknown>, token: string, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': sessionCookie(token),
    },
  });

export default async (req: Request, context: Context) => {
  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop();

  if (action === 'me') {
    const sess = readSession(req);
    return sess
      ? json({ ok: true, user: { name: sess.name, email: sess.email } })
      : json({ ok: false }, 401);
  }

  if (req.method !== 'POST') return fail('Method not allowed.', 405);

  if (action === 'logout') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': clearSessionCookie(),
      },
    });
  }

  if (!sessionConfigured()) {
    console.error('[auth] AUTH_SESSION_SECRET is not set — accounts are disabled until it is configured.');
    return fail('Accounts are temporarily unavailable. Please contact support.', 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('We could not read that request.', 400);
  }

  /* ---- signup ----------------------------------------------------------- */
  if (action === 'signup') {
    const limit = await rateLimit({ bucket: 'auth-signup', id: clientIp(req), max: 20, windowMs: 60 * 60 * 1000 });
    if (!limit.ok) return fail('Too many signups from this connection. Please try again shortly.', 429);

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    const email = normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name) return fail('Please enter your name.');
    if (!EMAIL_RE.test(email)) return fail('That email address does not look right.');
    if (password.length < 8) return fail('Please choose a password of at least 8 characters.');

    const passwordHash = await hashPassword(password);
    let user;
    try {
      [user] = await db.insert(users).values({ name, email, passwordHash }).returning();
    } catch (err: any) {
      if (String(err?.message || '').includes('users_email_unique') || err?.code === '23505') {
        return fail('An account with this email already exists. Please log in instead.', 409);
      }
      console.error('[auth] signup failed:', err?.message);
      return fail('We could not create your account. Please try again.', 500);
    }
    // Active immediately: the session is minted in the same response.
    return withSession({ ok: true, user: { name: user.name, email: user.email } }, signSession(user), 201);
  }

  /* ---- login ------------------------------------------------------------ */
  if (action === 'login') {
    const limit = await rateLimit({ bucket: 'auth-login', id: clientIp(req), max: 30, windowMs: 15 * 60 * 1000 });
    if (!limit.ok) return fail('Too many login attempts. Please try again shortly.', 429);

    const email = normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email) || !password) return fail('Please enter your email and password.');

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return fail('That email and password combination is not right.', 401);
    }
    return withSession({ ok: true, user: { name: user.name, email: user.email } }, signSession(user));
  }

  /* ---- password reset: request ------------------------------------------ */
  if (action === 'reset-request') {
    const limit = await rateLimit({ bucket: 'auth-reset', id: clientIp(req), max: 10, windowMs: 60 * 60 * 1000 });
    if (!limit.ok) return fail('Too many reset requests. Please try again shortly.', 429);

    const email = normEmail(body.email);
    // The answer is identical whether or not the account exists, so the
    // endpoint cannot be used to enumerate customers.
    const done = () => json({ ok: true, message: 'If an account exists for that address, a reset link is on its way.' });
    if (!EMAIL_RE.test(email)) return done();

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return done();

    const token = randomBytes(32).toString('hex');
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.email, email));
    await db.insert(passwordResetTokens).values({
      tokenHash: sha256(token),
      email,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const origin = new URL(req.url).origin;
    const link = `${origin}/account/reset/?token=${token}`;
    if (emailConfigured()) {
      await sendEmail({
        to: email,
        subject: 'Reset your password',
        text: `Someone (hopefully you) asked to reset the password for this account.

Open this link within the next hour to choose a new password:

  ${link}

If this wasn't you, ignore this email — nothing changes.`,
      });
    } else {
      console.warn('[auth] reset requested but no email provider is configured (RESEND_API_KEY / EMAIL_FROM).');
    }
    return done();
  }

  /* ---- password reset: confirm ------------------------------------------ */
  if (action === 'reset-confirm') {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!token) return fail('That reset link is not valid.');
    if (password.length < 8) return fail('Please choose a password of at least 8 characters.');

    const [row] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, sha256(token)))
      .limit(1);
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return fail('That reset link has expired. Please request a new one.', 400);
    }

    const passwordHash = await hashPassword(password);
    const [user] = await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.email, row.email))
      .returning();
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.email, row.email));
    // Housekeeping: clear any other expired tokens while we are here.
    await db.delete(passwordResetTokens).where(lt(passwordResetTokens.expiresAt, new Date()));
    if (!user) return fail('That reset link is not valid.', 400);

    return withSession({ ok: true, user: { name: user.name, email: user.email } }, signSession(user));
  }

  return fail('Not found.', 404);
};

export const config: Config = {
  path: '/api/auth/:action',
};
