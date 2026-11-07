#!/usr/bin/env node
// Registers the TagadaPay webhook endpoint for this store and stores its
// signing secret in the Netlify environment as TAGADA_WEBHOOK_SECRET.
//
// Idempotent: if an endpoint for the site's URL already exists it is left
// alone (TagadaPay only reveals a secret at creation time, so an existing
// endpoint's secret cannot be re-read — delete it in the CRM under
// Integrations → Webhooks and re-run this script to rotate).
//
// The secret is NEVER printed. It goes straight into `netlify env:set`.
//
// Usage:  TAGADA_API_KEY=… TAGADA_STORE_ID=… node scripts/tagada-webhook-setup.mjs
// Flags:  --url <endpoint url>   (default: https://pureauraa.com/.netlify/functions/tagada-webhook)
//         --no-env               (register only; skip `netlify env:set`)
import { spawnSync } from 'node:child_process';
import Tagada from '@tagadapay/node-sdk';

const EVENT_TYPES = ['order/paid', 'order/failed', 'order/refunded'];

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || true;
};

const apiKey = (process.env.TAGADA_API_KEY || '').trim();
const storeId = (process.env.TAGADA_STORE_ID || '').trim();
if (!apiKey || !storeId) {
  console.error('TAGADA_API_KEY and TAGADA_STORE_ID must be set in the environment.');
  process.exit(1);
}

const url = typeof arg('--url') === 'string' ? arg('--url') : 'https://pureauraa.com/.netlify/functions/tagada-webhook';
const tagada = new Tagada(apiKey);

const existing = (await tagada.webhooks.list(storeId).catch((err) => {
  console.error('Could not list webhook endpoints:', err?.message);
  process.exit(1);
})) || [];

const match = existing.find((w) => w.url === url);
if (match) {
  console.log(`Endpoint already registered: ${match.id} → ${url}`);
  console.log(`  events: ${(match.eventTypes || []).join(', ')} · enabled: ${match.enabled}`);
  const missing = EVENT_TYPES.filter((t) => !(match.eventTypes || []).includes(t));
  if (missing.length) console.warn(`  ⚠ missing event subscriptions: ${missing.join(', ')} — fix in the CRM or delete and re-run.`);
  console.log('Its signing secret was shown only at creation. To rotate: delete the endpoint in the CRM, then re-run this script.');
  process.exit(0);
}

const webhook = await tagada.webhooks.create({
  storeId,
  url,
  eventTypes: EVENT_TYPES,
  description: 'pureauraa.com order sync (paid / failed / refunded)',
});
console.log(`Created webhook endpoint ${webhook.id} → ${url}`);
console.log(`  events: ${(webhook.eventTypes || EVENT_TYPES).join(', ')}`);

if (!webhook.secret) {
  console.error('⚠ TagadaPay did not return a signing secret; set TAGADA_WEBHOOK_SECRET manually from the CRM.');
  process.exit(1);
}

if (arg('--no-env')) {
  console.log('Skipping `netlify env:set` (--no-env). Store the secret yourself; it will not be shown.');
  process.exit(0);
}

const res = spawnSync('netlify', ['env:set', 'TAGADA_WEBHOOK_SECRET', webhook.secret, '--secret'], {
  stdio: ['ignore', 'ignore', 'pipe'], // stdout suppressed: the CLI may echo the value
  encoding: 'utf8',
});
if (res.status !== 0) {
  console.error('`netlify env:set TAGADA_WEBHOOK_SECRET …` failed:', (res.stderr || '').slice(0, 400));
  console.error('The endpoint EXISTS but the secret is not stored. Delete the endpoint in the CRM and re-run, or set the variable by hand.');
  process.exit(1);
}
console.log('TAGADA_WEBHOOK_SECRET stored in the Netlify environment (value not shown). Redeploy to apply.');
