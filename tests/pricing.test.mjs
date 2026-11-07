// Pricing engine, checked against the generated catalogue and the TagadaPay
// variant map. Run with: npm test
import { priceOrder, newRef, catalog, SHIP_FLAT, FREE_SHIP_OVER }
  from '../netlify/functions/_lib.mjs';
import { toTagadaItems } from '../netlify/functions/_tagada.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail='') => { cond ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, detail)); };
const throws = (name, fn, match) => {
  try { fn(); fail++; console.log('  ✗', name, '(did not throw)'); }
  catch (e) { e.message.includes(match) ? (pass++, console.log('  ✓', name)) : (fail++, console.log('  ✗', name, '->', e.message)); }
};

console.log('\nPRICING — server total must equal what the PDP rendered');
// bpc-157: 10mg = $79.99. Bundle of 3 is -10% => unit 71.99, x3 vials = 215.97
const r1 = priceOrder([{ slug:'bpc-157', variant:10, bundleQty:3, qty:1 }]);
ok('bpc-157 10mg bundle-of-3 unit = 71.99', r1.items[0].unitPrice === 71.99, r1.items[0].unitPrice);
ok('  line total = 215.97', r1.items[0].lineTotal === 215.97, r1.items[0].lineTotal);
ok('  free shipping over $150 applied', r1.shipping === 0, r1.shipping);
ok('  total = 215.97', r1.total === 215.97, r1.total);

// single cheap item -> flat shipping
const r2 = priceOrder([{ slug:'bac-water-10ml', variant:'10 mL', bundleQty:1, qty:1 }]);
ok('bac-water single = $10.00', r2.subtotal === 10, r2.subtotal);
ok('  flat shipping 9.95 under threshold', r2.shipping === SHIP_FLAT, r2.shipping);
ok('  total = 19.95', r2.total === 19.95, r2.total);

// threshold boundary: exactly at FREE_SHIP_OVER must be free
const r3 = priceOrder([{ slug:'glow', variant:70, bundleQty:1, qty:2 }]);  // 119 x2 = 238
ok(`subtotal >= ${FREE_SHIP_OVER} ships free`, r3.shipping === 0, r3.shipping);

// multi-line
const r4 = priceOrder([
  { slug:'bpc-157', variant:5,  bundleQty:1, qty:1 },   // 49.99
  { slug:'ahk-cu',  variant:50, bundleQty:1, qty:1 },   // 69.99
]);
ok('two lines subtotal = 119.98', r4.subtotal === 119.98, r4.subtotal);
ok('  under threshold -> 129.93 total', r4.total === 129.93, r4.total);

// 5-bundle at -15%
const r5 = priceOrder([{ slug:'tesamorelin', variant:5, bundleQty:5, qty:1 }]); // 49.99*0.85=42.49 x5
ok('tesamorelin 5-bundle unit = 42.49', r5.items[0].unitPrice === 42.49, r5.items[0].unitPrice);
ok('  line total = 212.45', r5.items[0].lineTotal === 212.45, r5.items[0].lineTotal);

console.log('\nMETA — what the admin panel shows per line');
ok('bundle >1 shows size and bundle', r1.items[0].meta === '10 mg · Bundle of 3', r1.items[0].meta);
ok('single vial shows size only', r4.items[0].meta === '5 mg', r4.items[0].meta);

console.log('\nREJECTIONS — a tampered cart must not price');
throws('sold-out product',  () => priceOrder([{ slug:'ghk-cu', variant:50, bundleQty:1, qty:1 }]), 'sold out');
throws('unknown slug',      () => priceOrder([{ slug:'not-a-product', variant:5, bundleQty:1, qty:1 }]), 'no longer carry');
throws('unknown variant',   () => priceOrder([{ slug:'bpc-157', variant:999, bundleQty:1, qty:1 }]), 'size');
throws('unknown bundle',    () => priceOrder([{ slug:'bpc-157', variant:5, bundleQty:7, qty:1 }]), 'bundle');
throws('qty zero',          () => priceOrder([{ slug:'bpc-157', variant:5, bundleQty:1, qty:0 }]), 'quantity');
throws('qty negative',      () => priceOrder([{ slug:'bpc-157', variant:5, bundleQty:1, qty:-3 }]), 'quantity');
throws('qty fractional',    () => priceOrder([{ slug:'bpc-157', variant:5, bundleQty:1, qty:1.5 }]), 'quantity');
throws('qty absurd',        () => priceOrder([{ slug:'bpc-157', variant:5, bundleQty:1, qty:9999 }]), 'quantity');
throws('empty cart',        () => priceOrder([]), 'empty');
throws('not an array',      () => priceOrder('everything free'), 'empty');
throws('too many lines',    () => priceOrder(Array(41).fill({ slug:'bpc-157', variant:5, bundleQty:1, qty:1 })), 'Too many');

console.log('\nCLIENT-SUPPLIED PRICE IS IGNORED');
const evil = priceOrder([{ slug:'bpc-157', variant:5, bundleQty:1, qty:1, price:0.01, lineTotal:0.01, unitPrice:0.01 }]);
ok('price fields in the payload are not read', evil.total === 59.94, evil.total);

/* ===========================================================================
   TAGADA MAP — TagadaPay charges ITS variant prices plus a computed discount,
   so the charged total only equals the site's total if (a) every purchasable
   variant is in the map, (b) its mapped price equals the site's single-vial
   price to the cent, and (c) the discount math reproduces the bundle saving.
   =========================================================================== */
console.log('\nTAGADA MAP — every purchasable variant maps at the same price');
let unmapped = 0, mispriced = 0, variants = 0;
for (const p of Object.values(catalog)) {
  if (p.soldOut) continue;
  for (const v of p.variants) {
    variants++;
    let mapped;
    try {
      mapped = toTagadaItems(priceOrder([{ slug: p.slug, variant: v.mgKey, bundleQty: 1, qty: 1 }]).items);
    } catch {
      unmapped++; console.log(`    ! ${p.slug}/${v.mgKey} is not in _tagada-map.json`);
      continue;
    }
    if (mapped.fullPriceCents !== Math.round(v.price * 100)) {
      mispriced++; console.log(`    ! ${p.slug}/${v.mgKey}: site ${Math.round(v.price * 100)}¢ vs map ${mapped.fullPriceCents}¢`);
    }
  }
}
ok(`all ${variants} purchasable variants are mapped`, unmapped === 0, `${unmapped} unmapped`);
ok('every mapped price matches the site price to the cent', mispriced === 0, `${mispriced} mismatches`);

console.log('\nTAGADA MAP — bundle discount arithmetic');
// Bundle of 3 BPC-157 10mg: TagadaPay full price 3 × 7999¢ = 23997¢;
// site subtotal 21597¢; the one-off promotion must be worth exactly 2400¢.
const t1 = toTagadaItems(r1.items);
ok('bundle expands to one line of 3 units', t1.items.length === 1 && t1.items[0].quantity === 3, JSON.stringify(t1.items));
ok('full price = 23997¢', t1.fullPriceCents === 23997, t1.fullPriceCents);
ok('discount = full − site subtotal = 2400¢', t1.fullPriceCents - Math.round(r1.subtotal * 100) === 2400,
   t1.fullPriceCents - Math.round(r1.subtotal * 100));

// Same variant across two lines (single + bundle of 3) merges into 4 units.
const merged = toTagadaItems(priceOrder([
  { slug:'bpc-157', variant:10, bundleQty:1, qty:1 },
  { slug:'bpc-157', variant:10, bundleQty:3, qty:1 },
]).items);
ok('same variant merges across lines', merged.items.length === 1 && merged.items[0].quantity === 4, JSON.stringify(merged.items));

// A no-bundle cart needs no discount at all.
const t2 = toTagadaItems(r4.items);
ok('no bundles -> zero discount', t2.fullPriceCents === Math.round(r4.subtotal * 100), t2.fullPriceCents);

console.log('\nORDER REF');
const refs = new Set(Array.from({length:500}, newRef));
ok('shape AUR-XXXXXX', /^AUR-[A-Z0-9]{6}$/.test(newRef()));
ok('500 refs, no collision', refs.size === 500, refs.size);

console.log(`\ncatalog: ${Object.keys(catalog).length} products`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
