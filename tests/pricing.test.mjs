// Pricing engine, checked against the generated catalogue.
// Run with: npm test
import { priceOrder, paymentMethods, newRef, catalog, SHIP_FLAT, FREE_SHIP_OVER }
  from '../netlify/functions/_lib.mjs';

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

console.log('\nPAYMENT METHODS');
ok('none configured -> empty (caller refuses order)', paymentMethods().length === 0);
process.env.CRYPTO_BTC = 'bc1qexample';
process.env.CASHAPP_HANDLE = 'aurum';
const m = paymentMethods();
ok('crypto appears when an address is set', m.some(x => x.id==='crypto' && x.coins[0].code==='BTC'));
ok('cashapp handle gets its $ prefix', m.find(x=>x.id==='cashapp')?.handle === '$aurum');
ok('unset coins are omitted', m.find(x=>x.id==='crypto').coins.length === 1);

/* The names in /guide/ are the ones the owner will actually type into Netlify.
   If the code and the documentation disagree the payment screen comes up empty
   and nothing says why, so both spellings are pinned here. */
for (const k of Object.keys(process.env)) {
  if (/^(CRYPTO_|CASHAPP_|ZELLE_)/.test(k)) delete process.env[k];
}
process.env.CRYPTO_BTC_ADDRESS  = 'bc1qdocumented';
process.env.CRYPTO_USDT_ADDRESS = 'TdocumentedUSDT';
process.env.CRYPTO_USDT_NETWORK = 'ERC-20';
process.env.CASHAPP_CASHTAG     = '$aurum';
process.env.ZELLE_CONTACT       = 'pay@aurumpeptides.com';
process.env.ZELLE_NAME          = 'Aurum Labs LLC';
const d = paymentMethods();
const dc = d.find(x => x.id === 'crypto').coins;
ok('documented CRYPTO_*_ADDRESS names are read', dc.find(c=>c.code==='BTC')?.address === 'bc1qdocumented');
ok('CRYPTO_USDT_NETWORK overrides the TRC-20 default',
   dc.find(c=>c.code==='USDT')?.network === 'ERC-20');
ok('documented CASHAPP_CASHTAG is read, $ not doubled',
   d.find(x=>x.id==='cashapp')?.handle === '$aurum');
ok('zelle is offered when ZELLE_CONTACT is set',
   d.find(x=>x.id==='zelle')?.handle === 'pay@aurumpeptides.com');
ok('zelle carries the display name the UI renders',
   d.find(x=>x.id==='zelle')?.name === 'Aurum Labs LLC');

/* Every id here has a branch in js/app.js renderMethod(); an id it does not know
   would silently render as a Zelle panel. */
ok('every method id is one the order screen can render',
   d.every(x => ['crypto','cashapp','zelle'].includes(x.id)));

delete process.env.CRYPTO_USDT_NETWORK;
ok('USDT falls back to TRC-20 when no network is given',
   paymentMethods().find(x=>x.id==='crypto').coins.find(c=>c.code==='USDT').network === 'TRC-20');

process.env.CRYPTO_ETH = '0xaliased';
ok('the short alias still works alongside the documented name',
   paymentMethods().find(x=>x.id==='crypto').coins.find(c=>c.code==='ETH')?.address === '0xaliased');

process.env.CRYPTO_ETH_ADDRESS = '0xdocumented';
ok('the documented name wins over the alias',
   paymentMethods().find(x=>x.id==='crypto').coins.find(c=>c.code==='ETH')?.address === '0xdocumented');

ok('whitespace-only values count as unset',
   (process.env.ZELLE_CONTACT = '   ', paymentMethods().some(x=>x.id==='zelle') === false));

console.log('\nORDER REF');
const refs = new Set(Array.from({length:500}, newRef));
ok('shape AUR-XXXXXX', /^AUR-[A-Z0-9]{6}$/.test(newRef()));
ok('500 refs, no collision', refs.size === 500, refs.size);

console.log(`\ncatalog: ${Object.keys(catalog).length} products`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
