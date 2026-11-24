// POST /api/admin/prymalab-status: a read-only health check of the PrymaLab link. Bearer auth
// (ADMIN_PASSWORD), same guard and failed-login cap as the other admin endpoints.
// Asks PrymaLab GET /me and GET /balance with the store's own key and returns ONLY yes/no flags,
// the partner ID, the webhook address PrymaLab has on file, the balance, and order counts by
// state. Never the key, the signing secret, an email or an address. Changes nothing.
import { json, fail, adminOk, orderStore, rateLimit, clientIp } from './_lib.mjs';
import { PARTNER_ID, readMe, readBalance, readFresh, scrub } from './_prymalab.mjs';

const WEBHOOK_URL = 'https://pureauraa.com/api/webhooks/prymalab';
const norm = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();

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

  const key = (process.env.PRYMALAB_API_KEY || '').trim();
  const out = {
    ok: true,
    send_on: (process.env.PRYMALAB_SEND || '').trim() === 'on',
    key_set: !!key,
    webhook_secret_set: !!(process.env.PRYMALAB_WEBHOOK_SECRET || '').trim(),
    expected_partner_id: PARTNER_ID,
    partner_id: null,
    partner_id_matches: null,
    webhook_url: null,
    webhook_url_expected: WEBHOOK_URL,
    webhook_url_matches: null,
    balance_cents: null,
    currency: null,
    reachable: null,
    orders_by_state: {},
  };

  if (key) {
    const [me, bal] = await Promise.all([readMe(key), readBalance(key)]);
    out.reachable = me.ok;
    if (me.ok) {
      out.partner_id = me.partner_id ? scrub(me.partner_id) : null;
      out.partner_id_matches = me.partner_id ? me.partner_id === PARTNER_ID : null;
      out.webhook_url = me.webhook_url ? String(me.webhook_url).split(/[?#]/)[0].slice(0, 200) : null;
      out.webhook_url_matches = me.webhook_url ? norm(String(me.webhook_url).split(/[?#]/)[0]) === norm(WEBHOOK_URL) : null;
    }
    if (bal.ok) {
      out.balance_cents = bal.cents;
      out.currency = bal.currency;
    }
  }

  try {
    const store = orderStore();
    const { blobs } = await store.list();
    for (const { key: k } of blobs) {
      const o = await readFresh(store, k);
      const s = o?.prymalab?.state;
      if (typeof s === 'string') out.orders_by_state[s] = (out.orders_by_state[s] || 0) + 1;
    }
  } catch {
    out.orders_by_state = null;
  }
  return json(out);
};
