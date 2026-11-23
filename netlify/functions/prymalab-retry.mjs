// Scheduled hourly: asks PrymaLab again about every paid order it has not yet accepted for
// shipping (state retrying or held_balance), for up to 3 days from the first try, and sends any
// paid order the paid webhook missed (no PrymaLab record at all, paid after sending began). Same
// external_id every time, so a repeat never creates or bills a second order. After 3 days the
// order is marked "stopped" and waits for a person (the Send to PrymaLab button in /admin/).
//
// Scheduled functions run only on the published production deploy and cannot be called by
// URL there. Sending off (PRYMALAB_SEND not "on") or no key: the run reads nothing and sends nothing.
import { orderStore } from './_lib.mjs';
import { sendConfig, sendToPrymalab, readFresh, readSince, RETRY_STATES, RETRY_WINDOW_MS } from './_prymalab.mjs';

const MAX_PER_RUN = 25;
// A paid order with NO PrymaLab record is one the paid webhook missed (it timed out, or read
// the order before "paid" landed). Picked up here once it is this old, so the hourly run never
// races a webhook that is still working, and only if it was paid after sending began.
const MISSED_AFTER_MS = 10 * 60 * 1000;

export async function runRetry({ fetcher, now = Date.now() } = {}) {
  const cfg = sendConfig();
  if (!cfg.ok) {
    console.log('[prymalab-retry] sending is off; nothing read or sent');
    return { ok: true, off: true, tried: 0, stopped: 0 };
  }
  const store = orderStore();
  const { blobs } = await store.list();
  const since = await readSince();
  let tried = 0;
  let stopped = 0;
  let missed = 0;
  for (const { key } of blobs) {
    if (tried >= MAX_PER_RUN) break;
    const o = await readFresh(store, key);
    const pr = o?.prymalab;
    if (!o || o.status !== 'paid' || o.tracking) continue;
    if (!pr) {
      const paidAt = Date.parse(o.paidAt || '');
      if (!since || !Number.isFinite(paidAt) || paidAt < Date.parse(since)) continue;
      if (now - paidAt < MISSED_AFTER_MS || now - paidAt > RETRY_WINDOW_MS) continue;
      tried += 1;
      missed += 1;
      await sendToPrymalab(store, key, { via: 'retry-missed', fetcher });
      continue;
    }
    if (!RETRY_STATES.has(pr.state)) continue;
    if (!(now - Date.parse(pr.firstAt) <= RETRY_WINDOW_MS)) {
      o.prymalab = {
        ...pr,
        state: 'stopped',
        detail: `Stopped asking PrymaLab after 3 days. Last answer: ${pr.detail || 'none'} Press Send to PrymaLab to try again.`,
        lastAt: new Date(now).toISOString(),
      };
      await store.setJSON(key, o).catch(() => {});
      stopped += 1;
      continue;
    }
    tried += 1;
    await sendToPrymalab(store, key, { via: 'retry', requireRecord: true, fetcher });
  }
  console.log(`[prymalab-retry] tried ${tried} (missed by webhook ${missed}), stopped ${stopped}`);
  return { ok: true, tried, stopped, missed };
}

export default async () => {
  try {
    await runRetry();
  } catch (err) {
    console.error('[prymalab-retry] run failed:', err?.name || 'error');
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: '@hourly' };
