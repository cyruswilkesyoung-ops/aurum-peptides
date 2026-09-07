// Module resolve hook: swaps @netlify/blobs for an in-memory store so the handlers can
// be driven off-platform. The real package needs a site ID and token.
// The store NAME is passed through, because the code uses two: 'orders' and 'ratelimit'.
export async function resolve(spec, ctx, next) {
  if (spec === '@netlify/blobs') return { url: 'stub:blobs', shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url === 'stub:blobs') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const pick = (a) => globalThis.__FAKE_STORE__(typeof a === 'string' ? a : a && a.name);
        export const getStore = pick;
        export const getDeployStore = pick;
      `,
    };
  }
  return next(url, ctx);
}
