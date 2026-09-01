import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { activityFor, costHistoryFor, recordCostChange, salesSummaryFor } from '../lib/costHistory.js';
import { averageCostMap, costingFor, lastCostMap } from '../lib/costing.js';
import { barcodeMap, barcodesFor, barcodesFromBody, generateBarcode, setBarcodes } from '../lib/barcodes.js';
import { clearStockEverywhere, setStock, stockAt, stockByBranch, stockMap } from '../lib/stock.js';
import { addStarterCategories } from '../lib/starterCategories.js';
import {
  availableBundles,
  bundleCost,
  bundleIds,
  componentsOf,
  setBundle,
} from '../lib/bundles.js';
import { attribution, download, findPhotos } from '../lib/productPhotos.js';
import { scratchMap, scratchedBy, setScratched } from '../lib/validityCards.js';

/**
 * What this request says a validity package scratches.
 *
 * `scratch_cards` is the list and the real answer. `linked_card_id` is the one
 * column that came before it, still accepted so that every caller written
 * against the old shape — the importer, an integration, an older browser tab
 * left open — goes on meaning what it meant: one card, once.
 *
 * Returns `undefined` for a request that mentions neither, which is how a form
 * that saves a product's price is stopped from silently clearing its cards.
 */
function scratchFromBody(body) {
  const list = body?.scratch_cards;
  if (Array.isArray(list) && list.length > 0) return list;

  /*
   * An empty list does not automatically mean "scratch nothing".
   *
   * Every form in this app saves a product by sending the whole product back,
   * and a product read from `GET /products` now carries `scratch_cards: []` on
   * every row that has none. So a caller written against the old shape — one
   * that reads a product, sets `linked_card_id` and puts it back — arrives here
   * with an empty list *and* a card, and taking the list at face value would
   * throw the card away. The one that was named explicitly wins.
   */
  if (body?.linked_card_id !== undefined) {
    return body.linked_card_id ? [{ cardId: Number(body.linked_card_id), quantity: 1 }] : [];
  }
  if (Array.isArray(list)) return [];
  return undefined;
}
import {
  countWithoutPhotos,
  start as startPhotoRun,
  status as photoRunStatus,
  stop as stopPhotoRun,
  undo as undoPhotoRun,
} from '../lib/photoRun.js';

const router = Router();

/*
 * `barcode` stays on every product as the primary one, because labels, Shopify
 * and the importer all read it. `barcodes` is the full list, primary first.
 */
/**
 * `stock` is what is on the shelf **at this branch** — the only figure a
 * cashier can act on, because a phone in the other shop cannot be handed over
 * here. `total_stock` is what the company owns altogether, for the questions
 * that are genuinely company-wide.
 */
function serializeProduct(p, { codes = undefined, branchId = null, here = undefined } = {}) {
  return {
    ...p,
    active: !!p.active,
    barcodes: codes ?? barcodesFor(p.id),
    total_stock: p.stock,
    stock: p.wallet_id ? p.stock : (here ?? stockAt(branchId, p.id)),
  };
}

/**
 * Check a proposed wallet before it is written.
 *
 * Two things a product cannot be at once: sold from credit and counted by IMEI.
 * One has no quantity at all, the other has a quantity of exactly one with a
 * number stamped on it, and a product claiming both would satisfy neither.
 */
/**
 * A service is not a thing, so it cannot be a thing with a serial on it.
 *
 * Enforced here rather than only in the form, because the form is not the
 * boundary — an import, a script or somebody's curl reaches the same column. A
 * product claiming both would satisfy neither rule: stock counted from
 * handsets that cannot exist.
 *
 * The service wins rather than the request being refused. It is the answer the
 * shop just gave, and refusing a product because two boxes disagree teaches
 * nobody anything.
 */
function settleService({ isService, tracksUnits, isSim }) {
  if (!isService) return { is_service: 0, tracks_units: tracksUnits ? 1 : 0, is_sim: isSim ? 1 : 0 };
  return { is_service: 1, tracks_units: 0, is_sim: 0 };
}

function walletProblem(walletId, tracksUnits) {
  if (walletId === undefined || walletId === null || walletId === '') return null;
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(walletId);
  if (!wallet) return 'That wallet does not exist';
  if (!wallet.active) return `${wallet.name} is closed — pick another wallet`;
  if (tracksUnits) return 'A card is sold from credit, so it cannot also be tracked by IMEI';
  return null;
}

/**
 * The trade price, as the column holds it.
 *
 * Null is "there isn't one", which is most of the catalogue and is what a blank
 * box means. Zero is a shop that gives it away, so an empty string must not
 * become one — `Number('') || null` would be null anyway, but `Number(0)` has
 * to survive, and the two are told apart here rather than in four call sites.
 */
function tradePrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The two cost figures a single product's screen wants, flattened onto it. */
function priceHistory(productId) {
  const { average, last } = costingFor(productId);
  return {
    avg_cost: average,
    last_cost: last?.cost ?? null,
    last_cost_at: last?.at ?? null,
    last_cost_ref: last?.reference ?? null,
  };
}

/**
 * The shelves the catalogue is sorted onto.
 *
 * With a count of what is on each, because that is the number that decides
 * whether one can be got rid of — and a list of empty categories nobody can
 * see is a list nobody tidies.
 */
router.get('/categories', requireAuth, (req, res) => {
  const categories = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c ORDER BY c.name`,
    )
    .all();
  res.json({ categories });
});

router.post('/categories', requireAuth, requirePermission('catalogue'), (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
    res.status(201).json({ category: { id: info.lastInsertRowid, name: name.trim() } });
  } catch {
    res.status(409).json({ error: 'Category already exists' });
  }
});

/* ------------------------------------------------------------------ *
 * Pictures, found from the product's name
 * ------------------------------------------------------------------ */

/**
 * How many products are still grey, so the screen can offer to go and get them.
 *
 * Declared with the other collection routes and above `/:id`, because Express
 * matches in order and "photos" is a perfectly good id as far as a route
 * pattern is concerned.
 */
router.get('/photos/pending', requireAuth, requirePermission('catalogue'), (req, res) => {
  res.json({
    pending: countWithoutPhotos({ includeArchived: req.query.archived === 'true' }),
    run: photoRunStatus(),
  });
});

/** Start the run. Answers at once; the work carries on behind it. */
router.post('/photos/run', requireAuth, requirePermission('catalogue'), (req, res) => {
  const { limit = null, includeArchived = false } = req.body || {};
  const outcome = startPhotoRun({
    limit: Number(limit) > 0 ? Number(limit) : null,
    includeArchived: Boolean(includeArchived),
  });
  if (!outcome.started) return res.status(409).json({ error: outcome.reason, run: outcome.status });
  res.status(202).json({ run: outcome.status });
});

/** What the screen polls while it runs, and reads after it finishes. */
router.get('/photos/run', requireAuth, requirePermission('catalogue'), (req, res) => {
  res.json({ run: photoRunStatus() });
});

router.post('/photos/run/stop', requireAuth, requirePermission('catalogue'), (req, res) => {
  res.json({ run: stopPhotoRun() });
});

/**
 * Put back what the run did — one product, or the lot.
 *
 * The whole point of an undo here is that this is a machine guessing from a
 * name. A shop that runs it over nine hundred products and finds it has put a
 * picture of a garden hose on its cables needs one button, not nine hundred.
 */
router.post('/photos/run/undo', requireAuth, requirePermission('catalogue'), (req, res) => {
  const { productId = null } = req.body || {};
  res.json({ ...undoPhotoRun({ productId }), run: photoRunStatus() });
});

/**
 * Pictures of something, to look at before any of them is kept.
 *
 * Takes a query rather than a product id, for two reasons. A product being
 * typed in for the first time has no id yet and wants a picture just as much as
 * one that has been on the shelf a year. And the name on the shelf label is not
 * always the name the internet knows the thing by — "iPh 14 P" is a fine SKU
 * and a hopeless query, and retyping it is quicker than renaming the product to
 * suit a search engine.
 */
router.get('/photos/search', requireAuth, requirePermission('catalogue'), async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'What should it look for?' });

  try {
    res.json(await findPhotos(query));
  } catch (err) {
    res.status(502).json({ error: err.message || 'Could not search for pictures' });
  }
});

/**
 * Fetch one, and hand back what the product column would hold.
 *
 * The picture is fetched here rather than by the browser: what the browser was
 * shown is a link, and what a product holds is the picture itself. Doing it
 * server-side also means the size ceiling and the rules about what may be
 * fetched at all are applied in one place, whether a person picked this one or
 * a run did.
 *
 * It does not save. The form that asked puts it in the field, and the ordinary
 * Save writes it with everything else the person changed — so a picture chosen
 * and then thought better of goes away with Cancel, like every other edit.
 */
router.post('/photos/fetch', requireAuth, requirePermission('catalogue'), async (req, res) => {
  const { url, provider = '', licence = '', page = '' } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Which picture?' });

  try {
    const picture = await download(url);
    res.json({
      image_url: picture.dataUri,
      image_source: attribution({ provider, licence, page }),
      byteSize: picture.byteSize,
    });
  } catch (err) {
    res.status(422).json({ error: err.message || 'That picture could not be used' });
  }
});

/**
 * The shelves a phone shop usually files by, in one press.
 *
 * A shop that has been running a while and never got round to categories is
 * looking at the same blank list a new one is, and typing sixteen names into a
 * dialog is the reason it stays blank. Anything already there is left exactly
 * as it is — including a shelf the shop spelled its own way, which must not be
 * duplicated under this list's spelling.
 */
router.post('/categories/starter', requireAuth, requirePermission('catalogue'), (req, res) => {
  const added = addStarterCategories(db);
  res.status(added.length ? 201 : 200).json({ added });
});

/**
 * Rename one.
 *
 * Every product pointing at it follows, because they point at the row and not
 * at the word — which is the whole reason a shop can fix a typo it has been
 * looking at for a month without touching the catalogue.
 */
router.patch('/categories/:id', requireAuth, requirePermission('catalogue'), (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).json({ error: 'Category not found' });

  /* Left alone when the caller does not mention it, so renaming a category
     cannot quietly take it off the register. */
  const onRegister =
    req.body?.onRegister === undefined ? category.on_register : req.body.onRegister ? 1 : 0;

  try {
    db.prepare('UPDATE categories SET name = ?, on_register = ? WHERE id = ?').run(
      name.trim(),
      onRegister,
      category.id,
    );
    res.json({ category: { ...category, name: name.trim(), on_register: onRegister } });
  } catch {
    // Renaming onto a name already taken. Merging two categories is a
    // different job with different consequences, so it is not done by accident.
    res.status(409).json({ error: `There is already a category called “${name.trim()}”` });
  }
});

/**
 * Delete one.
 *
 * Refused while products are still on it, because a shop that deletes a
 * category by accident has quietly uncategorised part of its catalogue and will
 * not find out until it next looks for something. The count comes back in the
 * message so the answer is in front of whoever has to decide.
 *
 * `?force=true` is that decision made: the category goes and its products
 * become uncategorised, which is a state they can already be in.
 */
router.delete('/categories/:id', requireAuth, requirePermission('catalogue'), (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).json({ error: 'Category not found' });

  const inUse = db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?')
    .get(category.id).n;

  if (inUse > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: `${inUse} product${inUse === 1 ? ' is' : 's are'} in “${category.name}”`,
      productCount: inUse,
    });
  }

  transaction(() => {
    db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(category.id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
  })();

  res.json({ deleted: true, uncategorised: inUse });
});

router.get('/', requireAuth, (req, res) => {
  const { activeOnly } = req.query;
  const rows = activeOnly === 'true'
    ? db.prepare(`
        SELECT p.*, c.name AS category_name, w.name AS wallet_name FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN wallets w ON w.id = p.wallet_id
        WHERE p.active = 1 ORDER BY p.name
      `).all()
    : db.prepare(`
        SELECT p.*, c.name AS category_name, w.name AS wallet_name,
               lc.name AS linked_card_name, cw.name AS credit_wallet_name
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN wallets w ON w.id = p.wallet_id
        LEFT JOIN products lc ON lc.id = p.linked_card_id
        LEFT JOIN wallets cw ON cw.id = p.credit_wallet_id
        ORDER BY p.name
      `).all();
  // One query for every product's barcodes rather than one per product: the
  // register loads this list on every visit.
  const codes = barcodeMap();
  // One query each for barcodes and for this branch's shelf, rather than two
  // per product: the register loads the whole catalogue every visit.
  const here = stockMap(req.branchId);
  /*
   * Which of these are made of other products, in one query rather than one per
   * row. A bundle's own shelf is always empty, so the register needs to be told
   * how many can be made up or it will show every pack as out of stock.
   */
  const bundles = bundleIds();
  /*
   * What the shelf actually cost, and what the supplier charged last.
   *
   * Two more grouped queries rather than two per product. `products.cost` is
   * what somebody last typed; these are what was paid, which is the figure a
   * margin has to be worked out against while stock bought at two prices is
   * still on the shelf.
   */
  const averages = averageCostMap();
  const latest = lastCostMap();
  /*
   * What each validity package scratches, in one query rather than one per row.
   * The Cards screen names them on every line, and a shop with forty packages
   * would otherwise make forty extra round trips to draw one screen.
   */
  const scratches = scratchMap();
  res.json({
    products: rows.map((p) => {
      const last = latest.get(p.id) || null;
      const base = {
        ...serializeProduct(p, {
          codes: codes.get(p.id) || [],
          here: here.get(p.id) ?? 0,
          branchId: req.branchId,
        }),
        // Null when the shop has never booked a purchase invoice for it, which
        // is honest: falling back to `cost` would print a figure called
        // "average" that nobody averaged.
        avg_cost: averages.get(p.id) ?? null,
        last_cost: last?.cost ?? null,
        last_cost_at: last?.at ?? null,
        last_cost_ref: last?.reference ?? null,
        /* Always an array, so the screen never has to tell "none" from "not
           a validity card" by looking at two different shapes. */
        scratch_cards: scratches.get(p.id) || [],
      };
      if (!bundles.has(p.id)) return base;
      const parts = componentsOf(p.id);
      return {
        ...base,
        isBundle: true,
        bundleOf: parts,
        // What the shelves allow, standing in for a stock figure this product
        // does not have one of.
        stock: availableBundles(req.branchId, p.id, parts),
        cost: bundleCost(p.id, parts),
      };
    }),
  });
});

/**
 * What a bundle is made of, and what it may be made of.
 *
 * The candidate list leaves out bundles — a pack of packs is a tree somebody
 * has to hold in their head at a counter — and leaves out the bundle itself.
 */
router.get('/:id/bundle', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ components: componentsOf(id), canMake: availableBundles(req.branchId, id) });
});

/** Set what is in a bundle. An empty list makes it an ordinary product again. */
router.put('/:id/bundle', requireAuth, requirePermission('catalogue'), (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    setBundle(id, req.body?.components || []);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ components: componentsOf(id), canMake: availableBundles(req.branchId, id) });
});

/**
 * A free barcode for stock that arrived without one.
 *
 * Generated here rather than in the browser because the one thing that makes a
 * generated code worth having is that no other product already carries it, and
 * only the server can know that.
 *
 * Behind the products permission: it writes nothing, but handing out numbers
 * for the shop's own labels is part of running the catalogue.
 */
router.get('/next-barcode', requireAuth, requirePermission('products'), (req, res) => {
  try {
    res.json({ barcode: generateBarcode() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Look up a single product by scanned barcode or exact SKU.
 *
 * Any of the product's barcodes finds it, not just the primary — which is the
 * whole point of keeping more than one. The scanner's trailing newline is
 * stripped, because a code that arrives with whitespace matches nothing.
 */
router.get('/lookup', requireAuth, (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'code is required' });

  const product = db
    .prepare(
      `SELECT p.*, c.name AS category_name, w.name AS wallet_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN wallets w ON w.id = p.wallet_id
       WHERE p.active = 1 AND (
         lower(p.sku) = lower(?)
         OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = ?)
       )
       LIMIT 1`,
    )
    .get(code, code.replace(/\s+/g, ''));

  if (!product) return res.status(404).json({ error: `No product matches "${code}"` });
  res.json({ product: serializeProduct(product, { branchId: req.branchId }) });
});

router.post('/', requireAuth, requirePermission('catalogue'), (req, res) => {
  const {
    name, sku, price, cost, stock, category_id, image_emoji, barcode, supplier, image_url,
    reorder_point, tracks_units, warranty_months, wallet_id, is_sim,
    validity_days, linked_card_id, credit_recovered, credit_wallet_id, credits_included,
    wholesale_price, is_service,
  } = req.body || {};
  if (!name || !sku || price == null) {
    return res.status(400).json({ error: 'name, sku and price are required' });
  }
  const kind = settleService({ isService: is_service, tracksUnits: tracks_units, isSim: is_sim });
  const problem = walletProblem(wallet_id, kind.tracks_units);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const info = db.prepare(`
      INSERT INTO products (name, sku, price, cost, stock, category_id, image_emoji, barcode, supplier, image_url, reorder_point, tracks_units, warranty_months, wallet_id, is_sim, validity_days, linked_card_id, credit_recovered, credit_wallet_id, credits_included, wholesale_price, is_service)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      sku,
      Number(price),
      Number(cost) || 0,
      // The shelf itself is written below, through lib/stock.js — this column
      // is a mirror of the company total and is refreshed from the branches.
      0,
      category_id || null,
      image_emoji || '',
      barcode || null,
      supplier || null,
      image_url || null,
      Number.isFinite(Number(reorder_point)) ? Number(reorder_point) : 5,
      // Serialised stock starts empty whatever the form said: the handsets are
      // booked in by IMEI, and a typed opening quantity would be a number with
      // no phones behind it.
      kind.tracks_units,
      Math.max(0, Math.round(Number(warranty_months) || 0)),
      wallet_id || null,
      // A SIM is always serialised — the number on it is the whole point, and
      // there is no such thing as "four SIMs" without saying which four.
      kind.is_sim,
      /*
       * A validity card can be born already linked. Creating it blank and
       * linking it afterwards works too, but a shop adding a card it has just
       * started stocking knows which full card delivers it there and then.
       */
      Number(validity_days) || null,
      linked_card_id || null,
      Number(credit_recovered) || 0,
      credit_wallet_id || null,
      Number(credits_included) || null,
      // Null rather than zero for "there isn't a trade price": zero would mean
      // the shop hands it to the trade for nothing.
      tradePrice(wholesale_price),
      // Something the shop does rather than something it has — see db.js.
      kind.is_service,
    );
    /*
     * The opening count lands on the shelf of the branch it was entered at —
     * a product created at the second shop is stock at the second shop.
     *
     * Serialised products start empty whatever the form said: the handsets are
     * booked in by IMEI, and a typed quantity would be a number with no phones
     * behind it.
     */
    if (kind.tracks_units || kind.is_service) {
      /* Serialised stock is booked in by IMEI, and a service has no shelf at
         all; either way a typed opening quantity is a number with nothing
         behind it. */
      clearStockEverywhere(info.lastInsertRowid);
    } else if (Number.isFinite(Number(stock)) && Number(stock) !== 0) {
      setStock({ branchId: req.branchId, productId: info.lastInsertRowid, stock: Number(stock) });
    }

    /*
     * Written after the insert rather than in it, so `products.barcode` and the
     * table are set by the one function that keeps them in step. A barcode
     * already on something else is refused here, and the half-made product goes
     * with it — better than a product that exists with the wrong numbers on it.
     */
    try {
      setBarcodes(info.lastInsertRowid, barcodesFromBody(req.body) ?? []);
    } catch (err) {
      db.prepare('DELETE FROM products WHERE id = ?').run(info.lastInsertRowid);
      return res.status(409).json({ error: err.message });
    }

    const scratched = scratchFromBody(req.body);
    if (scratched !== undefined) {
      try {
        setScratched(info.lastInsertRowid, scratched);
      } catch (err) {
        db.prepare('DELETE FROM products WHERE id = ?').run(info.lastInsertRowid);
        return res.status(400).json({ error: err.message });
      }
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({
      product: {
        ...serializeProduct(product, { branchId: req.branchId }),
        scratch_cards: scratchedBy(info.lastInsertRowid),
      },
    });
  } catch (err) {
    res.status(409).json({ error: 'SKU already exists' });
  }
});

router.get('/:id', requireAuth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  // Where the rest of them are, which is the question asked the moment a shelf
  // here is empty.
  res.json({
    product: {
      ...serializeProduct(product, { branchId: req.branchId }),
      ...priceHistory(product.id),
      scratch_cards: scratchedBy(product.id),
    },
    branches: stockByBranch(product.id),
  });
});

router.put('/:id', requireAuth, requirePermission('catalogue'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  /*
   * Switching how a product is counted is only safe from a standing start.
   * Turning tracking on with stock on hand would claim a number of handsets
   * with no IMEIs behind them; turning it off with units booked in would strand
   * them. Either way the shelf and the record would part company.
   */
  const switchingTracking =
    req.body.tracks_units !== undefined &&
    Boolean(req.body.tracks_units) !== Boolean(product.tracks_units);

  if (switchingTracking) {
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM product_units WHERE product_id = ?')
      .get(product.id);
    if (n > 0) {
      return res.status(400).json({ error: 'Remove this product\'s units before changing how it is counted' });
    }

    /*
     * Turning tracking on for a product that already has stock.
     *
     * The quantity on hand is a number with no handsets behind it, so it cannot
     * simply carry over — but refusing outright leaves a shop that already has
     * phones in its catalogue unable to start tracking them at all, which is
     * exactly when they want to. So the count is cleared, loudly and on the
     * record, and the handsets are booked in by IMEI afterwards.
     *
     * `convertStock` is required rather than assumed: silently zeroing stock
     * because a checkbox moved would be a stock count destroyed by a click.
     */
    if (product.stock > 0) {
      if (!req.body.convertStock) {
        return res.status(409).json({
          error:
            `${product.name} has ${product.stock} in stock. Switching to IMEI tracking clears that ` +
            'count so the handsets can be booked in by their numbers.',
          needsConvert: true,
          stock: product.stock,
        });
      }

      clearStockEverywhere(product.id);
      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        product.id,
        req.user.id,
        -product.stock,
        0,
        'count_correction',
        'Switched to IMEI tracking — book the handsets in by their numbers',
        req.branchId,
      );
      product.stock = 0;
    }
  }

  const fields = [
    'name', 'sku', 'price', 'cost', 'stock', 'category_id', 'image_emoji',
    'active', 'barcode', 'supplier', 'image_url', 'image_source', 'reorder_point', 'tracks_units',
    'warranty_months', 'wallet_id',
    /*
     * A SIM is a serialised unit whose identity is the number on it rather than
     * a serial nobody reads. The flag only changes how it is stocked and sold —
     * everything else about the product is ordinary.
     */
    'is_sim',
    /*
     * A validity card and what selling one sets in motion: which full card is
     * consumed, how much credit comes back, and onto which carrier balance.
     */
    'validity_days', 'linked_card_id', 'credit_recovered', 'credit_wallet_id',
    // What a card actually carries, which is none of its price nor its cost.
    'credits_included',
    // What the trade pays, which is neither a discount off the shelf price nor
    // a markup on the cost — see the column's own note in db.js.
    'wholesale_price',
    'is_service',
  ];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }

  const walletId = updates.wallet_id === undefined ? product.wallet_id : updates.wallet_id || null;
  const tracksUnits =
    updates.tracks_units === undefined ? product.tracks_units : updates.tracks_units;
  const walletIssue = walletProblem(walletId, tracksUnits);
  if (walletIssue) return res.status(400).json({ error: walletIssue });

  /*
   * A count on a product now sold from credit is a leftover, and would keep
   * showing "12 left" beside something that cannot run out.
   */
  if (walletId && !product.wallet_id) {
    // Everywhere, not just here: a leftover count at the other branch would keep
    // showing "12 left" beside something that cannot run out.
    clearStockEverywhere(product.id);
    updates.stock = 0;
  }

  /*
   * The barcodes go in first, because that is the write that can be refused —
   * one of them belonging to another product. Better to stop before the rest of
   * the edit lands than to save the product and report the barcode failure
   * afterwards, leaving the screen disagreeing with the database.
   */
  const wantedBarcodes = barcodesFromBody(req.body, { existing: barcodesFor(product.id) });
  try {
    setBarcodes(product.id, wantedBarcodes);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  // Already written by setBarcodes, and writing it again below from a stale
  // merge would undo it.
  delete updates.barcode;

  // `product` is re-read above when the stock was cleared, so the merge cannot
  // put the old count back.
  const merged = { ...product, ...updates, barcode: barcodesFor(product.id)[0] ?? null };
  if (switchingTracking && updates.tracks_units) merged.stock = 0;

  /*
   * The same rule as on the way in, on a product being changed: turning
   * something into a service takes the serial tracking off it, because a
   * service is not a thing with a number stamped on it.
   */
  Object.assign(
    merged,
    settleService({
      isService: merged.is_service,
      tracksUnits: merged.tracks_units,
      isSim: merged.is_sim,
    }),
  );

  /*
   * And its shelf goes with it. A product with twelve on the shelf that becomes
   * a delivery charge must not leave twelve deliveries behind in the stock
   * figures, on the stock take, or in what the branch thinks it owns.
   */
  if (merged.is_service && !product.is_service) clearStockEverywhere(product.id);

  /*
   * A typed count means the shelf in front of whoever typed it. Written through
   * lib/stock.js and left out of the UPDATE below, which no longer touches the
   * stock column at all — that one is the company total, refreshed from the
   * branches.
   */
  if (updates.stock !== undefined && !merged.tracks_units && !merged.wallet_id && !merged.is_service) {
    setStock({ branchId: req.branchId, productId: product.id, stock: Number(updates.stock) || 0 });
  }

  db.prepare(`
    UPDATE products SET name = ?, sku = ?, price = ?, cost = ?, category_id = ?, image_emoji = ?,
      active = ?, barcode = ?, supplier = ?, image_url = ?, reorder_point = ?, tracks_units = ?,
      warranty_months = ?, wallet_id = ?, is_sim = ?,
      validity_days = ?, linked_card_id = ?, credit_recovered = ?, credit_wallet_id = ?,
      credits_included = ?, wholesale_price = ?, is_service = ?
    WHERE id = ?
  `).run(
    merged.name,
    merged.sku,
    Number(merged.price),
    Number(merged.cost) || 0,
    merged.category_id || null,
    merged.image_emoji || '',
    merged.active ? 1 : 0,
    merged.barcode || null,
    merged.supplier || null,
    merged.image_url || null,
    Number.isFinite(Number(merged.reorder_point)) ? Number(merged.reorder_point) : 5,
    merged.tracks_units ? 1 : 0,
    Math.max(0, Math.round(Number(merged.warranty_months) || 0)),
    walletId || null,
    merged.is_sim ? 1 : 0,
    merged.validity_days || null,
    merged.linked_card_id || null,
    Number(merged.credit_recovered) || 0,
    merged.credit_wallet_id || null,
    Number(merged.credits_included) || null,
    tradePrice(merged.wholesale_price),
    merged.is_service ? 1 : 0,
    req.params.id
  );

  /*
   * The cards this package scratches, saved with everything else.
   *
   * Not its own route, unlike a bundle's parts: this and the credit fields
   * beside it are one dialog and one press, and saving them separately would
   * let the credit land while the cards did not — which is the half-configured
   * state that whole screen exists to prevent.
   *
   * Left alone when the field is absent, so every other form that saves a
   * product does not silently clear it.
   */
  const scratched = scratchFromBody(req.body);
  if (scratched !== undefined) {
    try {
      setScratched(product.id, scratched);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // A cost that moved is worth remembering; one that did not is noise.
  recordCostChange({
    productId: product.id,
    cost: Number(merged.cost) || 0,
    previousCost: product.cost,
    source: 'edited',
    userId: req.user.id,
  });

  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  res.json({
    product: {
      ...serializeProduct(updated, { branchId: req.branchId }),
      scratch_cards: scratchedBy(product.id),
    },
  });
});

router.delete('/:id', requireAuth, requirePermission('catalogue'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Everything that has happened to one product, in one list.
 *
 * Sales, deliveries, stock corrections and cost changes live in four tables;
 * a shopkeeper asking what happened to an item wants them in order, not in
 * four places.
 */
router.get('/:id/activity', requireAuth, requirePermission('catalogue'), (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  res.json({
    product,
    activity: activityFor(product.id, req.query.limit),
    /*
     * What the shelf cost across every delivery, beside the list of the
     * deliveries themselves. "$10 then $9" is on the lines; "so $9.33 the
     * unit, over thirty of them" is the figure a margin is worked out from,
     * and adding it up by eye is how it gets got wrong.
     */
    costing: costingFor(product.id),
    // How many have gone, over what stretch — the question the list of lines
    // below cannot answer without somebody adding it up.
    sales: salesSummaryFor(product.id),
    costHistory: costHistoryFor(product.id, req.query.limit),
  });
});

export default router;
