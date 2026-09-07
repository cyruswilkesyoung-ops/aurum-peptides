// POST /api/admin/orders/update — set an order's status and/or tracking. Bearer auth.
import { json, fail, adminOk, orderStore, rateLimit, clientIp } from './_lib.mjs';
import { notifyBuyer, emailConfigured } from './_email.mjs';

const STATUSES = new Set(['pending_payment', 'paid', 'shipped', 'cancelled']);

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);
  // A single shared password with no cap is an unlimited guessing budget. Counted per
  // IP and only on FAILURE, so a legitimate admin working through the panel is never
  // throttled by their own successful requests.
  if (!adminOk(req)) {
    const l = await rateLimit({ bucket: 'admin-auth', id: clientIp(req), max: 10, windowMs: 15 * 60 * 1000 });
    if (!l.ok) {
      console.warn('[admin] auth attempts rate limited', clientIp(req));
      return fail('Too many attempts. Try again later.', 429);
    }
    return fail('Not authorised.', 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('We could not read that request.', 400);
  }

  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  // The ref is interpolated into a blob key; allowlist its shape so a crafted value
  // cannot address anything but an order.
  if (!/^AUR-[A-Z0-9]{6}$/.test(ref)) return fail('Unknown order reference.', 400);

  const store = orderStore();
  const order = await store.get(ref, { type: 'json' }).catch(() => null);
  if (!order) return fail('Unknown order reference.', 404);

  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) return fail('Unknown status.', 400);
    order.status = body.status;
  }
  if (body.tracking !== undefined) {
    order.tracking = String(body.tracking).trim().slice(0, 80);
    if (order.tracking && order.status === 'pending_payment') order.status = 'shipped';
  }
  order.updatedAt = new Date().toISOString();

  try {
    await store.setJSON(ref, order);
  } catch (err) {
    console.error('[admin-orders-update] write failed:', err);
    return fail('Could not update that order.', 500);
  }

  // `notify` asks us to email the buyer. emailed:false is returned whenever the message
  // did not actually go out, so the panel never tells Cyrus a buyer was informed when
  // they were not. The status change is already saved by this point and stands either way.
  let emailed = false;
  if (body.notify === true) {
    if (!emailConfigured()) {
      console.warn(`[admin-orders-update] notify requested for ${ref} but no email provider is configured`);
    } else {
      emailed = await notifyBuyer(order, order.status);
      if (!emailed) console.warn(`[admin-orders-update] ${ref} updated but the buyer was not emailed`);
    }
  }

  return json({ ok: true, order, emailed });
};
