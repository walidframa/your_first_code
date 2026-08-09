import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { parseCsvToRecords } from '../lib/csv.js';
import { CANONICAL_FIELDS, PRESETS, detectFormat, buildMapping, parseNumber } from '../lib/importFormats.js';
import { barcodesFor, barcodesFromBody, setBarcodes } from '../lib/barcodes.js';

const router = Router();
const MAX_CSV_BYTES = 5 * 1024 * 1024;

/**
 * Put a CSV's barcode into the barcode table as well as the column.
 *
 * A file names at most one, so it becomes the primary and anything the shop
 * added by scanning stays behind it. A row with no barcode leaves the product's
 * alone rather than clearing it: a column missing from a supplier's export is
 * not an instruction to wipe what is there.
 *
 * Never throws. A barcode that belongs to another product is a bad row in
 * somebody's spreadsheet, and failing the whole import over it — halfway
 * through, inside the transaction — helps nobody.
 */
function syncBarcode(productId, barcode) {
  if (!barcode) return;
  try {
    setBarcodes(productId, barcodesFromBody({ barcode }, { existing: barcodesFor(productId) }));
  } catch {
    // Left on whatever it had; the column still carries what the file said.
  }
}

router.get('/formats', requireAuth, requirePermission('imports'), (req, res) => {
  res.json({
    formats: Object.entries(PRESETS).map(([key, preset]) => ({ key, label: preset.label })),
    fields: CANONICAL_FIELDS,
  });
});

/**
 * Turn one CSV record into a validated product payload using the column mapping.
 * Returns { data, errors } — errors are per-row and never throw.
 */
function buildRow(record, mapping, index) {
  const errors = [];
  const value = (field) => (mapping[field] ? (record[mapping[field]] ?? '').trim() : '');

  const name = value('name');
  const sku = value('sku');
  const priceRaw = value('price');

  if (!name) errors.push('Missing product name');
  if (!sku) errors.push('Missing SKU');

  const price = parseNumber(priceRaw);
  if (priceRaw === '') errors.push('Missing price');
  else if (price === null) errors.push(`Price "${priceRaw}" is not a number`);
  else if (price < 0) errors.push('Price cannot be negative');

  const costRaw = value('cost');
  const cost = costRaw ? parseNumber(costRaw) : 0;
  if (costRaw && cost === null) errors.push(`Cost "${costRaw}" is not a number`);

  const stockRaw = value('stock');
  const stock = stockRaw ? parseNumber(stockRaw) : 0;
  if (stockRaw && stock === null) errors.push(`Stock "${stockRaw}" is not a number`);

  const reorderRaw = value('reorder_point');
  const reorderPoint = reorderRaw ? parseNumber(reorderRaw) : null;

  return {
    line: index + 2, // +1 for the header row, +1 for 1-based line numbers
    errors,
    data: {
      name,
      sku,
      price: price ?? 0,
      cost: cost ?? 0,
      stock: Math.trunc(stock ?? 0),
      category: value('category') || null,
      barcode: value('barcode') || null,
      supplier: value('supplier') || null,
      image_url: value('image_url') || null,
      reorder_point: reorderPoint === null ? null : Math.trunc(reorderPoint),
    },
  };
}

function analyze(csv, requestedFormat, requestedMapping) {
  const { headers, records } = parseCsvToRecords(csv);
  if (headers.length === 0) {
    return { error: 'The file appears to be empty' };
  }

  const format = requestedFormat && PRESETS[requestedFormat] ? requestedFormat : detectFormat(headers);
  const mapping = { ...buildMapping(headers, format), ...(requestedMapping || {}) };

  const missingRequired = CANONICAL_FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.label);

  const existingSkus = new Set(
    db
      .prepare('SELECT sku FROM products')
      .all()
      .map((r) => r.sku.toLowerCase()),
  );

  const seenInFile = new Set();
  const rows = records.map((record, index) => {
    const row = buildRow(record, mapping, index);
    const key = row.data.sku.toLowerCase();

    if (key && seenInFile.has(key)) {
      row.errors.push('Duplicate SKU within this file');
    }
    if (key) seenInFile.add(key);

    row.action = row.errors.length ? 'error' : existingSkus.has(key) ? 'update' : 'create';
    return row;
  });

  return {
    headers,
    format,
    detectedFormat: detectFormat(headers),
    mapping,
    missingRequired,
    rows,
    summary: {
      total: rows.length,
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      error: rows.filter((r) => r.action === 'error').length,
    },
  };
}

router.post('/preview', requireAuth, requirePermission('imports'), (req, res) => {
  const { csv, format, mapping } = req.body || {};
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'csv content is required' });
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    return res.status(413).json({ error: 'File is larger than the 5 MB import limit' });
  }

  const result = analyze(csv, format, mapping);
  if (result.error) return res.status(400).json({ error: result.error });

  // Cap the rows sent back so a huge file doesn't blow up the response.
  res.json({ ...result, rows: result.rows.slice(0, 100), truncated: result.rows.length > 100 });
});

router.post('/commit', requireAuth, requirePermission('imports'), (req, res) => {
  const { csv, format, mapping, updateExisting = true, createCategories = true } = req.body || {};
  if (typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'csv content is required' });
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    return res.status(413).json({ error: 'File is larger than the 5 MB import limit' });
  }

  const result = analyze(csv, format, mapping);
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.missingRequired.length) {
    return res.status(400).json({ error: `Unmapped required columns: ${result.missingRequired.join(', ')}` });
  }

  const categoryCache = new Map(
    db
      .prepare('SELECT id, name FROM categories')
      .all()
      .map((c) => [c.name.toLowerCase(), c.id]),
  );

  const outcome = { created: 0, updated: 0, skipped: 0, categoriesCreated: 0, errors: [] };

  const findProduct = db.prepare('SELECT * FROM products WHERE lower(sku) = lower(?)');
  const insertCategory = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const insertProduct = db.prepare(`
    INSERT INTO products (name, sku, price, cost, stock, category_id, barcode, supplier, image_url, reorder_point, image_emoji, active)
    VALUES (@name, @sku, @price, @cost, @stock, @category_id, @barcode, @supplier, @image_url, @reorder_point, '', 1)
  `);
  const updateProduct = db.prepare(`
    UPDATE products SET name = @name, price = @price, cost = @cost, stock = @stock,
      category_id = @category_id, barcode = @barcode, supplier = @supplier,
      image_url = @image_url, reorder_point = @reorder_point
    WHERE id = @id
  `);
  const insertAdjustment = db.prepare(`
    INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note)
    VALUES (?, ?, ?, ?, 'count_correction', ?)
  `);

  transaction(() => {
    for (const row of result.rows) {
      if (row.errors.length) {
        outcome.errors.push({ line: row.line, sku: row.data.sku, messages: row.errors });
        continue;
      }

      let categoryId = null;
      if (row.data.category) {
        const key = row.data.category.toLowerCase();
        if (categoryCache.has(key)) {
          categoryId = categoryCache.get(key);
        } else if (createCategories) {
          categoryId = insertCategory.run(row.data.category).lastInsertRowid;
          categoryCache.set(key, categoryId);
          outcome.categoriesCreated += 1;
        }
      }

      const existing = findProduct.get(row.data.sku);
      const payload = {
        name: row.data.name,
        sku: row.data.sku,
        price: row.data.price,
        cost: row.data.cost,
        stock: row.data.stock,
        category_id: categoryId,
        barcode: row.data.barcode,
        supplier: row.data.supplier,
        image_url: row.data.image_url,
        reorder_point: row.data.reorder_point ?? 5,
      };

      if (existing) {
        if (!updateExisting) {
          outcome.skipped += 1;
          continue;
        }
        // Preserve the existing category when the file doesn't specify one.
        payload.category_id = categoryId ?? existing.category_id;
        payload.reorder_point = row.data.reorder_point ?? existing.reorder_point;
        // The SKU is the match key and is not updated, so it is deliberately
        // absent here — the statement binds only the columns it sets.
        const { sku, ...updatable } = payload;
        void sku;
        updateProduct.run({ ...updatable, id: existing.id });
        /*
         * A file naming one barcode sets the primary and leaves any others the
         * shop added by scanning them. Losing those to a routine catalogue
         * refresh would be a quiet way to make half the shelf unscannable.
         */
        syncBarcode(existing.id, payload.barcode);

        const delta = payload.stock - existing.stock;
        if (delta !== 0) {
          insertAdjustment.run(existing.id, req.user.id, delta, payload.stock, 'Set by CSV import');
        }
        outcome.updated += 1;
      } else {
        const info = insertProduct.run(payload);
        syncBarcode(info.lastInsertRowid, payload.barcode);
        if (payload.stock !== 0) {
          insertAdjustment.run(info.lastInsertRowid, req.user.id, payload.stock, payload.stock, 'Opening stock from CSV import');
        }
        outcome.created += 1;
      }
    }
  })();

  res.json(outcome);
});

export default router;
