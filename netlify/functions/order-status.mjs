// GET /api/order-status?ref=AUR-XXXXXX — minimal status feed for the thank-you
// page, which polls it while the TagadaPay webhook settles the order.
// Session-gated like everything else in the catalog; the random ref is the
// per-order authorisation, and the response carries no address or payment data.
import { json, fail, orderStore } from './_lib.mjs';
import { readSession } from './_session.mjs';

export default async (req) => {
  if (req.method !== 'GET') return fail('Method not allowed.', 405);
  if (!readSession(req)) return fail('Please sign in.', 401);

  const ref = (new URL(req.url).searchParams.get('ref') || '').trim();
  if (!/^AUR-[A-Z0-9]{6}$/.test(ref)) return fail('Unknown order reference.', 400);

  const order = await orderStore().get(ref, { type: 'json' }).catch(() => null);
  if (!order) return fail('Unknown order reference.', 404);

  return json({
    ok: true,
    order: {
      ref: order.ref,
      status: order.status,
      totalFormatted: order.totalFormatted,
      createdAt: order.createdAt,
      paidAt: order.paidAt || null,
      test: order.payment?.draft === true,
      items: (order.items || []).map((i) => ({ name: i.name, meta: i.meta, qty: i.qty })),
    },
  });
};
