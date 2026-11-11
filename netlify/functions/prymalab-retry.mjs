// Scheduled hourly: asks PrymaLab again about every paid order it has not yet accepted for
// shipping (state retrying or held_balance), for up to 3 days from the first try. Same
// external_id every time, so a repeat never creates or bills a second order. After 3 days the
// order is marked "stopped" and waits for a person (the Send to PrymaLab button in /admin/).
//
// Scheduled functions run only on the published production deploy and cannot be called by
// URL there. Sending off (PRYMALAB_SEND not "on") or no key: the run reads nothing and sends nothing.
import { orderStore } from './_lib.mjs';
import { sendConfig, sendToPrymalab, RETRY_STATES, RETRY_WINDOW_MS } from './_prymalab.mjs';

const MAX_PER_RUN = 25;

export async function runRetry({ fetcher, now = Date.now() } = {}) {
  const cfg = sendConfig();
  if (!cfg.ok) {
    console.log('[prymalab-retry] sending is off; nothing read or sent');
    return { ok: true, off: true, tried: 0, stopped: 0 };
  }
  const store = orderStore();
  const { blobs } = await store.list();
  let tried = 0;
  let stopped = 0;
  for (const { key } of blobs) {
    if (tried >= MAX_PER_RUN) break;
    const o = await store.get(key, { type: 'json' }).catch(() => null);
    const pr = o?.prymalab;
    if (!pr || !RETRY_STATES.has(pr.state)) continue;
    if (o.status !== 'paid' || o.tracking) continue;
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
  console.log(`[prymalab-retry] tried ${tried}, stopped ${stopped}`);
  return { ok: true, tried, stopped };
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
