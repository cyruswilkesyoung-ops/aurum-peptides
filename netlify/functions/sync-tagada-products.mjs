// POST /.netlify/functions/sync-tagada-products — push the catalog to TagadaPay.
//
// Admin-only (same Bearer ADMIN_PASSWORD scheme as /api/admin/*). Reads
// TAGADA_API_KEY / TAGADA_STORE_ID from the environment; neither is ever
// echoed in a response or a log line.
//
//   ?dryRun=true   → no writes to TagadaPay. Returns exactly what a real run
//                    would create/update. Auth + listing are still attempted
//                    so the plan can mark updates vs creates, but a missing
//                    key downgrades the dry run to "all creates" with a warning
//                    instead of failing.
//   (no dryRun)    → tests the key, lists existing products, updates matches
//                    by name, creates the rest. Safe to re-run: a second run
//                    finds everything by name and updates instead of duplicating.
//
// The TagadaPay update endpoint (PUT /products/{id}) only accepts product-level
// fields inside `updatedData` — variants and prices cannot be changed through
// it. So re-runs update name/description/active and REPORT variant/price
// drift in `variantWarnings` rather than inventing an undocumented call.
//
// The slug→{productId, variants:{mgKey→variantId}} mapping the checkout needs
// is returned in the response and also written to the 'tagada' blob store
// (key 'product-map'). IDs are safe to persist; the key never is.
import { json, fail, adminOk, rateLimit, clientIp, catalog } from './_lib.mjs';
import { getStore, getDeployStore } from '@netlify/blobs';

const BASE = 'https://api.tagada.io/api/public/v1';
const TIMEOUT_MS = 10_000;

/* Every product photo lives at this path under the site root, named by slug.
   The paths are currently behind the customer login gate (catalog-gate.ts
   returns 401 on /assets/* without a session), so TagadaPay may not be able
   to fetch them — flagged in the response so nobody is surprised. */
const siteOrigin = () => (process.env.URL || 'https://pureauraa.com').replace(/\/$/, '');
const imageUrl = (slug) => `${siteOrigin()}/assets/packshots/photo-20261023/${slug}.webp`;

/* Strictly research-use copy. Generated from a template so no page prose —
   and no dosing/benefit/human-use language — can leak into the processor. */
const REAGENTS = new Set(['acetic-acid', 'bac-water-10ml', 'bac-water-30ml']);
const description = (p) =>
  REAGENTS.has(p.slug)
    ? `${p.name} — laboratory reagent supplied strictly for research use only. Not for human or veterinary use.`
    : `${p.name} — lyophilized compound supplied strictly for in-vitro laboratory research use only. Not for human or veterinary use; not for diagnostic or therapeutic purposes.`;

const cents = (usd) => Math.round(Number(usd) * 100);
const skuOf = (slug, mgKey) =>
  `${slug}-${String(mgKey).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
const norm = (s) => String(s || '').trim().toLowerCase();

/* ---- TagadaPay client -------------------------------------------------------
   Never throws raw fetch errors upward without context; never logs the key. */
async function api(method, path, key, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = data?.message || text.slice(0, 300) || 'no body';
      return { ok: false, status: res.status, error: `TagadaPay ${method} ${path} → ${res.status}: ${msg}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const why = err?.name === 'AbortError' ? `no response in ${TIMEOUT_MS}ms` : err?.message;
    return { ok: false, status: 0, error: `TagadaPay ${method} ${path} failed: ${why}` };
  } finally {
    clearTimeout(timer);
  }
}

async function listAllProducts(key, storeId) {
  const items = [];
  let page = 1;
  for (let guard = 0; guard < 50; guard++) {
    const res = await api('POST', '/products/list', key, {
      storeId, page, per_page: 200, includeVariants: true,
    });
    if (!res.ok) return res;
    items.push(...(res.data?.items || []));
    const pg = res.data?.pagination;
    if (!pg?.hasNext || pg.nextPage == null) break;
    page = pg.nextPage;
  }
  return { ok: true, items };
}

/* What the catalog says TagadaPay should hold. One product per slug, one
   variant per strength, prices in integer USD cents. */
function desiredProducts() {
  return Object.values(catalog).map((p) => ({
    slug: p.slug,
    name: p.name,
    description: description(p),
    active: true,
    isShippable: true,
    isTaxable: true,
    variants: p.variants.map((v, i) => ({
      name: v.label,
      sku: skuOf(p.slug, v.mgKey),
      active: true,
      default: i === 0,
      inStock: !p.soldOut,
      imageUrl: imageUrl(p.slug),
      prices: [{ currencyOptions: { USD: { amount: cents(v.price) } }, recurring: false, default: true }],
      _mgKey: p.variants[i].mgKey, // internal, stripped before sending
    })),
  }));
}

const stripInternal = (product) => ({
  ...product,
  variants: product.variants.map(({ _mgKey, ...v }) => v),
});

/* Pull USD cents out of whatever price shape the list endpoint returns for a
   variant. Defensive: used only to WARN about drift, never to write. */
function existingVariantCents(v) {
  const opts =
    v?.prices?.[0]?.currencyOptions || v?.price?.currencyOptions || null;
  const amount = opts?.USD?.amount;
  return typeof amount === 'number' ? amount : null;
}

export default async (req) => {
  if (req.method !== 'POST') return fail('Method not allowed.', 405);
  if (!adminOk(req)) {
    const l = await rateLimit({ bucket: 'admin-auth', id: clientIp(req), max: 10, windowMs: 15 * 60 * 1000 });
    if (!l.ok) return fail('Too many attempts. Try again later.', 429);
    return fail('Not authorised.', 401);
  }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'true';
  const key = (process.env.TAGADA_API_KEY || '').trim();
  const storeId = (process.env.TAGADA_STORE_ID || '').trim();
  const warnings = [];

  if (!storeId) return fail('TAGADA_STORE_ID is not set.', 500);
  if (!key && !dryRun) {
    return fail('TAGADA_API_KEY is not set (or saved with an empty value) — fix it in Netlify environment variables, redeploy, and re-run.', 500);
  }

  /* 1 — prove the key works before touching anything. */
  let authOk = false;
  if (key) {
    const auth = await api('POST', '/auth/test', key, {});
    authOk = auth.ok && auth.data?.success !== false;
    if (!authOk && !dryRun) return fail(auth.error || 'TagadaPay rejected the API key.', 502);
    if (!authOk) warnings.push(`API key check failed (${auth.error || 'rejected'}); dry run cannot see existing products, everything below is shown as a create.`);
  } else {
    warnings.push('TAGADA_API_KEY is empty; dry run cannot see existing products, everything below is shown as a create.');
  }

  /* 2 — what's already there, so re-runs update instead of duplicating. */
  let existing = [];
  if (authOk) {
    const listed = await listAllProducts(key, storeId);
    if (!listed.ok) {
      if (!dryRun) return fail(listed.error, 502);
      warnings.push(`Could not list existing products (${listed.error}); plan shows everything as a create.`);
    } else {
      existing = listed.items;
    }
  }
  const byName = new Map(existing.map((p) => [norm(p.name), p]));

  /* 3 — plan. */
  const desired = desiredProducts();
  const plan = desired.map((p) => {
    const match = byName.get(norm(p.name));
    return { action: match ? 'update' : 'create', product: p, match };
  });

  /* The packshot paths are behind the customer login gate; TagadaPay may get a
     401 if it tries to fetch them. Surfaced every run until that changes. */
  warnings.push('Image URLs point at /assets/packshots/…, which the catalog gate serves only to logged-in customers — TagadaPay may be unable to fetch them unless that path is exempted from the gate.');

  if (dryRun) {
    return json({
      ok: true,
      dryRun: true,
      authOk,
      store: storeId ? 'configured' : 'missing',
      existingProductsFound: existing.length,
      totals: {
        create: plan.filter((x) => x.action === 'create').length,
        update: plan.filter((x) => x.action === 'update').length,
        variants: desired.reduce((n, p) => n + p.variants.length, 0),
      },
      warnings,
      plan: plan.map(({ action, product, match }) => ({
        action,
        ...(match ? { tagadaProductId: match.id } : {}),
        slug: product.slug,
        name: product.name,
        description: product.description,
        imageUrl: product.variants[0]?.imageUrl,
        variants: product.variants.map((v) => ({
          name: v.name, sku: v.sku, priceCentsUSD: v.prices[0].currencyOptions.USD.amount,
          inStock: v.inStock, default: v.default,
        })),
      })),
    });
  }

  /* 4 — real run. Sequential on purpose: 19 products against a 100 req/min
     rate limit, and a readable error that names the product that failed. */
  const mapping = { generatedAt: new Date().toISOString(), storeId, products: {} };
  const created = [];
  const updated = [];
  const variantWarnings = [];

  for (const { action, product, match } of plan) {
    if (action === 'create') {
      const body = { storeId, ...stripInternal(product) };
      delete body.slug; // ours, not a documented API field
      const res = await api('POST', '/products/create', key, body);
      if (!res.ok) return fail(`Create failed for "${product.name}": ${res.error}`, 502);
      created.push({ slug: product.slug, id: res.data?.id });
      recordMapping(mapping, product, res.data);
    } else {
      const res = await api('PUT', `/products/${encodeURIComponent(match.id)}`, key, {
        updatedData: {
          name: product.name,
          description: product.description,
          active: true,
          isShippable: true,
          isTaxable: true,
        },
      });
      if (!res.ok) return fail(`Update failed for "${product.name}": ${res.error}`, 502);
      updated.push({ slug: product.slug, id: match.id });
      recordMapping(mapping, product, res.data?.variants?.length ? res.data : match);

      /* Variants/prices are read-only through this endpoint — diff and warn. */
      const existingVariants = (match.variants || []).map((v) => ({ v, name: norm(v.name), sku: norm(v.sku) }));
      for (const want of product.variants) {
        const found = existingVariants.find((e) => e.sku === norm(want.sku) || e.name === norm(want.name));
        if (!found) {
          variantWarnings.push(`${product.name}: variant "${want.name}" does not exist in TagadaPay and the public update endpoint cannot add variants — add it in the TagadaPay dashboard.`);
          continue;
        }
        const have = existingVariantCents(found.v);
        const wantCents = want.prices[0].currencyOptions.USD.amount;
        if (have !== null && have !== wantCents) {
          variantWarnings.push(`${product.name} / ${want.name}: price is ${have}¢ in TagadaPay but ${wantCents}¢ on the site — the public update endpoint cannot change prices; fix in the TagadaPay dashboard.`);
        }
      }
    }
  }

  /* 5 — persist the mapping for checkout. Blobs for runtime, response body for
     committing to the repo. A blob failure must not void a completed sync. */
  let mappingStored = false;
  try {
    const isProd = globalThis.Netlify?.context?.deploy?.context === 'production';
    const store = isProd ? getStore('tagada') : getDeployStore('tagada');
    await store.setJSON('product-map', mapping);
    mappingStored = true;
  } catch (err) {
    warnings.push(`Sync succeeded but the mapping could not be written to the blob store (${err?.message}); commit the "mapping" object from this response to netlify/functions/_tagada-map.json instead.`);
  }

  return json({
    ok: true,
    dryRun: false,
    created,
    updated,
    variantWarnings,
    warnings,
    mappingStored,
    mapping,
  });
};

/* Fold one API product response into the slug→IDs mapping. Variants are matched
   back to strengths by SKU first, then by name (the label). */
function recordMapping(mapping, product, apiProduct) {
  const entry = { productId: apiProduct?.id || null, name: product.name, variants: {} };
  const apiVariants = (apiProduct?.variants || []).map((v) => ({ v, name: norm(v.name), sku: norm(v.sku) }));
  for (const want of product.variants) {
    const found = apiVariants.find((e) => e.sku === norm(want.sku) || e.name === norm(want.name));
    entry.variants[String(want._mgKey)] = {
      variantId: found?.v?.id || null,
      label: want.name,
      sku: want.sku,
      priceCentsUSD: want.prices[0].currencyOptions.USD.amount,
    };
  }
  mapping.products[product.slug] = entry;
}
