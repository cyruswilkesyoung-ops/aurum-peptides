# auraa: owner setup and day-to-day orders

This file lives under `netlify/`, which the site never serves. It replaces the
"Environment variables" and "Confirming an order" sections of the old public
/guide/ page, removed 2026-09-18. Manual payment (Zelle / Cash App / crypto)
was replaced by TagadaPay card checkout in November 2026.

## Environment variables (Netlify: Site configuration > Environment variables)

After changing a variable, trigger a redeploy; Netlify does not apply it to
running functions until the site rebuilds.

Payment — TagadaPay (all required; checkout refuses to start without them):

    TAGADA_STORE_ID         the store (store_…)
    TAGADA_ACCOUNT_ID       the account (acc_…) — required for the funnel hand-off
    TAGADA_FUNNEL_ID        the checkout funnel (fnlv2_…)
    TAGADA_FUNNEL_STEP_ID   the funnel step buyers land on
    TAGADA_API_KEY          secret API key (TagadaPay dashboard → Settings → API Keys)
    TAGADA_WEBHOOK_SECRET   signing secret of the registered webhook endpoint
                            (returned once when the endpoint is created — see below)
    TAGADA_TEST_MODE        optional; "true" makes every checkout session a draft
                            (test) payment. Leave unset in production.

The webhook endpoint is https://pureauraa.com/.netlify/functions/tagada-webhook
and must be subscribed to order/paid, order/failed and order/refunded. It can be
(re-)registered with:

    node scripts/tagada-webhook-setup.mjs

which lists existing endpoints, creates the endpoint if missing, and stores its
signing secret in the Netlify environment without printing it. Delivery history
lives in the TagadaPay CRM under Integrations → Webhooks → Deliveries.

Pricing note: TagadaPay charges its own per-variant prices, which are kept in
`netlify/functions/_tagada-map.json` and must match the site's single-vial
prices. The Buy 3 / Buy 5 bundle discount is applied per order as a one-off
promotion code (named after the order ref) worth exactly the difference, and
shipping is pinned to the site's computed amount, so the charged total always
equals the site's total. If a price changes on a product page, change it in
TagadaPay too and regenerate the map.

Admin:

    ADMIN_PASSWORD        gates /admin/. Unset means nobody can get in.

Order emails (optional, recommended; provider is Resend, free tier 3,000/month):

    RESEND_API_KEY  EMAIL_FROM  ADMIN_EMAIL

Without these, orders still save and show in /admin/, only the emails are skipped.

Wording:

    SUPPORT_EMAIL         the contact address shown to the buyer

## Day to day

1. A buyer pays by card on TagadaPay's checkout. The webhook marks the order
   paid automatically, emails the buyer a confirmation, and emails you the
   order with its shipping address.
2. When it ships, open /admin/, paste the tracking number and press Save &
   ship. The buyer gets the tracking email.
3. "Needs review" means TagadaPay reported a paid amount different from the
   site's total — check the TagadaPay CRM before shipping.
4. "Payment failed" orders need nothing from you; the buyer was sent back to
   checkout and can try again.
5. Refunds made in the TagadaPay CRM mark the order "refunded" here
   automatically and email you.

## Customer accounts (added November 2026)

The catalog, prices, cart and checkout now require a customer account; the gate
is enforced server-side by `netlify/edge-functions/catalog-gate.ts`, and accounts
live in Netlify Database (`users` table). Signup is instant — no approval step
and no email-confirmation block, which the payment processor's reviewer relies on.

- `AUTH_SESSION_SECRET` (recommended): any long random string. Signs the session
  cookie. Until you set it, a key derived from `ADMIN_PASSWORD` is used so
  accounts work out of the box — but note that changing `ADMIN_PASSWORD` then
  logs every customer out. Set the dedicated secret to decouple the two:
  `netlify env:set AUTH_SESSION_SECRET "$(openssl rand -hex 32)"` and redeploy.
- Password-reset emails use the existing `RESEND_API_KEY` / `EMAIL_FROM`.
