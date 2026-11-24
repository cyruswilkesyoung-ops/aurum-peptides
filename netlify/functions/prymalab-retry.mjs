// Scheduled hourly: asks PrymaLab again about every paid order it has not yet accepted for
// shipping (state retrying or held_balance), for up to 3 days from the first try, and sends any
// paid order the paid webhook missed (no PrymaLab record at all, paid after sending began). Same
// external_id every time, so a repeat never creates or bills a second order. After 3 days the
// order is marked "stopped" and waits for a person (the Send to PrymaLab button in /admin/).
//
// Scheduled functions run only on the published production deploy and cannot be called by
// URL there. Sending off (PRYMALAB_SEND not "on") or no key: the run reads nothing and sends nothing.
import { orderStore } from './_lib.mjs';
import { sendConfig, sendToPrymalab, readFresh, readSince, readSupplierOrder, applyPrymalabUpdate, trackingOf, RETRY_STATES, RETRY_WINDOW_MS } from './_prymalab.mjs';

const MAX_PER_RUN = 25;
// Backup for the tracking webhook: at most this many PrymaLab order reads per run, and only for
// orders first sent in the last 30 days.
const MAX_TRACK_READS = 25;
const TRACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
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
  const trackable = [];
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
    if (pr.state === 'submitted' && pr.supplier_order_id && now - Date.parse(pr.firstAt) <= TRACK_WINDOW_MS) {
      trackable.push(key);
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
  // Tracking read-back: the webhook is the main road; this catches a delivery that never came.
  let read = 0;
  let shipped = 0;
  let cancelled = 0;
  for (const key of trackable) {
    if (read >= MAX_TRACK_READS) break;
    read += 1;
    try {
      const po = await readSupplierOrder(cfg.key, (await readFresh(store, key))?.prymalab?.supplier_order_id, { fetcher });
      if (!po) continue;
      const t = trackingOf(po);
      const isCancelled = t.status === 'cancelled';
      if (!t.tracking_number && !isCancelled) continue;
      const o = await readFresh(store, key); // newest copy, in case the webhook landed meanwhile
      if (!o || o.status !== 'paid' || o.tracking || o.prymalab?.state !== 'submitted') continue;
      if (po.id != null && String(po.id) !== String(o.prymalab.supplier_order_id)) continue;
      const res = await applyPrymalabUpdate(store, key, o, po, isCancelled ? 'order.cancelled' : 'order.readback');
      if (res.shipped) shipped += 1;
      if (res.cancelled) cancelled += 1;
    } catch {
      // one bad order never stops the run
    }
  }
  console.log(`[prymalab-retry] tried ${tried} (missed by webhook ${missed}), stopped ${stopped}, tracking read ${read} (shipped ${shipped}, cancelled ${cancelled})`);
  return { ok: true, tried, stopped, missed, trackingRead: read, shipped, cancelled };
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
