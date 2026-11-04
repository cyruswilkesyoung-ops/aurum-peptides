// Sync the site's catalog to TagadaPay (Commerce API V2).
//
// POST /.netlify/functions/sync-tagada-products        — real run
// POST /.netlify/functions/sync-tagada-products?dryRun=true — plan only, no writes
//
// Admin-only: requires `Authorization: Bearer <ADMIN_PASSWORD>` (same adminOk()
// gate as the admin order endpoints). Fails closed when ADMIN_PASSWORD is unset.
//
// Credentials come exclusively from TAGADA_API_KEY / TAGADA_STORE_ID in the
// environment. The key is sent only to api.tagada.io and never echoed in any
// response, log line, or error message.
//
// Idempotent: lists existing products first (matched by exact product name) and
// updates those instead of creating duplicates. The products/update endpoint
// cannot modify variants or prices (the documented schema has no such fields),
// so variants missing from an existing TagadaPay product are reported as
// warnings rather than guessed at with undocumented calls.
import { adminOk, catalog } from './_lib.mjs';

const BASE = 'https://api.tagada.io/api/public/v1';
const SITE = 'https://pureauraa.com';

/* Strictly research-use copy. No dosing, benefits, or human-use language. */
const describe = (name) =>
  `${name} — research-grade material supplied strictly for in-vitro laboratory ` +
  `research by qualified professionals. For research use only. Not for human or ` +
  `veterinary use. Not a drug, food, cosmetic, or dietary supplement. ` +
  `Batch certificate of analysis available.`;

const skuOf = (slug, mgKey) =>
  ('AUR-' + slug + '-' + String(mgKey))
    .normalize('NFKD')
    .replace(/[×x]/gi, 'X')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();

const cents = (dollars) => Math.round(Number(dollars) * 100);

async function tagada(path, { method = 'POST', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${process.env.TAGADA_API_KEY}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const e = new Error(`Could not reach api.tagada.io (${method} ${path}): ${err?.message || err}`);
    e.network = true;
    throw e;
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = json?.message ? `${json.message}${json.code ? ` [${json.code}]` : ''}` : `HTTP ${res.status}`;
    const issues = Array.isArray(json?.issues) ? ' — ' + json.issues.map((i) => i.message).join('; ') : '';
    const e = new Error(`TagadaPay ${method} ${path} failed (HTTP ${res.status}): ${detail}${issues}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

/* Desired state, straight from the generated catalog (the same data checkout
   prices from). One TagadaPay product per site product; one variant per strength. */
function desiredProducts(storeId) {
  return Object.values(catalog).map((p) => ({
    slug: p.slug,
    payload: {
      storeId,
      name: p.name,
      description: describe(p.name),
      active: !p.soldOut,
      isShippable: true,
      isTaxable: true,
      variants: p.variants.map((v, i) => ({
        name: v.label,
        description: `${p.name} ${v.label} — for research use only.`,
        sku: skuOf(p.slug, v.mgKey),
        active: !p.soldOut,
        default: i === 0,
        imageUrl: `${SITE}/assets/packshots/photo-20261023/${p.slug}.webp`,
        prices: [{
          currencyOptions: { USD: { amount: cents(v.price), currency: 'USD' } },
          recurring: false,
          default: true,
        }],
      })),
    },
    /* for the slug/strength → id mapping */
    variantKeys: p.variants.map((v) => ({ mgKey: v.mgKey, label: v.label })),
  }));
}

async function listExisting(storeId) {
  const byName = new Map();
  let page = 1;
  for (;;) {
    const res = await tagada('/products/list', {
      body: { storeId, page, per_page: 200, includeVariants: true },
    });
    for (const item of res.items || []) byName.set(item.name, item);
    if (!res.pagination?.hasNext || !res.pagination?.nextPage) break;
    page = res.pagination.nextPage;
  }
  return byName;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'POST only.' }, { status: 405 });
  }
  if (!adminOk(req)) {
    return Response.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }

  const missing = ['TAGADA_API_KEY', 'TAGADA_STORE_ID'].filter((k) => !(process.env[k] || '').trim());
  if (missing.length) {
    return Response.json(
      { ok: false, error: `Missing environment variable(s): ${missing.join(', ')}. Set them in Netlify and redeploy — env changes do not reach running functions until a redeploy.` },
      { status: 500 },
    );
  }

  const storeId = process.env.TAGADA_STORE_ID.trim();
  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'true';

  try {
    /* 1. Prove the key works before doing anything else. */
    const auth = await tagada('/auth/test', { body: {} });
    if (auth?.success !== true) {
      return Response.json({ ok: false, error: 'TagadaPay auth test did not return success:true.' }, { status: 502 });
    }

    /* 2. Current remote state, for idempotency. */
    const existing = await listExisting(storeId);

    /* 3. Diff desired vs existing. */
    const desired = desiredProducts(storeId);
    const warnings = [
      'Packshot URLs under /assets/packshots/* are login-gated on this site (they return 401 to anonymous requests). TagadaPay will store these imageUrls but cannot fetch or display the images unless that gating changes.',
    ];
    const toCreate = [];
    const toUpdate = [];
    for (const d of desired) {
      const ex = existing.get(d.payload.name);
      if (!ex) { toCreate.push(d); continue; }
      const exVariants = new Map((ex.variants || []).map((v) => [v.name, v]));
      const missingVariants = d.payload.variants.filter((v) => !exVariants.has(v.name)).map((v) => v.name);
      if (missingVariants.length) {
        warnings.push(
          `"${d.payload.name}" exists in TagadaPay (${ex.id}) but is missing variant(s): ${missingVariants.join(', ')}. ` +
          `The documented update endpoint cannot add variants — add them in the TagadaPay dashboard or delete the product and re-run.`,
        );
      }
      toUpdate.push({ ...d, existingId: ex.id, existingVariants: exVariants });
    }

    if (dryRun) {
      const redact = (p) => ({ ...p, storeId: '<TAGADA_STORE_ID from env>' });
      return Response.json({
        ok: true,
        dryRun: true,
        authTest: 'passed',
        existingProductsInStore: existing.size,
        wouldCreate: toCreate.map((d) => redact(d.payload)),
        wouldUpdate: toUpdate.map((d) => ({
          productId: d.existingId,
          updatedData: {
            name: d.payload.name,
            description: d.payload.description,
            active: d.payload.active,
            isShippable: true,
            isTaxable: true,
          },
        })),
        warnings,
      });
    }

    /* 4. Real run: create the missing, update the rest, build the mapping. */
    const mapping = {};
    const results = { created: [], updated: [] };

    for (const d of toCreate) {
      const created = await tagada('/products/create', { body: d.payload });
      const vmap = {};
      const createdVariants = new Map((created.variants || []).map((v) => [v.name, v]));
      d.variantKeys.forEach((vk) => {
        const cv = createdVariants.get(vk.label);
        if (cv) vmap[String(vk.mgKey)] = { variantId: cv.id, priceId: cv.prices?.[0]?.id ?? null, label: vk.label };
        else warnings.push(`Create response for "${d.payload.name}" did not include variant "${vk.label}".`);
      });
      mapping[d.slug] = { productId: created.id, name: d.payload.name, variants: vmap };
      results.created.push({ slug: d.slug, productId: created.id });
    }

    for (const d of toUpdate) {
      const updated = await tagada(`/products/${encodeURIComponent(d.existingId)}`, {
        method: 'PUT',
        body: {
          updatedData: {
            name: d.payload.name,
            description: d.payload.description,
            active: d.payload.active,
            isShippable: true,
            isTaxable: true,
          },
        },
      });
      const respVariants = new Map(((updated.variants || [...d.existingVariants.values()]) || []).map((v) => [v.name, v]));
      const vmap = {};
      d.variantKeys.forEach((vk) => {
        const rv = respVariants.get(vk.label) || d.existingVariants.get(vk.label);
        if (rv) vmap[String(vk.mgKey)] = { variantId: rv.id, priceId: rv.prices?.[0]?.id ?? null, label: vk.label };
      });
      mapping[d.slug] = { productId: d.existingId, name: d.payload.name, variants: vmap };
      results.updated.push({ slug: d.slug, productId: d.existingId });
    }

    /* The mapping is returned (ids only — safe to commit) so it can be saved to
       netlify/functions/_tagada-map.json for checkout to use. */
    return Response.json({ ok: true, dryRun: false, authTest: 'passed', results, warnings, mapping });
  } catch (err) {
    const status = err.network ? 502 : (err.status === 401 || err.status === 403 ? 502 : 500);
    return Response.json({ ok: false, error: String(err.message || err) }, { status });
  }
};
