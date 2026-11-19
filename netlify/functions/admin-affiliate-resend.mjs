// POST /api/admin/orders/affiliate — send an order's current status to the partner app again.
// Bearer auth. Safe to repeat: the app keys on order_id.
import { json, fail, adminOk, orderStore, rateLimit, clientIp } from './_lib.mjs';
import { reportAffiliateOrder } from './_affiliate.mjs';

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);
  if (!adminOk(req)) {
    const l = await rateLimit({ bucket: 'admin-auth', id: clientIp(req), max: 10, windowMs: 15 * 60 * 1000 });
    if (!l.ok) return fail('Too many attempts. Try again later.', 429);
    return fail('Not authorised.', 401);
  }
  let body;
  try { body = await req.json(); } catch { return fail('We could not read that request.', 400); }
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!/^AUR-[A-Z0-9]{6}$/.test(ref)) return fail('Unknown order reference.', 400);
  const order = await orderStore().get(ref, { type: 'json' }).catch(() => null);
  if (!order) return fail('Unknown order reference.', 404);
  if (!order.affiliate?.code) return fail('This order has no referral code.', 400);
  const r = await reportAffiliateOrder(order, order.status, { ms: 8000 });
  if (!r.sent) return fail(`Not sent: ${r.reason}.`, 400);
  if (!r.ok) return fail('The partner app did not accept it. Try again shortly.', 502);
  return json({ ok: true });
};
