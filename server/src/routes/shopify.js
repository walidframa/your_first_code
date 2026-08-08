import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { setSetting } from '../lib/settings.js';
import { createClient, normaliseShopDomain } from '../lib/shopify.js';
import {
  clientFor,
  isConfigured,
  linkProduct,
  logSync,
  matchProducts,
  pullFromShopify,
  recentLog,
  reconcile,
  reconcileAll,
  shopifyConfig,
  syncNow,
  syncStatus,
  unlinkProduct,
} from '../lib/shopifySync.js';

const router = Router();
const connected = [requireAuth, requirePermission('imports')];

/* ------------------------------------------------------------ connection */

router.get('/status', ...connected, (req, res) => {
  res.json(syncStatus());
});

router.get('/log', ...connected, (req, res) => {
  res.json({ log: recentLog(req.query.limit) });
});

/**
 * Save credentials and prove they work before storing them.
 *
 * Checking first means a typo is reported as a typo, rather than saved and then
 * failing silently on every sync afterwards.
 */
router.post('/connect', ...connected, async (req, res) => {
  const { shopDomain, accessToken, baseUrl } = req.body || {};

  if (!baseUrl && !normaliseShopDomain(shopDomain)) {
    return res.status(400).json({ error: 'Enter the shop address, like my-shop.myshopify.com' });
  }
  // Re-using the saved token lets the location be changed without retyping it.
  const token = accessToken || shopifyConfig().accessToken;
  if (!token) return res.status(400).json({ error: 'An Admin API access token is needed' });

  try {
    const client = createClient({ shopDomain, accessToken: token, baseUrl: baseUrl || null });
    const shop = await client.shopInfo();
    const locations = await client.locations();

    setSetting('shopify_domain', normaliseShopDomain(shopDomain) || '', req.user.id);
    setSetting('shopify_token', token, req.user.id);
    if (baseUrl !== undefined) setSetting('shopify_base_url', baseUrl || '', req.user.id);

    res.json({ shop, locations });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Which location's stock this shop's counter represents. */
router.post('/location', ...connected, async (req, res) => {
  const { locationId, locationName } = req.body || {};
  if (!locationId) return res.status(400).json({ error: 'Choose a location' });

  setSetting('shopify_location_id', locationId, req.user.id);
  setSetting('shopify_location_name', locationName || '', req.user.id);
  res.json(syncStatus());
});

router.post('/enabled', ...connected, (req, res) => {
  const enabled = !!req.body?.enabled;
  if (enabled && !isConfigured()) {
    return res.status(400).json({ error: 'Connect a shop and choose a location first' });
  }
  setSetting('shopify_enabled', enabled ? 'true' : 'false', req.user.id);
  res.json(syncStatus());
});

router.post('/disconnect', ...connected, (req, res) => {
  for (const key of [
    'shopify_enabled',
    'shopify_domain',
    'shopify_token',
    'shopify_location_id',
    'shopify_location_name',
    'shopify_base_url',
  ]) {
    setSetting(key, key === 'shopify_enabled' ? 'false' : '', req.user.id);
  }
  // Links are kept: reconnecting the same shop should not mean matching again.
  res.json(syncStatus());
});

/* ---------------------------------------------------------------- linking */

/** Preview the matches without committing them. */
router.get('/match', ...connected, async (req, res) => {
  try {
    res.json(await matchProducts({ apply: false }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/match', ...connected, async (req, res) => {
  try {
    const result = await matchProducts({ apply: true });
    res.json({ ...result, status: syncStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Link one product by hand, for stock whose SKUs never matched. */
router.post('/links', ...connected, async (req, res) => {
  const { productId, variantId } = req.body || {};
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    const config = shopifyConfig();
    const client = clientFor(config);

    let found = null;
    let cursor = null;
    do {
      const page = await client.variants({ locationId: config.locationId, cursor });
      found = page.variants.find((v) => v.variantId === variantId) || null;
      cursor = found ? null : page.cursor;
    } while (cursor);

    if (!found) return res.status(404).json({ error: 'That variant is not in the shop' });

    linkProduct(product.id, found);
    logSync(product.id, 'link', `Linked by hand to ${found.title || found.variantId}`);
    res.json(syncStatus());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/links/:productId', ...connected, (req, res) => {
  unlinkProduct(Number(req.params.productId));
  res.json(syncStatus());
});

/** Every variant in the shop, for the manual link picker. */
router.get('/variants', ...connected, async (req, res) => {
  try {
    const config = shopifyConfig();
    const client = clientFor(config);
    const all = [];
    let cursor = null;
    do {
      const page = await client.variants({ locationId: config.locationId, cursor });
      all.push(...page.variants);
      cursor = page.cursor;
    } while (cursor && all.length < 1000);
    res.json({ variants: all });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ sync */

router.post('/sync', ...connected, async (req, res) => {
  try {
    const result = await syncNow({ userId: req.user.id });
    res.json({ ...result, status: syncStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Adopt one side's figure where the two disagree, for one product or all. */
router.post('/reconcile', ...connected, async (req, res) => {
  const { productId, keep } = req.body || {};
  if (!['local', 'shopify'].includes(keep)) {
    return res.status(400).json({ error: 'Say which side to keep: local or shopify' });
  }

  try {
    const result =
      productId === undefined || productId === null
        ? await reconcileAll({ keep, userId: req.user.id })
        : { settled: [await reconcile({ productId, keep, userId: req.user.id })], failed: [] };
    res.json({ ...result, status: syncStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------------- webhooks */

/**
 * Shopify calls these the moment something changes, so a sale on the website
 * shows here in seconds rather than at the next poll. Polling stays on as the
 * safety net — a shop behind a home router has no public address for Shopify to
 * reach, and a webhook Shopify failed to deliver is simply never delivered.
 *
 * Verification is mandatory: this endpoint is unauthenticated by necessity, so
 * the HMAC is the only thing separating Shopify from anyone else on the
 * internet who found the URL.
 */
export function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader || !rawBody) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/webhook', (req, res) => {
  const secret = shopifyConfig().accessToken;
  if (!verifyWebhook(req.rawBody, req.get('X-Shopify-Hmac-Sha256'), secret)) {
    return res.status(401).json({ error: 'Signature did not verify' });
  }

  // Answer immediately — Shopify retries anything slower than five seconds, and
  // the work here is only ever "look at what changed", which the poll also does.
  res.json({ ok: true });

  pullFromShopify().catch((err) => logSync(null, 'error', `Webhook pull failed: ${err.message}`));
});

export default router;
