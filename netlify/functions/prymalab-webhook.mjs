// POST /api/webhooks/prymalab: PrymaLab's order webhook (received, processing, fulfilled with
// carrier and tracking, complete, on hold, cancelled). This is the address to give PrymaLab.
//
// SECURITY: X-PrymaLab-Signature is the hex HMAC-SHA256 of the RAW body with the account's
// signing secret (PRYMALAB_WEBHOOK_SECRET), checked in constant time before anything is read.
// Fails closed: no secret is 503 (PrymaLab retries), a bad signature is 401, and neither
// changes anything. The event must name this store's own PrymaLab account (partner ID in
// _prymalab-skus.json) and an order this store really sent and PrymaLab accepted. Tracking is
// written once only and turns a paid order to shipped. Nothing from the body is logged.
import { json, fail, orderStore } from './_lib.mjs';
import { notifyBuyer, notifyOwnerAlert } from './_email.mjs';
import { verifyPrymalabSignature, trackingOf, PARTNER_ID } from './_prymalab.mjs';

const ignored = (why) => json({ ok: true, ignored: why });
const MAX_BODY = 262144;
const LIVE = new Set(['submitted', 'held_balance', 'retrying', 'stopped']);

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);
  const secret = (process.env.PRYMALAB_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    console.error('[prymalab-webhook] PRYMALAB_WEBHOOK_SECRET is not set; delivery refused');
    return fail('Webhook not configured.', 503);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail('Too large.', 413);
  if (!verifyPrymalabSignature(raw, req.headers.get('x-prymalab-signature'), secret)) {
    console.warn('[prymalab-webhook] invalid signature rejected');
    return fail('Invalid signature.', 401);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail('Malformed payload.', 400);
  }
  if (!body || typeof body !== 'object') return ignored('no event');
  const event = String(req.headers.get('x-prymalab-event') ?? body.event ?? body.type ?? '').toLowerCase().slice(0, 40);
  if (!event.startsWith('order.')) return ignored('not an order event');
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  if (String(body.partner_id ?? data.partner_id ?? '') !== PARTNER_ID) return ignored('another account');
  const po = data.order && typeof data.order === 'object' ? data.order : data;
  const ref = typeof po.external_id === 'string' ? po.external_id.trim() : '';
  if (!/^AUR-[A-Z0-9]{6}$/.test(ref)) return ignored('no order reference');

  const store = orderStore();
  let order;
  try {
    order = await store.get(ref, { type: 'json' });
  } catch {
    return fail('Could not read order.', 500);
  }
  const pr = order?.prymalab;
  // Only an order this store sent, and PrymaLab may hold, can be moved by a webhook. retrying and
  // stopped are included: a lost answer can still mean PrymaLab created the order.
  if (!order || !pr || !LIVE.has(pr.state)) return ignored('not an order this store sent');
  if (pr.supplier_order_id && po.id != null && String(po.id) !== String(pr.supplier_order_id)) return ignored('another supplier order');

  const t = trackingOf(po);
  const now = new Date().toISOString();
  let shipped = false;
  let cancelled = false;
  order.prymalab = { ...pr, supplier_status: t.status || event.slice(6) || pr.supplier_status, lastEventAt: now };
  if (!pr.supplier_order_id && po.id != null) order.prymalab.supplier_order_id = String(po.id).slice(0, 80);

  if (event === 'order.cancelled') {
    cancelled = pr.state !== 'supplier_cancelled';
    order.prymalab.state = 'supplier_cancelled';
    order.prymalab.detail = 'PrymaLab cancelled this order on its side, so it will not ship from there. Check it in the PrymaLab dashboard.';
  } else if (event === 'order.on_hold') {
    order.prymalab.detail = 'PrymaLab put this order on hold on its side. Check it in the PrymaLab dashboard.';
  } else {
    // Any progress from PrymaLab means it is taking the order: an invoice-held order is now on its way.
    if (pr.state !== 'submitted') {
      order.prymalab.state = 'submitted';
      order.prymalab.detail = 'PrymaLab is working on the order.';
    }
    if (t.tracking_number && !order.tracking && order.status === 'paid') {
      order.tracking = t.tracking_number;
      order.status = 'shipped';
      order.shippedAt = t.shipped_at || now;
      order.prymalab.carrier = t.carrier;
      order.prymalab.detail = `Shipped by PrymaLab${t.carrier ? ` with ${t.carrier}` : ''}.`;
      shipped = true;
    }
  }
  order.updatedAt = now;

  try {
    await store.setJSON(ref, order);
  } catch {
    // Ours to fix: a 5xx makes PrymaLab deliver it again.
    return fail('Could not record.', 500);
  }

  if (shipped) {
    try {
      const emailed = await notifyBuyer(order, 'shipped');
      if (!emailed) console.warn(`[prymalab-webhook] ${ref} shipped; buyer not emailed`);
    } catch {
      console.warn(`[prymalab-webhook] ${ref} shipped; buyer email failed`);
    }
  }
  if (cancelled) {
    await notifyOwnerAlert(
      `Order ${ref}: PrymaLab cancelled it`,
      `PrymaLab reports order ${ref} as cancelled on its side, so it will not ship from PrymaLab.\n\nCheck it in the PrymaLab dashboard and in /admin/.`
    ).catch(() => {});
  }
  return json({ ok: true, ref, shipped });
};
