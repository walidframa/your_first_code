import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { parseCsvToRecords } from '../lib/csv.js';
import { readWorkbook, sheetToRecords } from '../lib/xlsx.js';
import { CANONICAL_FIELDS, PRESETS, detectFormat, buildMapping, parseNumber } from '../lib/importFormats.js';
import { barcodesFor, barcodesFromBody, setBarcodes } from '../lib/barcodes.js';
import { setStock, stockAt } from '../lib/stock.js';
import { getSettings } from '../lib/settings.js';

const router = Router();
/* The same ceiling whether it arrives as text or as a spreadsheet. */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

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
 * Whether a row's money column is in pounds.
 *
 * The app keeps one price, in dollars, and derives the pounds from the rate —
 * so a file that mixes the two has to be brought onto that footing on the way
 * in. Anything that is not recognisably LBP is taken as dollars, including a
 * blank: a file with no currency column at all is a dollar file, and that is
 * the overwhelmingly common case.
 */
function isLbp(text) {
  const t = String(text || '').trim().toUpperCase();
  return t === 'LBP' || t === 'LL' || t === 'L.L.' || t === 'LEBANESE POUND';
}

function buildRow(record, mapping, index, rate = 0) {
  const errors = [];
  const notes = [];
  const value = (field) => (mapping[field] ? (record[mapping[field]] ?? '').trim() : '');

  const name = value('name');
  const sku = value('sku');
  const priceRaw = value('price');

  if (!name) errors.push('Missing product name');
  if (!sku) errors.push('Missing SKU');

  let price = parseNumber(priceRaw);
  if (priceRaw === '') errors.push('Missing price');
  else if (price === null) errors.push(`Price "${priceRaw}" is not a number`);
  else if (price < 0) errors.push('Price cannot be negative');

  /*
   * A price in pounds, converted at the shop's rate. Left alone, a 300,000 LL
   * cable becomes a $300,000 cable — a mistake nobody catches reading a preview
   * of five hundred rows, and one that surfaces at the till in front of a
   * customer. Said in the row's notes so the preview shows what happened.
   */
  if (price !== null && price > 0 && isLbp(value('currency'))) {
    if (rate > 0) {
      const asLbp = price;
      price = Math.round((price / rate) * 100) / 100;
      notes.push(`${asLbp.toLocaleString('en-US')} LL → ${price.toFixed(2)} at ${rate.toLocaleString('en-US')}`);
    } else {
      errors.push('Priced in pounds, but no exchange rate is set');
    }
  }

  const costRaw = value('cost');
  let cost = costRaw ? parseNumber(costRaw) : 0;
  if (costRaw && cost === null) errors.push(`Cost "${costRaw}" is not a number`);
  else if (cost && isLbp(value('cost_currency')) && rate > 0) {
    cost = Math.round((cost / rate) * 100) / 100;
  }

  const stockRaw = value('stock');
  const stock = stockRaw ? parseNumber(stockRaw) : 0;
  if (stockRaw && stock === null) errors.push(`Stock "${stockRaw}" is not a number`);

  const reorderRaw = value('reorder_point');
  const reorderPoint = reorderRaw ? parseNumber(reorderRaw) : null;

  return {
    line: index + 2, // +1 for the header row, +1 for 1-based line numbers
    errors,
    notes,
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

/**
 * Turn whatever was uploaded into headers and records.
 *
 * A CSV and a spreadsheet differ only in how the grid is got at, so they
 * converge here and everything downstream — the format presets, the column
 * mapping, the per-row validation — carries on knowing nothing about it.
 *
 * Throws with a message meant for the person who uploaded the file; every
 * failure here is something they can act on.
 */
function readSource({ csv, workbook, sheet }) {
  if (typeof workbook === 'string' && workbook.trim()) {
    const bytes = Buffer.from(workbook, 'base64');
    if (bytes.length > MAX_IMPORT_BYTES) {
      throw new Error('That spreadsheet is larger than the 5 MB import limit');
    }

    const { sheets } = readWorkbook(bytes);
    /*
     * Named rather than positional. A supplier's workbook routinely holds the
     * price list, a cover note and last month's version, and only the shop can
     * say which is which — but with one sheet there is nothing to ask about.
     */
    const chosen = sheet ? sheets.find((s) => s.name === sheet) : sheets.find((s) => s.rows.length > 0);
    if (!chosen) throw new Error(`That workbook has no sheet called “${sheet}”`);

    return {
      ...sheetToRecords(chosen.rows),
      sheets: sheets.map((s) => ({ name: s.name, rows: Math.max(0, s.rows.length - 1) })),
      sheet: chosen.name,
    };
  }

  return parseCsvToRecords(csv);
}

function analyze(source, requestedFormat, requestedMapping) {
  let read;
  try {
    read = readSource(source);
  } catch (err) {
    return { error: err.message };
  }

  const { headers, records, sheets = null, sheet = null } = read;
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

  // The rate any pound-priced row is brought onto dollars at.
  const { exchange_rate: rate } = getSettings();

  const seenInFile = new Set();
  const rows = records.map((record, index) => {
    const row = buildRow(record, mapping, index, rate);
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
    // Null for a CSV, which has exactly one grid and nothing to choose between.
    sheets,
    sheet,
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
      // Worth its own figure: it is the number that says the currency column
      // was read, and a shop expecting it to be zero has mapped something wrong.
      converted: rows.filter((r) => r.notes.length > 0).length,
    },
    rate,
  };
}

/**
 * What was uploaded, or a message saying why it cannot be read.
 *
 * A CSV arrives as text and a spreadsheet as base64; either is fine, neither
 * being present is not.
 */
function takeUpload(body) {
  const { csv, workbook, sheet } = body || {};
  const hasCsv = typeof csv === 'string' && csv.trim();
  const hasWorkbook = typeof workbook === 'string' && workbook.trim();

  if (!hasCsv && !hasWorkbook) {
    return { error: 'Upload a CSV or an Excel file', status: 400 };
  }
  if (hasCsv && Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BYTES) {
    return { error: 'File is larger than the 5 MB import limit', status: 413 };
  }

  return { source: { csv, workbook, sheet } };
}

router.post('/preview', requireAuth, requirePermission('imports'), (req, res) => {
  const { format, mapping } = req.body || {};
  const upload = takeUpload(req.body);
  if (upload.error) return res.status(upload.status).json({ error: upload.error });

  const result = analyze(upload.source, format, mapping);
  if (result.error) return res.status(400).json({ error: result.error });

  // Cap the rows sent back so a huge file doesn't blow up the response.
  res.json({ ...result, rows: result.rows.slice(0, 100), truncated: result.rows.length > 100 });
});

router.post('/commit', requireAuth, requirePermission('imports'), (req, res) => {
  const { format, mapping, updateExisting = true, createCategories = true } = req.body || {};
  const upload = takeUpload(req.body);
  if (upload.error) return res.status(upload.status).json({ error: upload.error });

  const result = analyze(upload.source, format, mapping);
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
    VALUES (@name, @sku, @price, @cost, 0, @category_id, @barcode, @supplier, @image_url, @reorder_point, '', 1)
  `);
  const updateProduct = db.prepare(`
    UPDATE products SET name = @name, price = @price, cost = @cost,
      category_id = @category_id, barcode = @barcode, supplier = @supplier,
      image_url = @image_url, reorder_point = @reorder_point
    WHERE id = @id
  `);
  const insertAdjustment = db.prepare(`
    INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
    VALUES (?, ?, ?, ?, 'count_correction', ?, ?)
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
        /*
         * `stock` is deliberately not bound: lib/stock.js owns that column now,
         * and a statement given a parameter it does not use is refused outright.
         */
        const { sku, stock, ...updatable } = payload;
        void sku;
        void stock;
        updateProduct.run({ ...updatable, id: existing.id });
        /*
         * A file naming one barcode sets the primary and leaves any others the
         * shop added by scanning them. Losing those to a routine catalogue
         * refresh would be a quiet way to make half the shelf unscannable.
         */
        syncBarcode(existing.id, payload.barcode);

        /*
         * A file states what is on the shelf, and the shelf it means is the one
         * the person importing is standing at. Written through lib/stock.js so
         * the branch's figure and the company total move together.
         */
        const before = stockAt(req.branchId, existing.id);
        const delta = payload.stock - before;
        if (delta !== 0) {
          setStock({ branchId: req.branchId, productId: existing.id, stock: payload.stock });
          insertAdjustment.run(existing.id, req.user.id, delta, payload.stock, 'Set by CSV import', req.branchId);
        }
        outcome.updated += 1;
      } else {
        const { stock: opening, ...insertable } = payload;
        const info = insertProduct.run(insertable);
        syncBarcode(info.lastInsertRowid, payload.barcode);
        if (opening !== 0) {
          setStock({ branchId: req.branchId, productId: info.lastInsertRowid, stock: opening });
          insertAdjustment.run(
            info.lastInsertRowid,
            req.user.id,
            opening,
            opening,
            'Opening stock from CSV import',
            req.branchId,
          );
        }
        outcome.created += 1;
      }
    }
  })();

  res.json(outcome);
});

export default router;
