#!/usr/bin/env node
// Generates netlify/functions/_catalog.json from the product pages themselves.
//
// The server MUST re-price every order — js/app.js:84 deliberately sends only slugs and
// quantities, never prices, so a tampered cart cannot set its own total. That means the
// server needs a copy of the catalogue, and the moment there are two copies of a price
// they can disagree: someone edits a PDP, the server keeps charging the old number, and
// nothing errors. Nobody notices until a customer does.
//
// So this is generated, never hand-written. It runs at build time (see netlify.toml), and
// the prices it emits are literally the ones the page rendered.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const shopDir = join(root, 'shop');

const unescapeHtml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const catalog = {};
let scanned = 0;
for (const entry of readdirSync(shopDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(shopDir, entry.name, 'index.html');
  if (!existsSync(file)) continue;
  scanned++;
  const html = readFileSync(file, 'utf8');
  const m = html.match(/data-pdp="([^"]+)"/);
  if (!m) {
    console.error(`  ! ${entry.name}: no data-pdp block — it will not be purchasable`);
    continue;
  }
  const d = JSON.parse(unescapeHtml(m[1]));
  if (!d.slug || !Array.isArray(d.variants) || !Array.isArray(d.bundles)) {
    throw new Error(`${entry.name}: data-pdp is missing slug/variants/bundles`);
  }
  for (const v of d.variants) {
    if (typeof v.price !== 'number' || !(v.price > 0)) {
      throw new Error(`${d.slug}: variant ${v.mgKey} has a non-numeric price`);
    }
  }
  for (const b of d.bundles) {
    if (typeof b.save !== 'number' || b.save < 0 || b.save >= 1) {
      throw new Error(`${d.slug}: bundle ${b.qty} has save outside 0..1 (it is a FRACTION)`);
    }
  }
  catalog[d.slug] = {
    slug: d.slug, name: d.name, soldOut: !!d.soldOut,
    variants: d.variants.map((v) => ({ mgKey: v.mgKey, label: v.label, price: v.price })),
    bundles: d.bundles.map((b) => ({ qty: b.qty, label: b.label, save: b.save })),
  };
}

const count = Object.keys(catalog).length;
if (!count) throw new Error('catalog is empty — refusing to write. Did shop/ move?');
writeFileSync(join(root, 'netlify/functions/_catalog.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), products: catalog }, null, 2));
console.log(`catalog: ${count} products from ${scanned} shop pages`);
