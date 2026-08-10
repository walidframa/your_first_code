/**
 * Shopify sync, driven against a stand-in shop that holds real inventory.
 *
 * Each test moves stock on one side and checks it lands on the other, because
 * that is the whole promise of the feature: sell it anywhere, and both places
 * agree afterwards.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeShopify } from './fakeShopify.js';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDir = mkdtempSync(path.join(tmpdir(), 'pos-shopify-'));

process.env.DB_PATH = path.join(workDir, 'shopify.sqlite');
process.env.JWT_SECRET = 'shopify-test-secret-long-enough-for-the-guard';
process.env.NODE_ENV = 'test';

const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env: process.env, encoding: 'utf8' });
assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

// Imported after DB_PATH is set, since the module opens the database on load.
const { db } = await import('../src/db.js');
const { setSetting } = await import('../src/lib/settings.js');
const sync = await import('../src/lib/shopifySync.js');
const { mainBranchId, setStock: setBranchStock } = await import('../src/lib/stock.js');
const { verifyWebhook } = await import('../src/routes/shopify.js');

let shopify;
let baseUrl;

const product = (sku) => db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
/*
 * Stock lives on a branch's shelf now, and products.stock is a mirror of the
 * total across branches. Writing the mirror directly would be undone by the
 * next refresh, so this puts the figure where the shop actually keeps it —
 * which is also what a sale at the counter does.
 */
const setStock = (sku, stock) =>
  setBranchStock({ branchId: mainBranchId(), productId: product(sku).id, stock });

before(async () => {
  shopify = createFakeShopify();
  baseUrl = await shopify.listen();

  setSetting('shopify_base_url', baseUrl);
  setSetting('shopify_token', 'test-token');
  setSetting('shopify_location_id', shopify.state.locationId);
  setSetting('shopify_enabled', 'true');
});

after(async () => {
  await shopify?.close();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from a clean queue so one test's pushes are not another's.
  db.exec('DELETE FROM shopify_sync_queue');
});

test('matching links products by SKU and reports what it could not place', async () => {
  shopify.addVariant({ sku: 'BAK-001', title: 'Croissant', available: 40 });
  shopify.addVariant({ sku: 'BEV-001', title: 'Espresso', available: 12 });
  shopify.addVariant({ sku: 'NOT-IN-POS', title: 'Website exclusive', available: 5 });

  const result = await sync.matchProducts({ apply: true });

  const matchedSkus = result.matched.map((m) => m.sku).sort();
  assert.deepEqual(matchedSkus, ['BAK-001', 'BEV-001']);
  assert.ok(result.unmatched.length > 0, 'products with no Shopify variant are reported');
  assert.ok(!result.unmatched.some((u) => u.sku === 'BAK-001'));

  const link = db.prepare('SELECT * FROM shopify_links WHERE product_id = ?').get(product('BAK-001').id);
  assert.equal(link.shopify_qty, 40, 'the link starts from what Shopify holds now');
});

test('a sale here is pushed to Shopify', async () => {
  const croissant = product('BAK-001');
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(croissant.stock, croissant.id);

  // Sell three across the counter. The trigger queues the push.
  setStock('BAK-001', croissant.stock - 3);
  assert.equal(sync.queueDepth(), 1, 'a stock change queues itself without being asked');

  const result = await sync.pushToShopify();
  assert.equal(result.failed.length, 0);
  assert.equal(shopify.quantityOf('BAK-001'), croissant.stock - 3, 'Shopify now holds the new figure');
  assert.equal(sync.queueDepth(), 0, 'and the queue is clear');
});

test('a sale on Shopify comes back here', async () => {
  const before = product('BEV-001');
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(before.stock, before.id);
  shopify.state.variants.find((v) => v.sku === 'BEV-001').available = before.stock;

  shopify.sellOnShopify('BEV-001', 4);
  const result = await sync.pullFromShopify();

  assert.equal(product('BEV-001').stock, before.stock - 4, 'local stock follows the website');
  assert.ok(result.applied.some((a) => a.productId === before.id));

  // And it shows in the product's own history, not just a sync log.
  const movement = db
    .prepare('SELECT * FROM stock_adjustments WHERE product_id = ? ORDER BY id DESC LIMIT 1')
    .get(before.id);
  assert.equal(movement.delta, -4);
  assert.match(movement.note, /Shopify/);
});

test('a sale on each side in the same minute nets out instead of overwriting', async () => {
  const espresso = product('BEV-001');
  const start = 50;
  setStock('BEV-001', start);
  shopify.state.variants.find((v) => v.sku === 'BEV-001').available = start;
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(start, espresso.id);
  db.exec('DELETE FROM shopify_sync_queue');

  // Two sold at the counter, three on the website, before either side syncs.
  setStock('BEV-001', start - 2);
  shopify.sellOnShopify('BEV-001', 3);

  await sync.syncNow();

  assert.equal(product('BEV-001').stock, start - 5, 'both sales count');
  assert.equal(shopify.quantityOf('BEV-001'), start - 5, 'and both sides agree');
});

test('a Shopify oversell cannot push local stock below zero', async () => {
  const bagel = product('BAK-002');
  shopify.addVariant({ sku: 'BAK-002', title: 'Bagel', available: 100 });
  await sync.matchProducts({ apply: true });

  setStock('BAK-002', 2);
  db.prepare('UPDATE shopify_links SET shopify_qty = 100 WHERE product_id = ?').run(bagel.id);
  shopify.sellOnShopify('BAK-002', 90);

  await sync.pullFromShopify();
  assert.equal(product('BAK-002').stock, 0, 'clamped, not negative');

  const log = sync.recentLog(5).find((l) => l.product_id === bagel.id && l.direction === 'pull');
  assert.match(log.detail, /set to 0/, 'and the disagreement is recorded');
});

test('an unreachable Shopify retries later instead of losing the change', async () => {
  const croissant = product('BAK-001');
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(999, croissant.id);
  setStock('BAK-001', 7);

  shopify.state.failNext = 5; // enough to exhaust the client's own retries
  const result = await sync.pushToShopify();

  assert.equal(result.pushed.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(sync.queueDepth(), 1, 'the change is still queued');

  const queued = db.prepare('SELECT * FROM shopify_sync_queue WHERE product_id = ?').get(croissant.id);
  assert.equal(queued.attempts, 1);
  assert.ok(queued.next_attempt_at > queued.created_at, 'and backed off rather than retried at once');

  // When the shop comes back, the queued change lands.
  shopify.state.failNext = 0;
  db.prepare("UPDATE shopify_sync_queue SET next_attempt_at = datetime('now', '-1 minute')").run();
  const second = await sync.pushToShopify();
  assert.equal(second.pushed.length, 1);
  assert.equal(shopify.quantityOf('BAK-001'), 7);
});

test('applying a Shopify change does not bounce back as a push', async () => {
  const espresso = product('BEV-001');
  const start = 30;
  setStock('BEV-001', start);
  shopify.state.variants.find((v) => v.sku === 'BEV-001').available = start;
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(start, espresso.id);
  db.exec('DELETE FROM shopify_sync_queue');

  shopify.sellOnShopify('BEV-001', 5);
  await sync.pullFromShopify();

  // The stock trigger fired, so something is queued — but pushing it must be a
  // no-op rather than a second write of a figure Shopify already has.
  const requestsBefore = shopify.state.requests;
  const result = await sync.pushToShopify();
  assert.equal(result.pushed.length, 0);
  assert.equal(shopify.state.requests, requestsBefore, 'no call was made at all');
  assert.equal(sync.queueDepth(), 0);
});

test('an unlinked product is dropped from the queue rather than retried for ever', async () => {
  const tote = product('APP-001');
  setStock('APP-001', 5);
  assert.ok(sync.queueDepth() > 0);

  await sync.pushToShopify();
  const stillQueued = db.prepare('SELECT * FROM shopify_sync_queue WHERE product_id = ?').get(tote.id);
  assert.equal(stillQueued, undefined);
});

test('reconciling to this shop sends the local figure to Shopify', async () => {
  const chips = product('SNK-001');
  shopify.addVariant({ sku: 'SNK-001', title: 'Crisps', available: 60 });
  await sync.matchProducts({ apply: true });

  setStock('SNK-001', 90);
  db.exec('DELETE FROM shopify_sync_queue');
  assert.equal(sync.syncStatus().links.find((l) => l.productId === chips.id).differs, true);

  await sync.reconcile({ productId: chips.id, keep: 'local' });

  assert.equal(shopify.quantityOf('SNK-001'), 90, 'Shopify takes the shop’s figure');
  assert.equal(sync.syncStatus().links.find((l) => l.productId === chips.id).differs, false);
});

test('reconciling to Shopify brings the website figure here', async () => {
  const chips = product('SNK-001');
  shopify.state.variants.find((v) => v.sku === 'SNK-001').available = 12;
  setStock('SNK-001', 90);
  db.prepare('UPDATE shopify_links SET shopify_qty = 90 WHERE product_id = ?').run(chips.id);
  db.exec('DELETE FROM shopify_sync_queue');

  await sync.reconcile({ productId: chips.id, keep: 'shopify' });

  assert.equal(product('SNK-001').stock, 12, 'local stock takes Shopify’s figure');
  assert.equal(sync.syncStatus().links.find((l) => l.productId === chips.id).differs, false);
});

test('reconciling everything settles every disagreement at once', async () => {
  for (const [sku, local] of [
    ['BAK-001', 11],
    ['BEV-001', 22],
    ['SNK-001', 33],
  ]) {
    setStock(sku, local);
    db.prepare('UPDATE shopify_links SET shopify_qty = 1 WHERE product_id = (SELECT id FROM products WHERE sku = ?)').run(sku);
  }
  db.exec('DELETE FROM shopify_sync_queue');
  assert.ok(sync.syncStatus().links.filter((l) => l.differs).length >= 3);

  const result = await sync.reconcileAll({ keep: 'local' });

  assert.equal(result.failed.length, 0);
  assert.equal(shopify.quantityOf('BAK-001'), 11);
  assert.equal(shopify.quantityOf('BEV-001'), 22);
  assert.equal(shopify.quantityOf('SNK-001'), 33);
  assert.equal(sync.syncStatus().links.filter((l) => l.differs).length, 0);
});

test('a completed pull records when the shop was last checked', async () => {
  setSetting('shopify_last_sync', '');
  await sync.pullFromShopify();
  const { lastSync } = sync.syncStatus();
  assert.ok(lastSync, 'the poll leaves a timestamp behind');
  assert.ok(Date.now() - new Date(lastSync).getTime() < 60_000);
});

test('status shows where the two sides disagree', async () => {
  const croissant = product('BAK-001');
  db.prepare('UPDATE shopify_links SET shopify_qty = ? WHERE product_id = ?').run(3, croissant.id);
  setStock('BAK-001', 9);

  const status = sync.syncStatus();
  const row = status.links.find((l) => l.productId === croissant.id);
  assert.equal(row.localStock, 9);
  assert.equal(row.shopifyQty, 3);
  assert.equal(row.differs, true);
  assert.equal(status.connected, true);
});

test('a bad token is reported rather than swallowed', async () => {
  const config = { ...sync.shopifyConfig(), accessToken: 'wrong-token' };
  await assert.rejects(() => sync.pullFromShopify({ config }), /token/i);
});

test('a webhook is only accepted with a matching signature', () => {
  const body = Buffer.from(JSON.stringify({ inventory_item_id: 1 }));
  const secret = 'test-token';
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(verifyWebhook(body, good, secret), true);
  assert.equal(verifyWebhook(body, 'not-the-signature', secret), false);
  assert.equal(verifyWebhook(body, good, 'different-secret'), false);
  assert.equal(verifyWebhook(body, null, secret), false);
  assert.equal(verifyWebhook(body, good, ''), false);
});
