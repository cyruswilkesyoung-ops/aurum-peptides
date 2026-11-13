// POST /.netlify/functions/tagada-webhook — TagadaPay event receiver.
//
// Subscribed events (slash format): order/paid, order/failed, order/refunded.
// Every delivery is authenticated with HMAC-SHA256 over the RAW body against
// TAGADA_WEBHOOK_SECRET (header `X-TagadaPay-Signature`, value `sha256=<hex>`).
// TagadaPay's timestamp header is NOT covered by the signature, so replay
// defence is (1) dedupe on the signed body's event id and (2) a staleness
// window on the signed createdAt that exceeds the full retry schedule (~1h25).
//
// Deliveries retry on 5xx and stop on 4xx, which dictates the status codes:
// a bad signature is 401 (retrying won't fix it), a missing secret is 503
// (retry until the operator configures it), handled-but-irrelevant is 200.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getStore, getDeployStore } from '@netlify/blobs';
import { json, fail, orderStore, fmtUSD } from './_lib.mjs';
import { notifyBuyer, notifyOwnerPaid, notifyOwnerAlert } from './_email.mjs';
import { disableOrderPromotion } from './_tagada.mjs';
import { sendToPrymalab } from './_prymalab.mjs';

// PrymaLab gets a short budget inside this delivery: TagadaPay must get its answer
// well inside its own timeout. A slow or failed send is left in the PrymaLab queue
// (prymalab-retry.mjs asks again hourly, same external_id), never retried by failing
// this webhook, which would only repeat the emails.
const PRYMALAB_BUDGET = { me: 2500, order: 5500 };

const HANDLED = new Set(['order/paid', 'order/failed', 'order/refunded']);
const MAX_EVENT_AGE_MS = 2 * 60 * 60 * 1000;

export function verifySignature(rawBody, secret, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function eventLedger() {
  const isProd = globalThis.Netlify?.context?.deploy?.context === 'production';
  return isProd ? getStore('tagada-events') : getDeployStore('tagada-events');
}

/* The order ref travels in the session metadata and as a cartCustomAttribute,
   but where TagadaPay surfaces those in each event type is not pinned down by
   its docs (order_metadata is the documented home, null in their example). So:
   collect every AUR-xxxxxx-shaped candidate — metadata fields first, then the
   whole signed body — and accept the first one that actually exists in the
   order store. Refs are random, so a candidate that resolves IS the order. */
function candidateRefs(event, rawBody) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && /^AUR-[A-Z0-9]{6}$/.test(v.trim()) && !out.includes(v.trim())) out.push(v.trim());
  };
  const meta = event?.data?.order_metadata;
  push(meta?.orderRef);
  if (Array.isArray(meta?.cartCustomAttributes)) {
    for (const a of meta.cartCustomAttributes) if (a?.name === 'orderRef') push(a?.value);
  }
  push(event?.data?.metadata?.orderRef);
  push(event?.data?.order?.externalOrderId);
  for (const m of String(rawBody).match(/AUR-[A-Z0-9]{6}/g) || []) push(m);
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);

  const secret = (process.env.TAGADA_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('[tagada-webhook] TAGADA_WEBHOOK_SECRET is not set — rejecting delivery so TagadaPay retries.');
    return fail('Webhook not configured.', 503);
  }

  const rawBody = await req.text();
  if (!verifySignature(rawBody, secret, req.headers.get('x-tagadapay-signature'))) {
    console.warn('[tagada-webhook] invalid signature rejected');
    return fail('Invalid signature.', 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return fail('Malformed payload.', 400);
  }

  if (!HANDLED.has(event?.type)) return json({ ok: true, ignored: event?.type || 'unknown' });

  // Replay defence 1: staleness. createdAt is inside the signed body. 200, not
  // 4xx — the event was authentic, we are just declining to act on it again.
  const age = Date.now() - Date.parse(event.createdAt || '');
  if (!Number.isFinite(age) || age > MAX_EVENT_AGE_MS) {
    console.warn(`[tagada-webhook] stale or undated event ${event.id || '?'} rejected (age ${Math.round(age / 1000)}s)`);
    return json({ ok: true, ignored: 'stale' });
  }

  // Replay defence 2: each event id is processed once. The ledger write happens
  // after successful processing; the status transitions below make a crash
  // between processing and recording safe to re-run.
  const ledger = eventLedger();
  const eventKey = `evt-${String(event.id || '').replace(/[^A-Za-z0-9-]/g, '')}`;
  if (event.id) {
    const seen = await ledger.get(eventKey).catch(() => null);
    if (seen) return json({ ok: true, duplicate: true });
  }

  const store = orderStore();
  let ref = null;
  let order = null;
  for (const candidate of candidateRefs(event, rawBody)) {
    const found = await store.get(candidate, { type: 'json' }).catch(() => null);
    if (found) { ref = candidate; order = found; break; }
  }
  if (!order) {
    // Authentic event about an order this site doesn't know — likely money with
    // no row to mark. A human needs to look either way; retrying will not help.
    console.error(`[tagada-webhook] ${event.type} ${event.id || ''} matched no order (candidates: ${candidateRefs(event, rawBody).join(', ') || 'none'})`);
    await notifyOwnerAlert(
      `TagadaPay ${event.type} did not match any order`,
      `A verified TagadaPay "${event.type}" webhook (event ${event.id || 'without id'}, TagadaPay order ${event.data?.orderId || '?'}) could not be matched to any order reference.\n\nCheck Integrations → Webhooks → Deliveries in the TagadaPay CRM and the /admin/ panel.`
    );
    if (event.id) await ledger.setJSON(eventKey, { at: Date.now(), type: event.type, unmatched: true }).catch(() => {});
    return json({ ok: true, unmatched: true });
  }

  const data = event.data || {};
  const isDraft = data.draft === true;

  if (event.type === 'order/paid') {
    // Idempotent: a repeat paid event for a settled order changes nothing.
    if (order.status === 'paid' || order.status === 'shipped') {
      if (event.id) await ledger.setJSON(eventKey, { at: Date.now(), type: event.type, ref }).catch(() => {});
      return json({ ok: true, already: order.status });
    }

    const paid = data.order || {};
    // totalAdjustedAmount is what the buyer was actually charged (after the
    // bundle promotion); paidAmount is the fallback. Both minor units.
    const paidCents = Number.isFinite(paid.totalAdjustedAmount) ? paid.totalAdjustedAmount : paid.paidAmount;
    const expectedCents = Math.round(Number(order.total) * 100);

    // Fill in what TagadaPay's checkout collected: the shipping address the
    // site no longer asks for, plus phone. Never overwrite the account email.
    const addr = paid.shippingAddress || paid.billingAddress || {};
    order.customer = {
      ...order.customer,
      name: order.customer.name || [addr.firstName, addr.lastName].filter(Boolean).join(' '),
      // The name on the parcel, which can differ from the account name. PrymaLab ships to it.
      shipName: [addr.firstName, addr.lastName].filter(Boolean).join(' ') || order.customer.shipName || '',
      address1: addr.address1 || order.customer.address1 || '',
      address2: addr.address2 || order.customer.address2 || '',
      city: addr.city || order.customer.city || '',
      state: addr.state || order.customer.state || '',
      postal: addr.postal || order.customer.postal || '',
      country: addr.country || order.customer.country || '',
      phone: addr.phone || order.customer.phone || '',
    };
    order.payment = {
      provider: 'tagadapay',
      orderId: data.orderId || null,
      paymentId: data.paymentId || null,
      orderNumber: paid.orderNumber ?? null,
      amountCents: Number.isFinite(paidCents) ? paidCents : null,
      currency: paid.currency || 'USD',
      draft: isDraft,
      eventId: event.id || null,
    };

    if (!Number.isFinite(paidCents) || paidCents !== expectedCents) {
      // Paid, but not the amount this site computed. Never auto-confirm a
      // mismatch: hold it for a human and say exactly what disagreed.
      order.status = 'payment_review';
      order.updatedAt = new Date().toISOString();
      await store.setJSON(ref, order);
      await notifyOwnerAlert(
        `Order ${ref}: paid amount mismatch — needs review`,
        `TagadaPay reports ${fmtUSD((paidCents || 0) / 100)} paid for order ${ref}, but the site's total is ${order.totalFormatted}.\n\nThe order is held as "payment_review" and the buyer has NOT been emailed. Check /admin/ and the TagadaPay CRM order ${data.orderId || ''}.${isDraft ? '\n\nNOTE: this was a TEST (draft) payment.' : ''}`
      );
      if (event.id) await ledger.setJSON(eventKey, { at: Date.now(), type: event.type, ref, mismatch: true }).catch(() => {});
      return json({ ok: true, held: 'payment_review' });
    }

    order.status = 'paid';
    order.paidAt = paid.paidAt || event.createdAt;
    order.updatedAt = new Date().toISOString();
    await store.setJSON(ref, order);

    // Money is recorded; everything after this point is best-effort and must
    // never turn the delivery into a retry (which would just repeat the emails).
    await disableOrderPromotion(order).catch(() => {});
    // The supplier send and the emails run side by side. sendToPrymalab never throws and,
    // with PRYMALAB_SEND not "on" or no key, does nothing at all.
    await Promise.allSettled([
      sendToPrymalab(store, ref, { via: 'paid-webhook', timeouts: PRYMALAB_BUDGET }),
      (async () => {
        try {
          const emailedBuyer = await notifyBuyer(order, 'paid');
          const emailedOwner = await notifyOwnerPaid(order, new URL(req.url).origin, { draft: isDraft });
          if (!emailedBuyer || !emailedOwner) console.warn(`[tagada-webhook] ${ref} paid; buyer emailed: ${emailedBuyer}, owner emailed: ${emailedOwner}`);
        } catch (err) {
          console.error(`[tagada-webhook] ${ref} paid but notification failed:`, err?.message);
        }
      })(),
    ]);
    if (event.id) await ledger.setJSON(eventKey, { at: Date.now(), type: event.type, ref }).catch(() => {});
    return json({ ok: true, ref, status: 'paid' });
  }

  if (event.type === 'order/failed') {
    // Only a pending order moves to payment_failed — a failed retry after a
    // successful payment must never un-pay the order.
    if (order.status === 'pending_payment') {
      order.status = 'payment_failed';
      order.updatedAt = new Date().toISOString();
      order.payment = { provider: 'tagadapay', orderId: data.orderId || null, failedAt: event.createdAt, draft: isDraft, eventId: event.id || null };
      await store.setJSON(ref, order);
    }
    if (event.id) await ledger.setJSON(eventKey, { at: Date.now(), type: event.type, ref }).catch(() => {});
    return json({ ok: true, ref, status: order.status });
  }

  // order/refunded — keep the history, flag for the owner. refundAmount may be
  // absent on simulator-fired events, so it is reported only when present.
  order.status = 'refunded';
  order.updatedAt = new Date().toISOString();
  order.refund = {
    at: event.createdAt,
    amountCents: Number.isFinite(data.refundAmount) ? data.refundAmount : null,
    totalRefundedCents: Number.isFinite(data.totalRefundedAmount) ? data.totalRefundedAmount : null,
    eventId: event.id || null,
  };
  await store.setJSON(ref, order);
  await notifyOwnerAlert(
    `Order ${ref} refunded`,
    `TagadaPay reports a refund on order ${ref}${Number.isFinite(data.refundAmount) ? ` of ${fmtUSD(data.refundAmount / 100)}` : ''}.\n\nThe order is now marked "refunded" in /admin/.`
  );
  if (event.id) await ledger.setJSON(eventKey, { at: Date.now(), type: event.type, ref }).catch(() => {});
  return json({ ok: true, ref, status: 'refunded' });
};
