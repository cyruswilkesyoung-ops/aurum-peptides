// POST /api/orders — place an order and return payment instructions.
//
// The browser sends identifiers only (js/app.js:410). Every number below is rebuilt
// server-side from the generated catalogue; nothing the client sends about price,
// subtotal or total is read.
import { json, fail, priceOrder, paymentMethods, orderStore, newRef, fmtUSD, rateLimit, clientIp }
  from './_lib.mjs';
import { notifyOwner, emailConfigured } from './_email.mjs';

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);

  // Before parsing anything: a script looping on this endpoint fills the order store,
  // and the admin list reads every order on every load, so spam degrades the panel too.
  // Generous enough that a real buyer placing a few orders never sees it.
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
    address1: str(body.address1, 200),
    address2: str(body.address2, 200),
    city: str(body.city, 100),
    state: str(body.state, 60),
    postal: str(body.postal, 20),
    country: str(body.country, 60) || 'United States',
    notes: str(body.notes, 1000),
  };
  for (const field of ['name', 'email', 'address1', 'city', 'state', 'postal']) {
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

  // Refuse before writing anything if there is no way to be paid. An order with no
  // payment instructions strands the buyer and leaves the owner a row that will never
  // settle — better a loud failure the owner hears about on day one.
  const methods = paymentMethods();
  if (!methods.length) {
    console.error('[orders] REFUSED: no payment method configured. Set one of CRYPTO_BTC_ADDRESS, CRYPTO_ETH_ADDRESS, CRYPTO_USDT_ADDRESS, CRYPTO_USDC_ADDRESS, CASHAPP_CASHTAG or ZELLE_CONTACT in Netlify, then REDEPLOY. Variables do not apply to running functions until the site rebuilds.');
    return fail('Checkout is temporarily unavailable. Please contact support.', 503);
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
  };

  try {
    await orderStore().setJSON(order.ref, order);
  } catch (err) {
    console.error('[orders] could not persist order:', err);
    return fail('We could not place this order. Please try again.', 500);
  }

  /* The order is safely stored by this point, so the email is strictly a bonus.
     It is awaited rather than left dangling because the function process can be
     frozen the moment we return, which would kill an in-flight request. It
     cannot throw, and it gives up after 5s. */
  try {
    // Only worth a warning when a provider IS configured and still did not deliver.
    // A site running without email is a deliberate state, not an incident.
    const sent = await notifyOwner(order, new URL(req.url).origin);
    if (!sent && emailConfigured()) {
      console.warn(`[orders] ${order.ref} stored but the owner was not emailed`);
    }
  } catch (err) {
    console.error('[orders] notify failed after the order was stored:', err?.message);
  }

  return json({
    ok: true,
    order: {
      ref: order.ref, subtotal: order.subtotal, shipping: order.shipping,
      total: order.total, totalFormatted: order.totalFormatted,
    },
    methods,
    confirmWindow: process.env.ORDER_CONFIRM_WINDOW || '24 hours',
    supportEmail: process.env.SUPPORT_EMAIL || 'support@aurumpeptides.com',
  });
};
