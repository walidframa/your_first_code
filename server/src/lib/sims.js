/**
 * SIM cards — bought in batches from a supplier, sold one line at a time.
 *
 * A SIM is a serialised unit like a handset: bought at a cost, held until
 * somebody buys it, and gone once. So it rides on `product_units` and inherits
 * everything that already works there — stock counting, branch transfers, the
 * unit's own cost on the sold line, refunds putting it back.
 *
 * What it does not inherit is how it is identified. Nobody reads an ICCID off a
 * card to find out whose line it is; the shop and the customer both know a SIM
 * by **its phone number**, so that is what is typed in, searched for and shown.
 * The ICCID is kept when it is given and the number stands in as the unit's
 * serial when it is not, because `product_units.imei` has to be something and
 * the number is the thing that is always known.
 *
 * The other difference is the ID. A line is registered to a person, so selling
 * one takes a photograph of the buyer's ID — the same machinery as buying a
 * handset off somebody, for the same reason.
 */
import { db, transaction } from '../db.js';
import { normaliseImei, receiveUnits, syncStockFromUnits } from './units.js';
import { mainBranchId } from './stock.js';
import { waNumber } from './whatsapp.js';

/**
 * A Lebanese mobile number, stored one way so two spellings of it are one
 * number.
 *
 * `03 123 456`, `03/123456` and `+961 3 123 456` all name the same line, and a
 * shop that types it differently on the way in and on the way out cannot find
 * the SIM it is holding. Reuses the WhatsApp normaliser rather than inventing a
 * second one: it is the same question, and two answers to it would drift.
 */
export function normaliseMsisdn(raw, countryCode) {
  const digits = waNumber(raw, countryCode);
  if (!digits) throw new Error(`“${raw}” does not look like a phone number`);
  return digits;
}

/** How the shop wrote it, kept beside the normalised form for display. */
export function prettyMsisdn(msisdn, countryCode = '961') {
  const cc = String(countryCode).replace(/\D/g, '');
  // Back to the local form the counter uses: 9613123456 → 03 123 456.
  const local = msisdn.startsWith(cc) ? `0${msisdn.slice(cc.length)}` : msisdn;
  return local.replace(/^(\d{2})(\d{3})(\d{3,})$/, '$1 $2 $3');
}

/** Products the shop stocks as SIMs. */
export function simProducts({ activeOnly = true } = {}) {
  return db
    .prepare(
      `SELECT p.*, (
         SELECT COUNT(*) FROM product_units u
         WHERE u.product_id = p.id AND u.status = 'in_stock'
       ) AS available
       FROM products p
       WHERE p.is_sim = 1 ${activeOnly ? 'AND p.active = 1' : ''}
       ORDER BY p.name`,
    )
    .all();
}

/**
 * Every SIM, newest first, with what became of it.
 *
 * `status` filters to what is still sellable, which is the question at the
 * counter; without it the screen answers the back-office question of what the
 * shop has ever held.
 */
export function listSims({ status = null, search = null, branchId = null, limit = 300 } = {}) {
  const where = ['p.is_sim = 1'];
  const params = [];

  if (status) {
    where.push('u.status = ?');
    params.push(status);
  }
  if (branchId) {
    where.push('u.branch_id = ?');
    params.push(branchId);
  }
  if (search) {
    /*
     * Searched on the digits alone so "03 123 456" finds a number stored as
     * 9613123456 — the shop types it the way it is written on the card.
     */
    const digits = String(search).replace(/\D/g, '');
    where.push(digits ? '(u.msisdn LIKE ? OR u.imei LIKE ?)' : '(p.name LIKE ? OR u.imei LIKE ?)');
    params.push(digits ? `%${digits}%` : `%${search}%`, `%${search}%`);
  }

  return db
    .prepare(
      `SELECT u.id, u.msisdn, u.imei, u.status, u.cost, u.note, u.created_at, u.sold_at,
              u.branch_id, p.id AS product_id, p.name AS product_name, p.price,
              o.order_number, o.id AS order_id,
              b.name AS branch_name,
              oi.id AS order_item_id,
              EXISTS (
                SELECT 1 FROM id_photos i
                WHERE i.subject_type = 'sim_sale' AND i.subject_id = oi.id
              ) AS has_id_photo
       FROM product_units u
       JOIN products p ON p.id = u.product_id
       LEFT JOIN orders o ON o.id = u.sold_order_id
       LEFT JOIN branches b ON b.id = u.branch_id
       LEFT JOIN order_items oi ON oi.unit_id = u.id
       WHERE ${where.join(' AND ')}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ?`,
    )
    .all(...params, limit);
}

/** One SIM by the number on it, for the register's picker. */
export function simByNumber(raw, countryCode) {
  const msisdn = normaliseMsisdn(raw, countryCode);
  return (
    db
      .prepare(
        `SELECT u.*, p.name AS product_name, p.price, p.id AS product_id
         FROM product_units u JOIN products p ON p.id = u.product_id
         WHERE p.is_sim = 1 AND u.msisdn = ?`,
      )
      .get(msisdn) || null
  );
}

/**
 * Take a delivery of SIMs.
 *
 * Each line is a number and, optionally, the ICCID printed on the card. The
 * whole batch goes in or none of it does: a supplier's delivery half-entered is
 * worse than not entered, because the shop believes it has SIMs it cannot find.
 */
export function receiveSims({
  productId,
  sims,
  cost = 0,
  branchId = null,
  documentId = null,
  countryCode = '961',
}) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new Error('Pick which SIM this delivery is');
  if (!product.is_sim) throw new Error(`${product.name} is not a SIM`);
  if (!Array.isArray(sims) || sims.length === 0) throw new Error('Add at least one number');

  const seen = new Set();
  const rows = sims.map((entry) => {
    const raw = typeof entry === 'string' ? entry : entry?.msisdn;
    const msisdn = normaliseMsisdn(raw, countryCode);

    if (seen.has(msisdn)) throw new Error(`${prettyMsisdn(msisdn, countryCode)} is in this batch twice`);
    seen.add(msisdn);

    const taken = db.prepare('SELECT id FROM product_units WHERE msisdn = ?').get(msisdn);
    if (taken) throw new Error(`${prettyMsisdn(msisdn, countryCode)} is already on file`);

    const iccid = typeof entry === 'string' ? null : normaliseImei(entry?.iccid) || null;
    const each = Number(typeof entry === 'string' ? cost : (entry?.cost ?? cost)) || 0;
    if (each < 0) throw new Error('A SIM cannot cost less than nothing');

    return {
      msisdn,
      // The card's own serial where it is known, and the number where it is
      // not — product_units.imei is the unit's identity and cannot be empty.
      imei: iccid || msisdn,
      cost: each,
      note: typeof entry === 'string' ? null : entry?.note || null,
    };
  });

  return transaction(() => {
    receiveUnits(
      product.id,
      rows.map((r) => ({ imei: r.imei, condition: 'new', cost: r.cost, note: r.note })),
      { branchId: branchId ?? mainBranchId(), documentId },
    );

    // The number is what this is all for, and receiveUnits knows nothing about
    // it — so it goes on immediately afterwards, inside the same transaction.
    const setNumber = db.prepare('UPDATE product_units SET msisdn = ? WHERE imei = ?');
    for (const r of rows) setNumber.run(r.msisdn, r.imei);

    syncStockFromUnits(product.id);
    return { added: rows.length, numbers: rows.map((r) => r.msisdn) };
  })();
}
