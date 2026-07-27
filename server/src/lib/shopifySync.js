/**
 * Two-way inventory sync between this shop and Shopify.
 *
 * The problem with syncing stock in both directions is deciding who is right
 * when both sides have moved. This avoids the question by never comparing the
 * two sides to each other. Each link remembers `shopify_qty` — the quantity
 * Shopify held the last time the two agreed — and every difference is measured
 * against that:
 *
 *   remote − shopify_qty   → sold or restocked *on Shopify*: apply it here
 *   local  − shopify_qty   → sold or restocked *here*: push it there
 *
 * So a sale on each side in the same minute nets out correctly instead of one
 * overwriting the other. If nothing has moved, both differences are zero and
 * the sync does nothing at all.
 */
import { db, transaction } from '../db.js';
import { createClient } from './shopify.js';
import { getSettings, setSetting } from './settings.js';

/** Retry a failed push on a widening delay rather than hammering a shop that is down. */
const BACKOFF_SECONDS = [30, 120, 600, 3600];
const MAX_ATTEMPTS = 8;

export function shopifyConfig() {
  const settings = getSettings();
  return {
    enabled: settings.shopify_enabled === 'true' || settings.shopify_enabled === true,
    shopDomain: settings.shopify_domain || '',
    accessToken: settings.shopify_token || '',
    locationId: settings.shopify_location_id || '',
    locationName: settings.shopify_location_name || '',
    // Only set by the tests, which point the client at a stand-in server.
    baseUrl: settings.shopify_base_url || null,
  };
}

export function isConfigured(config = shopifyConfig()) {
  return !!(config.accessToken && config.locationId && (config.shopDomain || config.baseUrl));
}

export function clientFor(config = shopifyConfig()) {
  return createClient({
    shopDomain: config.shopDomain,
    accessToken: config.accessToken,
    baseUrl: config.baseUrl,
  });
}

export function logSync(productId, direction, detail) {
  db.prepare('INSERT INTO shopify_sync_log (product_id, direction, detail) VALUES (?, ?, ?)').run(
    productId ?? null,
    direction,
    detail,
  );
}

export function recentLog(limit = 50) {
  return db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.sku
       FROM shopify_sync_log l
       LEFT JOIN products p ON p.id = l.product_id
       ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    )
    .all(Math.min(Number(limit) || 50, 200));
}

export function links() {
  return db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.sku, p.barcode, p.stock, p.active
       FROM shopify_links l JOIN products p ON p.id = l.product_id
       ORDER BY p.name`,
    )
    .all();
}

/* ------------------------------------------------------------------ linking */

/**
 * Match local products to Shopify variants by SKU, then barcode.
 *
 * Matching is deliberately exact: a fuzzy match on names would eventually tie
 * two different products together and quietly move the wrong stock. Anything
 * unmatched is reported so it can be linked by hand or given the right SKU.
 */
export async function matchProducts({ config = shopifyConfig(), apply = true } = {}) {
  const client = clientFor(config);

  const remote = [];
  let cursor = null;
  do {
    const page = await client.variants({ locationId: config.locationId, cursor });
    remote.push(...page.variants);
    cursor = page.cursor;
  } while (cursor);

  const bySku = new Map();
  const byBarcode = new Map();
  for (const variant of remote) {
    if (variant.sku) bySku.set(variant.sku.trim().toLowerCase(), variant);
    if (variant.barcode) byBarcode.set(variant.barcode.trim(), variant);
  }

  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const alreadyLinked = new Set(
    db.prepare('SELECT product_id FROM shopify_links').all().map((r) => r.product_id),
  );

  const matched = [];
  const unmatched = [];

  for (const product of products) {
    if (alreadyLinked.has(product.id)) continue;

    const variant =
      (product.sku && bySku.get(product.sku.trim().toLowerCase())) ||
      (product.barcode && byBarcode.get(product.barcode.trim())) ||
      null;

    if (!variant || !variant.inventoryItemId) {
      unmatched.push({ id: product.id, name: product.name, sku: product.sku });
      continue;
    }
    matched.push({ product, variant });
  }

  if (apply) {
    transaction(() => {
      for (const { product, variant } of matched) {
        linkProduct(product.id, variant);
        logSync(product.id, 'link', `Linked to ${variant.title || variant.sku || variant.variantId}`);
      }
    })();
  }

  return {
    matched: matched.map(({ product, variant }) => ({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      localStock: product.stock,
      shopifyTitle: variant.title,
      shopifyQty: variant.available,
    })),
    unmatched,
    remoteCount: remote.length,
  };
}

/**
 * Record a link.
 *
 * `shopify_qty` starts as whatever Shopify holds right now, so the first sync
 * treats neither side's figure as a change. The two are then reconciled
 * explicitly, which is a decision for the shopkeeper rather than a silent
 * overwrite of one side by the other.
 */
export function linkProduct(productId, variant) {
  db.prepare(
    `INSERT INTO shopify_links
       (product_id, variant_id, inventory_item_id, shopify_product_id, shopify_title, shopify_sku, shopify_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET
       variant_id = excluded.variant_id,
       inventory_item_id = excluded.inventory_item_id,
       shopify_product_id = excluded.shopify_product_id,
       shopify_title = excluded.shopify_title,
       shopify_sku = excluded.shopify_sku,
       shopify_qty = excluded.shopify_qty,
       last_error = NULL`,
  ).run(
    productId,
    variant.variantId,
    variant.inventoryItemId,
    variant.productId || null,
    variant.title || null,
    variant.sku || null,
    variant.available ?? null,
  );
}

export function unlinkProduct(productId) {
  db.prepare('DELETE FROM shopify_links WHERE product_id = ?').run(productId);
  db.prepare('DELETE FROM shopify_sync_queue WHERE product_id = ?').run(productId);
}

/* ------------------------------------------------------ Shopify → this shop */

/**
 * Apply what has changed on Shopify since the last sync.
 *
 * The local change is written as a stock adjustment so it appears in the
 * product's history like any other movement — a shopkeeper looking at a
 * product should be able to see that Shopify is where the stock went.
 */
export async function pullFromShopify({ config = shopifyConfig(), userId = null } = {}) {
  const client = clientFor(config);
  const linked = db
    .prepare(
      `SELECT l.*, p.stock, p.name FROM shopify_links l JOIN products p ON p.id = l.product_id`,
    )
    .all();
  if (linked.length === 0) return { checked: 0, applied: [] };

  const applied = [];

  // In batches, so a large catalogue does not become one enormous query.
  for (let i = 0; i < linked.length; i += 100) {
    const batch = linked.slice(i, i + 100);
    const levels = await client.levelsFor({
      locationId: config.locationId,
      inventoryItemIds: batch.map((l) => l.inventory_item_id),
    });

    for (const link of batch) {
      const remote = levels.get(link.inventory_item_id);
      if (remote === null || remote === undefined) continue;

      const known = link.shopify_qty;
      // A link that has never synced adopts Shopify's figure as the baseline.
      if (known === null || known === undefined) {
        db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(remote, link.product_id);
        continue;
      }

      const remoteDelta = remote - known;
      if (remoteDelta === 0) continue;

      const change = applyRemoteDelta(link, remoteDelta, remote, userId);
      applied.push(change);
    }
  }

  /*
   * A completed pull is the moment we last actually looked at Shopify, so it is
   * what "last sync" should mean. Recording it on pushes instead would keep it
   * reading "just now" whether or not anything had been checked.
   */
  setSetting('shopify_last_sync', new Date().toISOString(), userId);

  return { checked: linked.length, applied };
}

/**
 * Settle a disagreement by declaring one side right.
 *
 * Deliberately not automatic: after a stocktake the shop is right, after a rush
 * of website orders Shopify is, and only the shopkeeper knows which happened.
 */
export async function reconcile({ productId, keep, config = shopifyConfig(), userId = null }) {
  const link = db
    .prepare(
      `SELECT l.*, p.stock, p.name FROM shopify_links l
       JOIN products p ON p.id = l.product_id WHERE l.product_id = ?`,
    )
    .get(productId);
  if (!link) throw new Error('That product is not linked to Shopify');

  if (keep === 'local') {
    // Clear the baseline so the push sees the local figure as a change to send.
    db.prepare('UPDATE shopify_links SET shopify_qty = NULL WHERE product_id = ?').run(productId);
    db.prepare("INSERT INTO shopify_sync_queue (product_id, reason) VALUES (?, 'reconciled to this shop')").run(
      productId,
    );
    const result = await pushToShopify({ config });
    const failure = result.failed.find((f) => f.productId === productId);
    if (failure) throw new Error(failure.error);
    return { productId, kept: 'local', quantity: link.stock };
  }

  const client = clientFor(config);
  const levels = await client.levelsFor({
    locationId: config.locationId,
    inventoryItemIds: [link.inventory_item_id],
  });
  const remote = levels.get(link.inventory_item_id);
  if (remote === null || remote === undefined) {
    throw new Error(`Shopify is not tracking stock for ${link.name}`);
  }

  // Treat the local figure as the baseline, so the whole difference is applied
  // here as though Shopify had moved it.
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(link.stock, productId);
  await pullFromShopify({ config, userId });
  return { productId, kept: 'shopify', quantity: remote };
}

/** Settle every disagreement the same way. */
export async function reconcileAll({ keep, config = shopifyConfig(), userId = null }) {
  const differing = syncStatus().links.filter((l) => l.differs);
  const settled = [];
  const failed = [];

  for (const link of differing) {
    try {
      settled.push(await reconcile({ productId: link.productId, keep, config, userId }));
    } catch (err) {
      failed.push({ productId: link.productId, name: link.name, error: err.message });
    }
  }
  return { settled, failed };
}

/**
 * Move local stock by what Shopify did, and remember the new baseline.
 *
 * Clamped at zero: a Shopify oversell should not leave negative stock here,
 * and the log records that the two disagree so it can be looked into.
 */
function applyRemoteDelta(link, remoteDelta, remote, userId) {
  return transaction(() => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(link.product_id);
    const resulting = Math.max(0, product.stock + remoteDelta);
    const actualDelta = resulting - product.stock;

    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(resulting, product.id);
    db.prepare(
      `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      product.id,
      userId,
      actualDelta,
      resulting,
      remoteDelta < 0 ? 'other' : 'received',
      remoteDelta < 0 ? 'Sold on Shopify' : 'Restocked on Shopify',
    );

    db.prepare(
      "UPDATE shopify_links SET shopify_qty = ?, last_synced_at = datetime('now'), last_error = NULL WHERE product_id = ?",
    ).run(remote, product.id);

    const note =
      actualDelta === remoteDelta
        ? `Shopify moved ${remoteDelta > 0 ? '+' : ''}${remoteDelta} → local stock ${resulting}`
        : `Shopify moved ${remoteDelta} but local stock was only ${product.stock} — set to 0`;
    logSync(product.id, 'pull', note);

    // The trigger has queued a push for this; it will be a no-op unless the two
    // sides genuinely still differ.
    return { productId: product.id, name: product.name, delta: actualDelta, stock: resulting };
  })();
}

/* ------------------------------------------------------ this shop → Shopify */

/** One product's worth of pending pushes, newest first, deduplicated. */
export function pendingPushes(limit = 50) {
  return db
    .prepare(
      `SELECT q.product_id, MIN(q.id) AS id, MAX(q.attempts) AS attempts, MIN(q.next_attempt_at) AS next_attempt_at
       FROM shopify_sync_queue q
       WHERE q.next_attempt_at <= datetime('now')
       GROUP BY q.product_id
       ORDER BY id
       LIMIT ?`,
    )
    .all(limit);
}

export function queueDepth() {
  return db.prepare('SELECT COUNT(DISTINCT product_id) AS n FROM shopify_sync_queue').get().n;
}

/**
 * Push local stock to Shopify for everything waiting.
 *
 * A product with no link is dropped from the queue rather than retried for
 * ever — it is not an error for a local-only product to exist.
 */
export async function pushToShopify({ config = shopifyConfig() } = {}) {
  const pending = pendingPushes();
  if (pending.length === 0) return { pushed: [], failed: [] };

  const client = clientFor(config);
  const pushed = [];
  const failed = [];

  for (const row of pending) {
    const link = db
      .prepare(
        `SELECT l.*, p.stock, p.name FROM shopify_links l
         JOIN products p ON p.id = l.product_id WHERE l.product_id = ?`,
      )
      .get(row.product_id);

    if (!link) {
      db.prepare('DELETE FROM shopify_sync_queue WHERE product_id = ?').run(row.product_id);
      continue;
    }

    // Already agreed — the queue entry came from applying Shopify's own change.
    if (link.shopify_qty === link.stock) {
      db.prepare('DELETE FROM shopify_sync_queue WHERE product_id = ?').run(row.product_id);
      continue;
    }

    try {
      await client.setAvailable({
        locationId: config.locationId,
        inventoryItemId: link.inventory_item_id,
        quantity: link.stock,
      });

      db.prepare(
        "UPDATE shopify_links SET shopify_qty = ?, last_synced_at = datetime('now'), last_error = NULL WHERE product_id = ?",
      ).run(link.stock, link.product_id);
      db.prepare('DELETE FROM shopify_sync_queue WHERE product_id = ?').run(link.product_id);

      logSync(link.product_id, 'push', `Set Shopify stock to ${link.stock}`);
      pushed.push({ productId: link.product_id, name: link.name, stock: link.stock });
    } catch (err) {
      const attempts = (row.attempts || 0) + 1;
      const wait = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];

      if (attempts >= MAX_ATTEMPTS) {
        db.prepare('DELETE FROM shopify_sync_queue WHERE product_id = ?').run(link.product_id);
        logSync(link.product_id, 'error', `Gave up after ${attempts} attempts: ${err.message}`);
      } else {
        db.prepare(
          `UPDATE shopify_sync_queue
           SET attempts = ?, last_error = ?, next_attempt_at = datetime('now', ?)
           WHERE product_id = ?`,
        ).run(attempts, err.message, `+${wait} seconds`, link.product_id);
      }

      db.prepare('UPDATE shopify_links SET last_error = ? WHERE product_id = ?').run(
        err.message,
        link.product_id,
      );
      failed.push({ productId: link.product_id, name: link.name, error: err.message, attempts });
    }
  }

  return { pushed, failed };
}

/* --------------------------------------------------------------- both ways */

/** Pull first, then push, so a change on each side in the same minute both land. */
export async function syncNow({ config = shopifyConfig(), userId = null } = {}) {
  if (!isConfigured(config)) throw new Error('Shopify is not connected yet');
  const pulled = await pullFromShopify({ config, userId });
  const pushedResult = await pushToShopify({ config });
  return { ...pulled, ...pushedResult };
}

/**
 * What the two sides currently think, side by side.
 *
 * `differs` is what the shopkeeper is actually looking for: a row where the
 * quantities have drifted apart and a sync has not settled it.
 */
export function syncStatus() {
  const config = shopifyConfig();
  const rows = links();
  return {
    connected: isConfigured(config),
    enabled: config.enabled,
    shopDomain: config.shopDomain,
    locationName: config.locationName,
    lastSync: getSettings().shopify_last_sync || null,
    linkedCount: rows.length,
    queueDepth: queueDepth(),
    unlinkedCount: db
      .prepare(
        `SELECT COUNT(*) AS n FROM products p
         WHERE p.active = 1 AND NOT EXISTS (SELECT 1 FROM shopify_links l WHERE l.product_id = p.id)`,
      )
      .get().n,
    links: rows.map((l) => ({
      productId: l.product_id,
      name: l.product_name,
      sku: l.sku,
      localStock: l.stock,
      shopifyQty: l.shopify_qty,
      differs: l.shopify_qty !== null && l.shopify_qty !== l.stock,
      lastSyncedAt: l.last_synced_at,
      lastError: l.last_error,
      shopifyTitle: l.shopify_title,
    })),
  };
}
