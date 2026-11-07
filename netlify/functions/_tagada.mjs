// TagadaPay integration: checkout sessions, funnel hand-off, per-order discounts.
// ---------------------------------------------------------------------------
// The site's totals are authoritative (priceOrder in _lib.mjs). TagadaPay prices
// come from its own variant records, which match the catalog's single-vial prices
// to the cent (verified by tests/pricing.test.mjs against _tagada-map.json) but
// know nothing about the Buy 3 / Buy 5 bundle discounts. TagadaPay offers no
// per-line price override — only variantId + quantity — so the bundle saving is
// applied as a one-off, order-specific promotion code (code = the order ref) for
// the exact difference in cents. Shipping is pinned with externalShipping +
// lockShippingRate so the hosted checkout cannot pick a different rate. Result:
// the amount TagadaPay charges always equals the site's total.
import Tagada from '@tagadapay/node-sdk';
import { createHeadlessClient } from '@tagadapay/headless-sdk';
import tagadaMap from './_tagada-map.json' with { type: 'json' };

const env = (n) => (process.env[n] || '').trim();

const REQUIRED = ['TAGADA_STORE_ID', 'TAGADA_ACCOUNT_ID', 'TAGADA_FUNNEL_ID', 'TAGADA_FUNNEL_STEP_ID', 'TAGADA_API_KEY'];
export const missingTagadaEnv = () => REQUIRED.filter((n) => !env(n));

/* Buyer-facing error. `retryable` tells the checkout page whether "try again"
   is honest advice (network blip) or not (config problem — contact support). */
export class CheckoutUnavailable extends Error {
  constructor(message, { retryable = true, status = 502 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

/* ---- cart mapping -----------------------------------------------------------
   Takes the server-priced lines (never the client's) and produces TagadaPay
   line items. A bundle line of qty×bundleQty vials becomes that many units of
   the mapped variant; the same variant across lines is merged because TagadaPay
   treats items as a flat list. Also returns what TagadaPay will charge for
   those units at full price, so the discount can be computed exactly. */
export function toTagadaItems(pricedItems) {
  const byVariant = new Map();
  let fullPriceCents = 0;
  for (const line of pricedItems) {
    const product = tagadaMap.products[line.slug];
    const variant = product?.variants?.[String(line.variant)];
    if (!variant) {
      // A product on the site but missing from the TagadaPay map cannot be
      // charged correctly. Refuse loudly instead of silently dropping the line.
      throw new CheckoutUnavailable(
        `${line.name} cannot be paid online yet. Please contact support.`,
        { retryable: false, status: 503 }
      );
    }
    const units = line.bundleQty * line.qty;
    fullPriceCents += variant.priceCentsUSD * units;
    byVariant.set(variant.variantId, (byVariant.get(variant.variantId) || 0) + units);
  }
  const items = [...byVariant].map(([variantId, quantity]) => ({ variantId, quantity }));
  return { items, fullPriceCents };
}

/* ---- error translation ---------------------------------------------------- */
function translate(err, stage) {
  // Typed errors from @tagadapay/headless-sdk carry .code; auth/validation
  // failures are configuration problems a retry will not fix.
  const code = err?.code || '';
  const name = err?.name || '';
  console.error(`[tagada] ${stage} failed (${name}${code ? ` ${code}` : ''}):`, err?.message);
  if (name === 'TagadaAuthError' || code === 'missing_account_id' || err?.statusCode === 401 || err?.statusCode === 403) {
    return new CheckoutUnavailable('Online payment is temporarily unavailable. Please contact support.', { retryable: false, status: 503 });
  }
  if (name === 'TagadaValidationError' || code === 'no_cart_loaded') {
    return new CheckoutUnavailable('We could not start the payment for this cart. Please contact support.', { retryable: false, status: 502 });
  }
  // TagadaNetworkError and anything unknown: transient, worth retrying.
  return new CheckoutUnavailable('We could not reach our payment provider. Please try again.', { retryable: true, status: 502 });
}

/* ---- the hand-off -----------------------------------------------------------
   1. (if bundles saved money) create a one-off fixed-amount promotion whose
      code is the order ref, worth exactly fullPrice − siteSubtotal;
   2. create the checkout session server-side from the mapped items;
   3. load that session into the headless client and funnel.navigate() to get
      the redirect URL, pinning shipping to the site's computed amount.
   Returns { url, funnelSessionId, checkoutToken, promotionId }. */
export async function createTagadaCheckout(order, { origin, customer = {} }) {
  const missing = missingTagadaEnv();
  if (missing.length) {
    console.error('[tagada] missing environment variables:', missing.join(', '));
    throw new CheckoutUnavailable('Online payment is not configured yet. Please contact support.', { retryable: false, status: 503 });
  }

  const storeId = env('TAGADA_STORE_ID');
  const { items, fullPriceCents } = toTagadaItems(order.items);

  const siteSubtotalCents = Math.round(order.subtotal * 100);
  const shippingCents = Math.round(order.shipping * 100);
  const discountCents = fullPriceCents - siteSubtotalCents;
  if (discountCents < 0) {
    // The map's prices are LOWER than the site's — charging through TagadaPay
    // would undercharge silently. Regenerate the map before taking money.
    console.error(`[tagada] ${order.ref}: map subtotal ${fullPriceCents}¢ < site subtotal ${siteSubtotalCents}¢ — price maps disagree`);
    throw new CheckoutUnavailable('Online payment is temporarily unavailable. Please contact support.', { retryable: false, status: 503 });
  }

  const node = new Tagada(env('TAGADA_API_KEY'));
  const returnUrl = `${origin}/order/?ref=${encodeURIComponent(order.ref)}`;

  // 1 — exact-amount promotion for the bundle savings, redeemable by code only.
  let promotionId = null;
  if (discountCents > 0) {
    try {
      const promo = await node.promotions.create({
        storeId,
        name: `Bundle savings ${order.ref}`,
        enabled: true,
        automatic: false,
        actions: [{
          type: 'OrderAdjustment',
          adjustmentType: 'amount',
          adjustmentAmount: {
            USD: { amount: discountCents, rate: 1, lock: false, date: new Date().toISOString().slice(0, 10) },
          },
        }],
      });
      promotionId = promo?.id || promo?.promotion?.id || null;
      if (!promotionId) throw new Error('promotion id missing from create response');
      await node.promotionCodes.create({ promotionId, code: order.ref, active: true });
    } catch (err) {
      await cleanupPromotion(node, promotionId, storeId);
      throw translate(err, 'promotion create');
    }
  }

  // 2 — checkout session from the mapped cart. The order ref rides along both as
  // session metadata and as a cart custom attribute (which surfaces on the order
  // and in the order/paid webhook), so the webhook can match the order.
  let session;
  try {
    session = await node.checkout.createSession({
      storeId,
      currency: 'USD',
      items,
      returnUrl,
      customerEmail: customer.email || undefined,
      customerFirstName: customer.firstName || undefined,
      customerLastName: customer.lastName || undefined,
      discountCodes: discountCents > 0 ? [order.ref] : undefined,
      metadata: {
        orderRef: order.ref,
        cartCustomAttributes: [{ name: 'orderRef', value: order.ref }],
      },
      draft: env('TAGADA_TEST_MODE') === 'true' || undefined,
    });
  } catch (err) {
    await cleanupPromotion(node, promotionId, storeId);
    throw translate(err, 'checkout.createSession');
  }

  const redirect = new URL(session.redirectUrl);
  const sessionToken = redirect.searchParams.get('token') || redirect.searchParams.get('sessionToken') || undefined;
  const checkoutToken = session.checkoutToken || redirect.searchParams.get('checkoutToken');
  if (!checkoutToken) {
    await cleanupPromotion(node, promotionId, storeId);
    console.error('[tagada] createSession returned no checkoutToken; redirectUrl host:', redirect.host);
    throw new CheckoutUnavailable('We could not start the payment. Please try again.', { retryable: true, status: 502 });
  }

  // 3 — funnel hand-off. loadSession() first: navigate() sources the cart,
  // currency, email and promo code from the loaded session.
  try {
    const headless = createHeadlessClient({
      storeId,
      accountId: env('TAGADA_ACCOUNT_ID'),
      environment: env('TAGADA_ENVIRONMENT') || 'production',
    });
    await headless.checkout.loadSession(checkoutToken, sessionToken);
    const { url, funnelSessionId } = await headless.funnel.navigate({
      funnelId: env('TAGADA_FUNNEL_ID'),
      stepId: env('TAGADA_FUNNEL_STEP_ID'),
      returnUrl,
      metadata: { orderRef: order.ref, lockShippingRate: true },
      // The site's shipping is settled before hand-off ($9.95 flat, free at
      // $150+), and 0 deliberately pins the free rate.
      externalShipping: { amount: shippingCents, currency: 'USD' },
      currentUrl: `${origin}/checkout/`,
    });
    return { url, funnelSessionId, checkoutToken, promotionId, discountCents, shippingCents };
  } catch (err) {
    await cleanupPromotion(node, promotionId, storeId);
    throw translate(err, 'funnel.navigate');
  }
}

/* One-off promotions are single-purpose; delete on any failure so an
   abandoned code can never be replayed against a different cart. Best-effort:
   a cleanup failure is logged, never thrown. */
async function cleanupPromotion(node, promotionId, storeId) {
  if (!promotionId) return;
  try {
    await node.promotions.del([promotionId], storeId);
  } catch (err) {
    console.warn(`[tagada] could not delete promotion ${promotionId}:`, err?.message);
  }
}

/* Called by the webhook once an order reaches a terminal state, so the
   order-specific code cannot be reused. Best-effort. */
export async function disableOrderPromotion(order) {
  const promotionId = order?.tagada?.promotionId;
  if (!promotionId || !env('TAGADA_API_KEY')) return;
  const node = new Tagada(env('TAGADA_API_KEY'));
  await cleanupPromotion(node, promotionId, env('TAGADA_STORE_ID'));
}
