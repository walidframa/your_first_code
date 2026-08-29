import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { parseCsvToRecords } from '../lib/csv.js';
import { readWorkbook, sheetToRecords } from '../lib/xlsx.js';
import { CANONICAL_FIELDS, PRESETS, detectFormat, buildMapping, parseNumber } from '../lib/importFormats.js';
import { barcodesFor, barcodesFromBody, setBarcodes } from '../lib/barcodes.js';
import { setStock, stockAt } from '../lib/stock.js';
import { getSettings } from '../lib/settings.js';
import { groupUnitRows, isUnitImport } from '../lib/importUnits.js';
import { receiveUnits } from '../lib/units.js';

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

  const imei = value('imei');
  /*
   * A serial makes *this row* a handset. Not the file.
   *
   * This was per-file at first, and it was wrong the moment it met a real
   * export: a shop's catalogue is phones and chargers in one list, the serial
   * column is blank on everything that is not a phone, and treating the whole
   * file as handsets refused every accessory in it. A blank serial is not a
   * broken row, it is a row about something that does not have one.
   */
  const handset = Boolean(imei);

  if (!name) errors.push('Missing product name');
  /*
   * A handset is grouped by its model name and its neighbours carry a code of
   * their own per phone, so a product code is not required of it. Anything
   * else is an ordinary product and still needs one.
   */
  if (!sku && !handset) errors.push('Missing SKU');

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
    handset,
    data: {
      name,
      sku,
      imei,
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

  /* One row per handset changes what "required" means: the name groups them
     and the serial identifies them, so a product code is not needed. */
  const serialised = isUnitImport(mapping);
  const missingRequired = CANONICAL_FIELDS.filter(
    (f) => f.required && !mapping[f.key] && !(serialised && f.key === 'sku'),
  ).map((f) => f.label);

  const existingSkus = new Set(
    db
      .prepare('SELECT sku FROM products')
      .all()
      .map((r) => r.sku.toLowerCase()),
  );

  // The rate any pound-priced row is brought onto dollars at.
  const { exchange_rate: rate } = getSettings();

  /*
   * Every serial the shop already holds, so a re-import says which line clashes
   * rather than failing halfway through with one name and no line number.
   * Both columns, because a number that is IMEI 2 of one phone cannot also be
   * IMEI 1 of another.
   */
  const takenImeis = serialised
    ? new Set(
        db
          .prepare('SELECT imei, imei2 FROM product_units')
          .all()
          .flatMap((u) => [u.imei, u.imei2])
          .filter(Boolean)
          .map((n) => String(n).replace(/\D/g, '')),
      )
    : new Set();

  const seenInFile = new Set();
  const rows = records.map((record, index) => {
    const row = buildRow(record, mapping, index, rate);

    if (row.handset) {
      /* The key is the phone, not the product: two rows of the same model are
         two handsets and entirely normal. */
      const digits = String(row.data.imei || '').replace(/\D/g, '');
      if (digits && seenInFile.has(digits)) {
        row.errors.push('This serial appears twice in the file');
      }
      if (digits) seenInFile.add(digits);
      if (digits && takenImeis.has(digits)) {
        row.errors.push('This serial is already in stock or sold');
      }
      row.action = row.errors.length ? 'error' : 'create';
      return row;
    }

    const key = row.data.sku.toLowerCase();

    if (key && seenInFile.has(key)) {
      row.errors.push('Duplicate SKU within this file');
    }
    if (key) seenInFile.add(key);

    row.action = row.errors.length ? 'error' : existingSkus.has(key) ? 'update' : 'create';
    return row;
  });

  /*
   * The file split into the two things it can hold at once.
   *
   * Phones are gathered into the models they belong to; everything else stays
   * a row about a product with a quantity, exactly as it always was.
   */
  const good = rows.filter((r) => !r.errors.length);
  const handsetRows = good.filter((r) => r.handset);
  const groups = handsetRows.length ? groupUnitRows(handsetRows) : null;

  /*
   * A model that has phones cannot also be counted by the box.
   *
   * If one row of a model carries a serial then that model is tracked by IMEI,
   * and a second row of it with the serial column empty is a phone whose
   * number was not filled in — not a quantity of them. Said plainly rather
   * than quietly booked in as loose stock, which would leave a shop with a
   * count and a shelf that disagree for ever.
   */
  const serialisedNames = new Set((groups ?? []).map((g) => g.name.toLowerCase()));
  const plainRows = [];
  for (const row of good) {
    if (row.handset) continue;
    if (serialisedNames.has(row.data.name.toLowerCase())) {
      row.errors.push('Other rows of this model have serial numbers, so this one needs one too');
      row.action = 'error';
      continue;
    }
    plainRows.push(row);
  }

  /*
   * Why rows did not become products, counted over the whole file.
   *
   * The preview's table is capped — a five-hundred-line file cannot be sent
   * back row by row — and the cap is what makes a bad import baffling: the
   * trouble is on line 300, the table stops at 100, and all the shop is left
   * with is a number smaller than the one it started with. Counted here over
   * every row, so the reason survives the cap and arrives with lines to look
   * at.
   */
  const reasons = [...rows.reduce((acc, row) => {
    for (const message of row.errors) {
      const seen = acc.get(message) ?? { message, count: 0, lines: [] };
      seen.count += 1;
      if (seen.lines.length < 5) seen.lines.push(row.line);
      acc.set(message, seen);
    }
    return acc;
  }, new Map()).values()].sort((a, b) => b.count - a.count);

  return {
    headers,
    // Null for a CSV, which has exactly one grid and nothing to choose between.
    sheets,
    sheet,
    /* Null unless the file carries serials. The preview shows the models the
       handsets fall into, which is the thing a shop actually checks. */
    groups,
    plainRows,
    /* True when there are phones in it, not merely a column for them. A
       catalogue with an empty serial column is an ordinary catalogue. */
    serialised: Boolean(groups),
    format,
    detectedFormat: detectFormat(headers),
    mapping,
    missingRequired,
    rows,
    summary: {
      total: rows.length,
      /*
       * What the file comes to, which is not the same as how many lines it
       * has and is the number the shop will count on the products screen
       * afterwards. Five hundred handsets of ninety-seven models are
       * ninety-seven products; saying only the ninety-seven, next to a file
       * the shop knows has five hundred lines in it, reads as four hundred
       * lines lost. Both figures are given so the screen can say the sentence
       * rather than leave it to be inferred.
       */
      products: groups ? groups.length + plainRows.length : rows.filter((r) => r.action !== 'error').length,
      reasons,
      create: rows.filter((r) => r.action === 'create').length,
      update: rows.filter((r) => r.action === 'update').length,
      error: rows.filter((r) => r.action === 'error').length,
      // Worth its own figure: it is the number that says the currency column
      // was read, and a shop expecting it to be zero has mapped something wrong.
      converted: rows.filter((r) => r.notes.length > 0).length,
      /* For a file with phones in it the useful pair is phones and models. A
         mixed file reports both halves, because both are being imported. */
      handsets: groups ? groups.reduce((n, g) => n + g.units.length, 0) : 0,
      models: groups ? groups.length : 0,
      plain: plainRows.length,
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

  const outcome = {
    /* What was in the file, so the last screen can close the loop between the
       number the shop uploaded and the number it ends up with. */
    total: result.rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    categoriesCreated: 0,
    handsets: 0,
    errors: [],
  };

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

  /**
   * A category by name, made if the shop allows it. The same lookup both paths
   * need, so it is said once rather than twice with a chance to drift.
   */
  const categoryFor = (name) => {
    if (!name) return null;
    const key = name.toLowerCase();
    if (categoryCache.has(key)) return categoryCache.get(key);
    if (!createCategories) return null;
    const id = insertCategory.run(name).lastInsertRowid;
    categoryCache.set(key, id);
    outcome.categoriesCreated += 1;
    return id;
  };

  /*
   * A file of phones: each model becomes one serialised product and each row
   * becomes one handset inside it.
   *
   * Stock is never set here. For a serialised product the count of units in
   * `product_units` *is* the stock — `receiveUnits` keeps the two in step — and
   * writing the Qty column over it would be one figure claiming to be another.
   */
  /**
   * The ordinary import: a row is a product and its quantity is the stock.
   *
   * Lifted out of the loop it used to live in so the handset path can call it
   * too. A real catalogue is phones *and* chargers in one file, and the
   * accessories in it have to land the way they always did — through this
   * exact code, not a second copy of it that can drift.
   */
  const importPlainRows = (rowsToImport) => {
    for (const row of rowsToImport) {
      if (row.errors.length) {
        outcome.errors.push({ line: row.line, sku: row.data.sku, messages: row.errors });
        continue;
      }

      const categoryId = categoryFor(row.data.category);

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
  };

  if (result.serialised) {
    transaction(() => {
      for (const row of result.rows) {
        if (row.errors.length) {
          outcome.errors.push({ line: row.line, sku: row.data.imei || row.data.name, messages: row.errors });
        }
      }

      for (const group of result.groups) {
        const categoryId = categoryFor(group.category);
        const existing = findProduct.get(group.sku);

        const payload = {
          name: group.name,
          sku: group.sku,
          price: group.price,
          /* The product's cost is a fallback for anything booked in later
             without one; each handset keeps what it actually cost. */
          cost: group.units[0]?.cost ?? 0,
          category_id: categoryId,
          barcode: group.barcode,
          supplier: group.supplier,
          image_url: null,
          reorder_point: 5,
        };

        let productId;
        if (existing) {
          if (!updateExisting) {
            outcome.skipped += 1;
            continue;
          }
          productId = existing.id;
          payload.category_id = categoryId ?? existing.category_id;
          const { sku, ...updatable } = payload;
          void sku;
          updateProduct.run({ ...updatable, id: productId });
          syncBarcode(productId, payload.barcode);
          outcome.updated += 1;
        } else {
          productId = insertProduct.run(payload).lastInsertRowid;
          syncBarcode(productId, payload.barcode);
          outcome.created += 1;
        }

        /* Serialised from here on, whether it was before or not. */
        db.prepare('UPDATE products SET tracks_units = 1 WHERE id = ?').run(productId);

        /*
         * One handset at a time rather than the whole batch.
         *
         * `receiveUnits` refuses a batch outright if any serial in it is
         * already taken — right for a person typing at a counter, wrong for a
         * five-hundred-line file where one clash would throw away the other
         * four hundred and ninety-nine. Booked one by one, a bad line is a
         * named line and the rest still lands.
         */
        for (const unit of group.units) {
          try {
            receiveUnits(
              productId,
              [{ imei: unit.imei, condition: unit.condition, cost: unit.cost }],
              { branchId: req.branchId },
            );
            outcome.handsets += 1;
          } catch (err) {
            outcome.errors.push({ line: unit.line, sku: unit.imei, messages: [err.message] });
          }
        }
      }

      /*
       * And the rest of the file, which is not phones.
       *
       * The same code path an ordinary catalogue takes, in the same
       * transaction, because a shop's export is one delivery whether or not
       * some of it has serial numbers on it.
       */
      importPlainRows(result.plainRows);
    })();

    return res.json({ ...outcome, serialised: true });
  }


  transaction(() => importPlainRows(result.rows))();

  res.json(outcome);
});

export default router;
