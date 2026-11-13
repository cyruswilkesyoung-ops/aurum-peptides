// POST /api/admin/orders/prymalab {ref}: "Send to PrymaLab" for one held order. Bearer auth
// (ADMIN_PASSWORD), same guard and failed-login cap as the other admin endpoints.
// Same send as the paid webhook: same external_id, the SKU map, the key check. Refuses an
// order that is not paid, has tracking, is a test payment, is already with PrymaLab, or was
// paid before sending began. Sending off or no key: 409 and nothing changes.
import { json, fail, adminOk, orderStore, rateLimit, clientIp } from './_lib.mjs';
import { sendToPrymalab } from './_prymalab.mjs';

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

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('We could not read that request.', 400);
  }
  const ref = typeof body?.ref === 'string' ? body.ref.trim() : '';
  if (!/^AUR-[A-Z0-9]{6}$/.test(ref)) return fail('Unknown order reference.', 400);

  const store = orderStore();
  const exists = await store.get(ref, { type: 'json' }).catch(() => null);
  if (!exists) return fail('Unknown order reference.', 404);

  const res = await sendToPrymalab(store, ref, { via: 'admin', timeouts: { me: 3000, order: 6000 } });
  if (!res.sent) {
    const status = res.skipped === 'error' ? 500 : 409;
    return json({ ok: false, error: res.why, skipped: res.skipped }, status);
  }
  return json({ ok: true, state: res.state, detail: res.detail, order: res.order });
};
