/**
 * One account, from a date to a date, in one column.
 *
 * A shop's answer to "what do I owe you?" is currently spread across four
 * screens: the invoices are in Documents, the sales are in Orders, the money
 * handed over is in Vouchers, and the balance is on the customer card. Each of
 * those is a good answer to its own question and none of them is the answer to
 * this one, which is a supplier standing at the counter with a folder wanting to
 * agree a number.
 *
 * So a statement is deliberately not a report built out of those screens. It is
 * the ledger — the one table where every movement of the balance is already
 * written down — with the documents, the sales and the vouchers hung off it by
 * reference, so each line says both what the balance did and what the piece of
 * paper behind it was called.
 *
 * Three things make it a statement rather than a list:
 *
 *   an opening balance   everything before the period, as a single figure, so
 *                        the running total starts where the last statement ended
 *   a running balance    on every line, because the argument is almost never
 *                        about the total and almost always about one week in it
 *   a closing balance    which must equal opening plus the period's movement, and
 *                        is asserted rather than recomputed
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { PARTY_TABLES } from './accounts.js';

/** What each ledger kind is called on a piece of paper. */
const KIND_LABEL = {
  sale: 'Sale',
  bill: 'Purchase',
  payment: 'Payment',
  refund: 'Refund',
  adjustment: 'Adjustment',
  opening: 'Opening balance',
};

function bounds({ from = null, to = null } = {}) {
  return {
    from: from ? `${from} 00:00:00` : null,
    to: to ? `${to} 23:59:59` : null,
    fromDate: from || null,
    toDate: to || null,
  };
}

/**
 * Everything owing before the period started.
 *
 * A statement that begins at zero on the 1st of the month is a statement that
 * says a customer owing three thousand dollars owes nothing, which is how
 * arguments start.
 */
function openingBalance(partyType, partyId, from) {
  if (!from) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS balance
         FROM account_entries
        WHERE party_type = ? AND party_id = ? AND created_at < ?`,
    )
    .get(partyType, partyId, from);
  return round2(row.balance);
}

/**
 * The paper behind each entry, found by the two links that exist.
 *
 * `account_entries` carries an `order_id` and nothing else, because it predates
 * both documents and vouchers. Rather than add columns to a table every shop
 * already has data in, the documents and vouchers are looked up by the id they
 * carry *pointing at the entry* — which is the direction the link was actually
 * written in.
 */
function referencesFor(partyType, partyId) {
  const vouchers = db
    .prepare(
      `SELECT id, voucher_number, kind, entry_id, document_id, reference, status,
              amount_usd, amount_lbp, issued_on
         FROM vouchers
        WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)`,
    )
    .all(partyType, partyId, partyType, partyId);

  const documents = db
    .prepare(
      `SELECT id, doc_number, doc_type, status, total, created_at, confirmed_at
         FROM documents WHERE party_type = ? AND party_id = ?`,
    )
    .all(partyType, partyId);

  return {
    voucherByEntry: new Map(vouchers.filter((v) => v.entry_id).map((v) => [v.entry_id, v])),
    vouchers,
    documents,
    // Documents are joined to their entry by number rather than by id, because
    // that is what the entry's note carries — see applyEffects in documents.js,
    // which writes the document number as the note.
    documentByNumber: new Map(documents.map((d) => [d.doc_number, d])),
  };
}

/**
 * Build the statement.
 *
 * `partyType` is 'customer' or 'supplier'; a transfer agency has one too, and
 * it works for the same reason — it is a party with a balance.
 */
export function statementFor(partyType, partyId, { from = null, to = null } = {}) {
  const table = PARTY_TABLES[partyType];
  if (!table) throw new Error(`There is no such thing as a ${partyType} account`);

  const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(partyId);
  if (!party) throw new Error('That account does not exist');

  const period = bounds({ from, to });
  const where = ['e.party_type = ?', 'e.party_id = ?'];
  const params = [partyType, partyId];
  if (period.from) {
    where.push('e.created_at >= ?');
    params.push(period.from);
  }
  if (period.to) {
    where.push('e.created_at <= ?');
    params.push(period.to);
  }

  const entries = db
    .prepare(
      `SELECT e.*, u.name AS user_name, o.order_number, o.id AS order_row_id, o.status AS order_status
         FROM account_entries e
         LEFT JOIN users u ON u.id = e.user_id
         LEFT JOIN orders o ON o.id = e.order_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at, e.id`,
    )
    .all(...params);

  const refs = referencesFor(partyType, partyId);
  const opening = openingBalance(partyType, partyId, period.from);

  let running = opening;
  let charged = 0;
  let paid = 0;

  const lines = entries.map((e) => {
    running = round2(running + e.amount_usd);
    if (e.amount_usd > 0) charged = round2(charged + e.amount_usd);
    else paid = round2(paid - e.amount_usd);

    const voucher = refs.voucherByEntry.get(e.id) || null;
    /*
     * An invoice's entry carries its number as the whole note ("SI-0004"), its
     * payment entry carries "SI-0004 — paid cash", and a cancellation carries
     * "Cancelled SI-0004". Pulling the number out of the sentence rather than
     * matching the sentence means all three find the same document, and a note
     * somebody typed afterwards does not lose the link.
     */
    const token = String(e.note || '').match(/\b[A-Z]{2,3}-\d{3,}\b/)?.[0] ?? null;
    const document = token ? refs.documentByNumber.get(token) || null : null;

    return {
      id: e.id,
      at: e.created_at,
      kind: e.kind,
      label: KIND_LABEL[e.kind] || e.kind,
      note: e.note,
      who: e.user_name,
      // What it did to the balance, split into the two columns a statement has.
      charge: e.amount_usd > 0 ? round2(e.amount_usd) : 0,
      credit: e.amount_usd < 0 ? round2(-e.amount_usd) : 0,
      balance: running,
      paidUsd: e.paid_usd,
      paidLbp: e.paid_lbp,
      // Whichever piece of paper this line came from, so a row can be opened.
      reference:
        document?.doc_number || voucher?.voucher_number || e.order_number || null,
      documentId: document?.id ?? voucher?.document_id ?? null,
      orderId: e.order_row_id ?? null,
      voucherId: voucher?.id ?? null,
      voucherKind: voucher?.kind ?? null,
    };
  });

  /*
   * The documents and vouchers in the period that never moved the balance —
   * an invoice paid in cash at the counter, a quotation, a receipt against one.
   * They belong on a statement because the customer has them in their folder and
   * will ask why they are not on it, but they are kept apart from the running
   * balance, which they did not change.
   */
  const inPeriod = (date) =>
    (!period.from || String(date) >= period.from) && (!period.to || String(date) <= period.to);

  const claimed = new Set(lines.map((l) => l.reference).filter(Boolean));
  const alsoOnFile = [
    ...refs.documents
      .filter((d) => inPeriod(d.confirmed_at || d.created_at) && !claimed.has(d.doc_number))
      .map((d) => ({
        kind: 'document',
        docType: d.doc_type,
        reference: d.doc_number,
        status: d.status,
        total: round2(d.total),
        at: d.confirmed_at || d.created_at,
        documentId: d.id,
      })),
    ...refs.vouchers
      .filter((v) => inPeriod(v.issued_on) && !claimed.has(v.voucher_number))
      .map((v) => ({
        kind: 'voucher',
        docType: v.kind,
        reference: v.voucher_number,
        status: v.status,
        total: round2(v.amount_usd),
        amountLbp: v.amount_lbp,
        at: v.issued_on,
        voucherId: v.id,
      })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    party: { ...party, active: !!party.active },
    partyType,
    period: { from: period.fromDate, to: period.toDate },
    opening,
    lines,
    alsoOnFile,
    totals: {
      charged,
      paid,
      // Asserted from the opening plus the movement rather than read back off
      // the balance query: if those two ever disagree, the statement is what
      // somebody is holding, and it has to be arithmetic they can check.
      closing: round2(opening + charged - paid),
      movement: round2(charged - paid),
    },
  };
}
