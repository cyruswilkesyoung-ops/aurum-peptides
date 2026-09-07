// POST /api/admin/orders — list orders for the admin panel. Bearer auth.
import { json, fail, adminOk, orderStore, rateLimit, clientIp } from './_lib.mjs';

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

  const store = orderStore();
  let orders = [];
  try {
    const { blobs } = await store.list();
    orders = (
      await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)))
    ).filter(Boolean);
  } catch (err) {
    console.error('[admin-orders] list failed:', err);
    return fail('Could not load orders.', 500);
  }

  orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  // "revenue" counts money actually collected — paid and shipped only. Counting
  // pending_payment here would show income for orders nobody has sent a cent for.
  const totals = orders.reduce(
    (acc, o) => {
      acc.count += 1;
      acc[o.status] = (acc[o.status] || 0) + 1;
      if (o.status === 'paid' || o.status === 'shipped') acc.revenue += Number(o.total) || 0;
      return acc;
    },
    { count: 0, revenue: 0 }
  );
  totals.revenue = Math.round(totals.revenue * 100) / 100;

  return json({ ok: true, orders, totals });
};
