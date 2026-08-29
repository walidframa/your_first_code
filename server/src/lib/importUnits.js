/**
 * Importing phones rather than quantities.
 *
 * A normal catalogue import says "twelve of these". A handset export says
 * nothing of the sort: it is one row per physical phone, each carrying its own
 * IMEI, its own cost and often its own price, and twelve of them are twelve
 * lines that happen to share a model name.
 *
 * So when a file has an IMEI column the importer changes shape. Rows stop
 * being products and become units; products are what you get when you group
 * them. The quantity column is ignored outright — a serialised product's stock
 * *is* the number of handsets booked into it, and a file that says both is a
 * file that can contradict itself.
 *
 * This module holds only that reshaping. The reading, the column mapping and
 * the writing all stay where they were.
 */
import { UNIT_CONDITIONS } from './units.js';

/**
 * What condition a phone is in, read off its own name.
 *
 * Shops selling second-hand handsets put it in the model: "IPHONE 13 PRO 128GB
 * BLACK **USED**", "... 256GB BLACK **OB**". That is the only place the fact
 * exists in an export of this kind, so it is read from there rather than
 * asking somebody to set one condition for a mixed file — which would be wrong
 * for most of it.
 *
 * Shown in the preview before anything is committed, and changeable per
 * handset afterwards, because a guess from a name is a guess.
 */
export function conditionFromName(name) {
  const t = ` ${String(name || '').toUpperCase()} `;
  /* Open box: unsealed, sold as not-new. "OB" is checked as a whole word —
     otherwise it fires on the "ob" inside a colour or a model number. */
  if (/\bOB\b|\bOPEN BOX\b|\bREFURB\w*\b/.test(t)) return 'refurbished';
  if (/\bUSED\b|\bSECOND HAND\b|\bPRE.?OWNED\b/.test(t)) return 'used';
  return 'new';
}

/** A SKU made from a model name, for a file whose codes are per handset. */
export function skuFromName(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * Turn per-handset rows into the products they belong to.
 *
 * Grouped by **name**, not by the mapped SKU column, and that is the whole
 * reason this exists. In an export like this the code column is unique per
 * phone — 36.2269, 36.2668 — so grouping by it would make one product per
 * handset, which is a catalogue of five hundred one-off items rather than a
 * shop with five hundred phones on the shelf.
 *
 * The SKU is then whatever the rows agree on: if every phone of a model
 * carries the same code, that is the model's code and it is kept. If they
 * differ, the code was never a model code and one is made from the name. Which
 * happened is said in the group's notes, because a shop that expected its own
 * codes to survive needs to see that they did not.
 */
export function groupUnitRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const name = row.data.name;
    if (!name) continue;

    const key = name.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        name,
        skus: new Set(),
        rows: [],
        notes: [],
      });
    }
    const group = groups.get(key);
    group.rows.push(row);
    if (row.data.sku) group.skus.add(row.data.sku);
  }

  return [...groups.values()].map((group) => {
    const agreed = group.skus.size === 1 ? [...group.skus][0] : null;
    const sku = agreed || skuFromName(group.name);

    if (!agreed && group.skus.size > 1) {
      group.notes.push(
        `Each handset has its own code, so they are one product under ${sku}`,
      );
    }

    /*
     * The price the model sells at. Taken from the first row that names one:
     * a per-handset export prices each phone, and while those can differ, a
     * product carries one asking price. The per-handset figure that does
     * matter — what each one cost — is kept on the unit itself.
     */
    const priced = group.rows.find((r) => r.data.price > 0);
    const prices = new Set(group.rows.map((r) => r.data.price).filter((p) => p > 0));
    if (prices.size > 1) {
      group.notes.push(
        `${prices.size} different prices in the file; using ${(priced?.data.price ?? 0).toFixed(2)}`,
      );
    }

    const condition = conditionFromName(group.name);

    return {
      name: group.name,
      sku,
      condition,
      notes: group.notes,
      price: priced?.data.price ?? 0,
      category: group.rows.find((r) => r.data.category)?.data.category ?? null,
      supplier: group.rows.find((r) => r.data.supplier)?.data.supplier ?? null,
      barcode: group.rows.find((r) => r.data.barcode)?.data.barcode ?? null,
      /* One per handset, each with the cost that row carried. */
      units: group.rows.map((r) => ({
        line: r.line,
        imei: r.data.imei,
        cost: r.data.cost ?? 0,
        condition,
      })),
    };
  });
}

/** Whether a mapping turns the file into handsets rather than quantities. */
export function isUnitImport(mapping) {
  return Boolean(mapping?.imei);
}

export { UNIT_CONDITIONS };
