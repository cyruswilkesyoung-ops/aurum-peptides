/* Order notifications.
   ---------------------------------------------------------------------------
   Without this the owner has to sit refreshing /admin/ to find out a sale
   happened, which is not a workflow anybody keeps up for long.

   Two rules shape everything below.

   1. Email is never allowed to cost an order. Every send is wrapped, timed out,
      and swallowed. A dead provider, a bad key, a rate limit, a hung socket:
      the order is already written and the buyer already has their payment
      instructions before any of this runs.
   2. Nothing lies. If no key is configured we say so and report emailed:false,
      rather than letting the panel tell Cyrus a buyer was told something they
      were not.

   Provider is Resend, which is what /guide/ already documents. */

const API = 'https://api.resend.com/emails';
const TIMEOUT_MS = 5000;

export const emailConfigured = () =>
  Boolean(process.env.RESEND_API_KEY && (process.env.EMAIL_FROM || '').trim());

/* Resolves to true only if the provider accepted the message. Never throws. */
async function send({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = (process.env.EMAIL_FROM || '').trim();
  if (!key || !from || !to) return false;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      // Status and provider message only. The key is never logged.
      const detail = await res.text().catch(() => '');
      console.error(`[email] provider refused (${res.status}): ${detail.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[email] send failed: ${err?.name === 'AbortError' ? `no response in ${TIMEOUT_MS}ms` : err?.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const money = (n) => `$${Number(n).toFixed(2)}`;

const lines = (o) =>
  o.items.map((i) => `  ${i.qty} x ${i.name} (${i.meta}) ${money(i.lineTotal)}`).join('\n');

const shipTo = (c) =>
  [c.name, c.address1, c.address2, `${c.city}, ${c.state} ${c.postal}`, c.country]
    .filter(Boolean)
    .join('\n  ');

/* ---- to the owner, the moment an order lands ---------------------------- */
export async function notifyOwner(order, siteUrl) {
  const to = (process.env.ADMIN_EMAIL || '').trim();
  if (!to) return false;

  const text = `New order ${order.ref} for ${money(order.total)}.

ITEMS
${lines(order)}

  Subtotal ${money(order.subtotal)}
  Shipping ${order.shipping > 0 ? money(order.shipping) : 'free'}
  Total    ${money(order.total)}

BUYER
  ${order.customer.name}
  ${order.customer.email}

SHIP TO
  ${shipTo(order.customer)}
${order.customer.notes ? `\nNOTES\n  ${order.customer.notes}\n` : ''}
This order is not paid yet. When the funds land, match the memo to ${order.ref},
then mark it paid here:

  ${siteUrl}/admin/
`;

  return send({ to, subject: `New order ${order.ref} — ${money(order.total)}`, text });
}

/* ---- to the buyer, when the owner changes the status -------------------- */
export async function notifyBuyer(order, status) {
  const to = (order.customer?.email || '').trim();
  if (!to) return false;

  if (status === 'paid') {
    return send({
      to,
      subject: `Payment received — order ${order.ref}`,
      text: `Thanks, we've matched your payment to order ${order.ref}.

Your order is being prepared. You'll get another email with tracking once it
ships.

  Total ${money(order.total)}
`,
    });
  }

  if (status === 'shipped') {
    return send({
      to,
      subject: `Order ${order.ref} has shipped`,
      text: `Order ${order.ref} is on its way.
${order.tracking ? `\n  Tracking: ${order.tracking}\n` : ''}
Shipping to:
  ${shipTo(order.customer)}
`,
    });
  }

  if (status === 'cancelled') {
    return send({
      to,
      subject: `Order ${order.ref} cancelled`,
      text: `Order ${order.ref} has been cancelled.

If you've already sent payment, reply to this email and we'll sort it out.
`,
    });
  }

  return false;
}
