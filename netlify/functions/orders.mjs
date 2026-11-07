// POST /api/orders — create a pending order and hand the buyer to TagadaPay.
//
// The browser sends identifiers only (js/app.js). Every number below is rebuilt
// server-side from the generated catalogue; nothing the client sends about price,
// subtotal or total is read. The shipping address is collected by TagadaPay's
// checkout and written back onto the order by the order/paid webhook
// (tagada-webhook.mjs), so this endpoint only takes contact details and consent.
import { json, fail, priceOrder, orderStore, newRef, fmtUSD, rateLimit, clientIp }
  from './_lib.mjs';
import { createTagadaCheckout, CheckoutUnavailable } from './_tagada.mjs';
import { readSession } from './_session.mjs';

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);

  // The edge gate already turns anonymous requests away at /api/orders, but this
  // function is also reachable at its /.netlify/functions/ address, so the session
  // is re-verified here. The catalog is account-gated; so is ordering from it.
  const session = readSession(req);
  if (!session) return fail('Please sign in to place an order.', 401);

  // Before parsing anything: a script looping on this endpoint fills the order store
  // AND creates TagadaPay sessions, so spam costs more than it used to. Generous
  // enough that a real buyer retrying a failed payment never sees it.
  const limit = await rateLimit({ bucket: 'orders', id: clientIp(req), max: 8, windowMs: 60 * 60 * 1000 });
  if (!limit.ok) {
    console.warn('[orders] rate limited', clientIp(req));
    return new Response(
      JSON.stringify({ ok: false, error: 'Too many orders from this connection. Please try again shortly.' }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(limit.retryAfter) } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('We could not read that request.', 400);
  }

  // Honeypot. A real person never fills a field they cannot see, so a value here is a
  // bot. Answer 200 with a plausible-looking failure rather than 400: a bot that gets a
  // clear error learns to leave the field alone next time.
  if (typeof body.company === 'string' && body.company.trim()) {
    console.warn('[orders] honeypot tripped');
    return json({ ok: false, error: 'We could not place this order.' }, 200);
  }

  if (body.ageConfirm !== true) return fail('Please confirm you are 21 or older.');
  if (body.researchConfirm !== true) return fail('Please confirm the research-use acknowledgment.');

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const customer = {
    name: str(body.name, 120),
    email: str(body.email, 200),
    notes: str(body.notes, 1000),
  };
  for (const field of ['name', 'email']) {
    if (!customer[field]) return fail('Please complete every required field.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) {
    return fail('That email address does not look right.');
  }

  let priced;
  try {
    priced = priceOrder(body.items);
  } catch (err) {
    return fail(err.message, 400);
  }

  const order = {
    ref: newRef(),
    createdAt: new Date().toISOString(),
    status: 'pending_payment',
    customer,
    items: priced.items,
    subtotal: priced.subtotal,
    shipping: priced.shipping,
    total: priced.total,
    totalFormatted: fmtUSD(priced.total),
    tracking: '',
    consent: { age21: true, researchUse: true },
    userId: session.sub,
  };

  const store = orderStore();
  try {
    await store.setJSON(order.ref, order);
  } catch (err) {
    console.error('[orders] could not persist order:', err);
    return fail('We could not place this order. Please try again.', 500);
  }

  // Hand off to TagadaPay. The order exists first so its ref can ride in the
  // session metadata; if the hand-off fails the row is removed again — an order
  // that never reached the payment page is not worth keeping or alerting on.
  const [firstName, ...rest] = customer.name.split(/\s+/);
  const checkout = globalThis.__TAGADA_STUB__ || createTagadaCheckout;
  try {
    const handoff = await checkout(order, {
      origin: new URL(req.url).origin,
      customer: { email: customer.email, firstName, lastName: rest.join(' ') || undefined },
    });
    order.tagada = {
      checkoutToken: handoff.checkoutToken,
      funnelSessionId: handoff.funnelSessionId,
      promotionId: handoff.promotionId || null,
      discountCents: handoff.discountCents || 0,
    };
    await store.setJSON(order.ref, order);
    return json({ ok: true, url: handoff.url, order: { ref: order.ref, total: order.total, totalFormatted: order.totalFormatted } });
  } catch (err) {
    try { await store.delete(order.ref); } catch { /* a stray pending row is harmless */ }
    if (err instanceof CheckoutUnavailable) {
      return json({ ok: false, error: err.message, retryable: err.retryable }, err.status);
    }
    console.error('[orders] unexpected hand-off failure:', err);
    return json({ ok: false, error: 'We could not start the payment. Please try again.', retryable: true }, 502);
  }
};
