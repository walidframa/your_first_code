/**
 * Keeps the two shops in step without anyone pressing anything.
 *
 * Two loops on different clocks, because they answer different questions:
 *
 *  - **Push** runs often. A sale at the counter should be off the website
 *    before the next customer can buy the same last item.
 *  - **Pull** runs less often. It is a poll, and polling a shop every few
 *    seconds burns the API allowance for nothing; the webhook handles the
 *    urgent case, and this is the net that catches what the webhook missed.
 *
 * Both are no-ops until Shopify is connected and switched on, so the worker can
 * start unconditionally.
 */
import { isConfigured, logSync, pullFromShopify, pushToShopify, shopifyConfig } from './shopifySync.js';

const PUSH_INTERVAL_MS = Number(process.env.SHOPIFY_PUSH_INTERVAL_MS || 15_000);
const PULL_INTERVAL_MS = Number(process.env.SHOPIFY_PULL_INTERVAL_MS || 120_000);

let timers = [];
let pushing = false;
let pulling = false;

function active() {
  const config = shopifyConfig();
  return config.enabled && isConfigured(config) ? config : null;
}

/**
 * Run `fn` unless it is already running.
 *
 * A slow Shopify must not stack up overlapping runs — two pushes racing would
 * set the same item twice, and two pulls would each apply the same difference,
 * doubling it.
 */
async function guarded(name, running, fn) {
  if (running()) return;
  const config = active();
  if (!config) return;
  try {
    await fn(config);
  } catch (err) {
    logSync(null, 'error', `${name} failed: ${err.message}`);
  }
}

export function startShopifyWorker() {
  stopShopifyWorker();

  const push = setInterval(async () => {
    await guarded('Push', () => pushing, async (config) => {
      pushing = true;
      try {
        await pushToShopify({ config });
      } finally {
        pushing = false;
      }
    });
  }, PUSH_INTERVAL_MS);

  const pull = setInterval(async () => {
    await guarded('Pull', () => pulling, async (config) => {
      pulling = true;
      try {
        await pullFromShopify({ config });
      } finally {
        pulling = false;
      }
    });
  }, PULL_INTERVAL_MS);

  // Never hold the process open on the sync alone.
  push.unref?.();
  pull.unref?.();
  timers = [push, pull];
  return timers;
}

export function stopShopifyWorker() {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
