/**
 * Bringing a shop's customers and suppliers over from the books it kept before.
 *
 * A shop that has been trading for years does not start with an empty ledger.
 * It arrives with a list of everybody it sells to and buys from, exported out
 * of whatever it used last — and that export is almost never a flat list of
 * people. It is a chart of accounts, and the difference is the whole reason
 * this file exists.
 *
 * What comes out of an accounting package looks like this:
 *
 *     411001          Customers                                    <- a heading
 *     4110010003      ABBAS ZORKOT                          0
 *     411001000601    abed issa                     3,050,000  LBP <- one person
 *     411001000602    abed issa                             0  USD <- two rows
 *
 * The code is a hierarchy: a ledger group, a party number, and — where the
 * shop keeps a separate balance per currency — a two-digit currency ledger on
 * the end. Import that naively and the shop ends up with a customer called
 * "Customers", `abed issa` twice, and half its balances in the wrong column.
 *
 * So the shape is worked out from the file rather than assumed, and nothing
 * that cannot be understood is guessed at: it is skipped, counted, and shown.
 * An import that quietly drops a row is worse than one that refuses it, because
 * the shop finds out months later from a balance that never agreed.
 */
import { db } from '../db.js';
import { addEntry } from './accounts.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';

/* The same "effectively no limit" a customer typed in by hand gets. */
const DEFAULT_CREDIT_LIMIT = 100000;

export const PARTY_TYPES = ['customer', 'supplier'];

const TABLE = { customer: 'customers', supplier: 'suppliers' };

/** The columns this understands, and what a shop would call them. */
export const PARTY_FIELDS = [
  { key: 'code', label: 'Account code', hint: 'The number from the old system. Used to tell two people with the same name apart.' },
  { key: 'name', label: 'Name', required: true },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address' },
  { key: 'balance', label: 'Balance' },
  { key: 'currency', label: 'Currency' },
  { key: 'creditLimit', label: 'Credit limit', customerOnly: true },
  { key: 'notes', label: 'Notes' },
];

/** Header names that mean each field, lower-cased and stripped of punctuation. */
const HEADER_HINTS = {
  code: ['code', 'account', 'accountcode', 'accountno', 'acno', 'no', 'number', 'ref', 'id'],
  name: ['name', 'customer', 'supplier', 'party', 'account name', 'accountname', 'fullname', 'title'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'contact', 'phoneno', 'number'],
  email: ['email', 'mail', 'emailaddress'],
  address: ['address', 'addr', 'location', 'street'],
  balance: ['balance', 'amount', 'openingbalance', 'opening', 'due', 'total'],
  currency: ['currency', 'curr', 'ccy'],
  creditLimit: ['creditlimit', 'limit', 'credit'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'description'],
};

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Which column is which, guessed from the headings.
 *
 * A guess, and it says so: the screen shows what it decided and lets the shop
 * correct it before anything is written. `number` is deliberately last in more
 * than one list, so a sheet with both "Account No" and "Phone Number" does not
 * hand the phone column to the code.
 */
export function guessMapping(headers) {
  const mapping = {};
  const taken = new Set();

  for (const [field, hints] of Object.entries(HEADER_HINTS)) {
    for (const hint of hints) {
      const found = headers.find((h) => !taken.has(h) && norm(h) === hint);
      if (found) {
        mapping[field] = found;
        taken.add(found);
        break;
      }
    }
  }
  return mapping;
}

/**
 * The currency a row is in. Anything this does not recognise is *not* taken as
 * dollars — see `readBalance`. A yuan balance read as dollars is off by a
 * factor of seven and looks entirely plausible on the screen.
 */
function readCurrency(text) {
  const t = String(text ?? '').trim().toUpperCase();
  if (t === '' ) return 'USD';
  if (['USD', 'US$', '$', 'DOLLAR', 'DOLLARS', 'USDOLLAR'].includes(t)) return 'USD';
  if (['LBP', 'LL', 'L.L.', 'LEBANESE POUND', 'LIRA', 'LBP.'].includes(t)) return 'LBP';
  return null;
}

/** A number out of a cell, tolerating thousands separators and (123) negatives. */
function readNumber(text) {
  let t = String(text ?? '').trim();
  if (!t) return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  t = t.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? sign * n : 0;
}

/**
 * A balance no single customer or supplier of a phone shop has.
 *
 * One row in a real export read 5,849,985,307,864 LL — 5.85 trillion, about
 * sixty-five million dollars at the rate of the day. It is not a balance; it is
 * something that went wrong years ago in a system nobody uses any more, and it
 * had sat in a column ever since being harmless because nobody added it up.
 *
 * The moment it is imported it stops being harmless. It lands in the ledger,
 * the trial balance, the balance sheet and every profit figure that follows,
 * and it swamps them so completely that no other number on the page can be
 * read. So a figure this size is refused and named, and the shop decides.
 *
 * A million dollars, because the largest genuine balance in the same file was
 * forty-eight thousand: high enough that no real shop trips it, low enough that
 * nothing corrupt gets past.
 */
export const IMPLAUSIBLE_USD = 1_000_000;

/**
 * Rows to parties.
 *
 * Two things are worked out from the file itself rather than asked for:
 *
 * **Headings.** A code that is a strict prefix of another code is a group, not
 * a person — `411001` sitting above `4110010003` is the word "Customers". They
 * are dropped rather than imported as a customer nobody can explain.
 *
 * **The currency ledger.** Where a shop keeps one balance per currency, each
 * party has two codes ending `01` and `02` and no code of its own. The suffix
 * length is not assumed: the shortest code left after the headings go is taken
 * as the party's own length, and anything longer is one of its currency
 * ledgers. A file whose codes are all the same length therefore groups one row
 * to one party, which is what a flat list should do.
 */
function groupRows(records, mapping) {
  const codeOf = (r) => (mapping.code ? String(r[mapping.code] ?? '').trim() : '');

  const withCode = records.filter((r) => codeOf(r));
  if (!mapping.code || withCode.length === 0) {
    // No codes at all: every row is its own party, keyed by position.
    return records.map((r, i) => ({ key: `row-${i}`, code: '', rows: [r] }));
  }

  const codes = new Set(withCode.map(codeOf));
  const headings = new Set(
    [...codes].filter((c) => [...codes].some((other) => other !== c && other.startsWith(c))),
  );

  const parties = withCode.filter((r) => !headings.has(codeOf(r)));
  const keyLength = parties.reduce((min, r) => Math.min(min, codeOf(r).length), Infinity);

  const groups = new Map();
  for (const row of parties) {
    const key = codeOf(row).slice(0, keyLength);
    if (!groups.has(key)) groups.set(key, { key, code: key, rows: [] });
    groups.get(key).rows.push(row);
  }

  /*
   * Rows with no code at all still belong to somebody. Kept as their own
   * parties rather than dropped — a blank code is a gap in the export, not a
   * reason to lose a customer.
   */
  for (const [i, row] of records.entries()) {
    if (codeOf(row)) continue;
    groups.set(`row-${i}`, { key: `row-${i}`, code: '', rows: [row] });
  }

  return [...groups.values()];
}

/** The first row in the group that actually said something for this field. */
function firstOf(group, column) {
  if (!column) return '';
  for (const row of group.rows) {
    const value = String(row[column] ?? '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * Read one party out of its rows: who they are, and what they owe.
 *
 * Balances are added up per currency and kept apart. Folding them into one
 * figure here would lose the only form in which a shop can check them — a
 * drawer, or a supplier's own statement, is right or wrong in each currency
 * independently.
 */
function readParty(group, mapping, partyType, rate) {
  const problems = [];
  const name = firstOf(group, mapping.name);

  let usd = 0;
  let lbp = 0;
  const foreign = [];

  for (const row of group.rows) {
    if (!mapping.balance) break;
    const amount = readNumber(row[mapping.balance]);
    const currency = readCurrency(mapping.currency ? row[mapping.currency] : '');

    if (currency === null) {
      /*
       * A currency this app cannot hold. Two rows in a real export were in
       * Chinese yuan, and the shop keeps its books in dollars and pounds — so
       * there is no column for it and no honest rate to invent. The party is
       * still imported; the figure is not, and it is named.
       */
      if (amount !== 0) {
        foreign.push({ amount, currency: String(row[mapping.currency] ?? '').trim() || '?' });
      }
      continue;
    }
    if (currency === 'LBP') lbp += amount;
    else usd += amount;
  }

  /*
   * Which way round the file counts.
   *
   * This app stores one signed figure meaning *outstanding*: positive is owed,
   * whether that is a customer owing the shop or the shop owing a supplier. An
   * accounting export is a trial balance, where receivables are positive and
   * payables negative — so a supplier the shop owes $997 appears as −997 and
   * has to be turned over on the way in. Left alone, every supplier balance
   * would arrive inside out and the shop would appear to be owed money by the
   * people it owes.
   */
  const sign = partyType === 'supplier' ? -1 : 1;
  usd = round2(usd * sign);
  lbp = Math.round(lbp * sign);

  const combined = round2(usd + (rate > 0 ? lbp / rate : 0));

  if (Math.abs(combined) > IMPLAUSIBLE_USD) {
    problems.push(
      `A balance of ${lbp !== 0 ? `${Math.round(lbp).toLocaleString()} LL` : `$${usd}`} ` +
        `is about $${Math.round(Math.abs(combined)).toLocaleString()} — too large to be one party’s balance, ` +
        `so it was left out. Enter it by hand if it is real.`,
    );
    usd = 0;
    lbp = 0;
  }

  for (const f of foreign) {
    problems.push(
      `${f.amount.toLocaleString()} ${f.currency} was left out — this app keeps its books in dollars and pounds.`,
    );
  }

  return {
    code: group.code,
    name,
    phone: firstOf(group, mapping.phone),
    email: firstOf(group, mapping.email),
    address: firstOf(group, mapping.address),
    notes: firstOf(group, mapping.notes),
    creditLimit: mapping.creditLimit ? firstOf(group, mapping.creditLimit) : '',
    usd,
    lbp,
    rows: group.rows.length,
    problems,
  };
}

/**
 * What the file would do, worked out without doing any of it.
 *
 * The same function serves the preview and the commit, so what the shop is
 * shown and what is written cannot drift apart — the commit does not get a
 * second, slightly different reading of the file.
 */
export function analyseParties({ records, headers, partyType, mapping: given = null }) {
  if (!PARTY_TYPES.includes(partyType)) throw new Error('Import customers or suppliers');

  const mapping = given && Object.keys(given).length ? given : guessMapping(headers);
  const rate = Number(getSettings().exchange_rate) || 0;
  const table = TABLE[partyType];

  const existing = new Map(
    db
      .prepare(`SELECT id, name, source_code FROM ${table}`)
      .all()
      .map((p) => [p.source_code ? `code:${p.source_code}` : `name:${p.name.trim().toLowerCase()}`, p]),
  );

  const parties = [];
  const skipped = [];

  for (const group of groupRows(records, mapping)) {
    const party = readParty(group, mapping, partyType, rate);

    if (!party.name) {
      /*
       * An account with a balance and no name against it. It cannot be created
       * — a party with no name is a row nobody can find again — but it must not
       * vanish either, so it is listed with its code and its figure and the
       * shop can decide what it was.
       */
      skipped.push({
        code: party.code,
        reason: 'No name in the file',
        usd: party.usd,
        lbp: party.lbp,
      });
      continue;
    }

    /*
     * Matched on the old system's code where there is one, and only on the name
     * where there is not.
     *
     * The code is what keeps three different people called CAROLE LAM three
     * different customers — matching those on name would collapse them into one
     * on the first run and be unable to tell them apart on the second.
     */
    const match =
      (party.code && existing.get(`code:${party.code}`)) ||
      (!party.code && existing.get(`name:${party.name.toLowerCase()}`)) ||
      null;

    parties.push({ ...party, action: match ? 'update' : 'create', existingId: match?.id ?? null });
  }

  return {
    partyType,
    headers,
    mapping,
    rate,
    parties,
    skipped,
    summary: {
      /* Rows in, parties out. They are different numbers whenever a shop keeps
         a balance per currency, and saying only the second next to a file the
         shop knows has more lines in it reads as lines lost. */
      rows: records.length,
      parties: parties.length,
      create: parties.filter((p) => p.action === 'create').length,
      update: parties.filter((p) => p.action === 'update').length,
      withBalance: parties.filter((p) => p.usd !== 0 || p.lbp !== 0).length,
      /*
       * What the file comes to, in each currency and in total.
       *
       * Shown before anything is written, because it is the one figure that
       * makes a wrong number visible. A real file had one supplier carrying
       * 4,291,601,000 LL — a thousand times every other pound balance in it,
       * and almost certainly old lira from before the rate moved. Every
       * individual row looked fine; the total said the shop's suppliers owed it
       * forty-two thousand dollars when in fact it owed them five.
       */
      totalUsd: round2(parties.reduce((n, p) => n + p.usd, 0)),
      totalLbp: Math.round(parties.reduce((n, p) => n + p.lbp, 0)),
      total: round2(parties.reduce((n, p) => n + p.usd + (rate > 0 ? p.lbp / rate : 0), 0)),
      withPhone: parties.filter((p) => p.phone).length,
      skipped: skipped.length,
      problems: parties.reduce((n, p) => n + p.problems.length, 0),
    },
  };
}

/**
 * Write it.
 *
 * One transaction: either the whole file lands or none of it does. A party
 * import that stopped half way would leave a shop unable to tell which half,
 * and re-running it would be a guess.
 *
 * An opening balance is written as an `opening` entry rather than a column, so
 * it appears on the party's statement as the line it is — "this is what you
 * owed us the day we started" — instead of a figure that exists with nothing
 * behind it. The two currencies are carried on the entry as well as the
 * combined dollar figure, because a shop checking against a supplier's own
 * statement checks in the currency it was billed in.
 */
export function commitParties({ analysis, userId = null, branchId = null, withBalances = true }) {
  const table = TABLE[analysis.partyType];
  const isCustomer = analysis.partyType === 'customer';
  const rate = analysis.rate;

  const outcome = { created: 0, updated: 0, balances: 0, skipped: analysis.skipped, problems: [] };

  const insert = db.prepare(
    `INSERT INTO ${table} (name, phone, email, address, notes, source_code${isCustomer ? ', credit_limit' : ''})
     VALUES (?, ?, ?, ?, ?, ?${isCustomer ? ', ?' : ''})`,
  );

  /*
   * An update fills gaps and does not empty them. A column missing from this
   * export is not an instruction to wipe the phone number somebody typed in at
   * the counter last week — the same rule the product import already follows.
   */
  const update = db.prepare(
    `UPDATE ${table} SET
       name = ?,
       phone = COALESCE(NULLIF(?, ''), phone),
       email = COALESCE(NULLIF(?, ''), email),
       address = COALESCE(NULLIF(?, ''), address),
       notes = COALESCE(NULLIF(?, ''), notes),
       source_code = COALESCE(NULLIF(?, ''), source_code)
     WHERE id = ?`,
  );

  for (const party of analysis.parties) {
    let id = party.existingId;

    if (id) {
      update.run(party.name, party.phone, party.email, party.address, party.notes, party.code, id);
      outcome.updated += 1;
    } else {
      const limit = Number(party.creditLimit);
      id = insert.run(
        party.name,
        party.phone || null,
        party.email || null,
        party.address || null,
        party.notes || null,
        party.code || null,
        ...(isCustomer ? [Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_CREDIT_LIMIT] : []),
      ).lastInsertRowid;
      outcome.created += 1;
    }

    for (const problem of party.problems) outcome.problems.push({ name: party.name, problem });

    if (!withBalances) continue;
    if (party.usd === 0 && party.lbp === 0) continue;

    /*
     * Only on the way in, never on top of what is already there.
     *
     * Re-running an import must not add the opening balance a second time. It
     * is the one figure in the file that is a *statement of history* rather
     * than a fact about the party, so it is written once and left alone —
     * anything that has happened since is on the ledger where it belongs.
     */
    const already = db
      .prepare(
        `SELECT 1 FROM account_entries
         WHERE party_type = ? AND party_id = ? AND kind = 'opening' LIMIT 1`,
      )
      .get(analysis.partyType, id);
    if (already) continue;

    addEntry({
      partyType: analysis.partyType,
      partyId: id,
      kind: 'opening',
      amountUsd: round2(party.usd + (rate > 0 ? party.lbp / rate : 0)),
      nativeUsd: party.usd,
      nativeLbp: party.lbp,
      exchangeRate: rate,
      note: 'Opening balance — imported',
      userId,
      branchId,
    });
    outcome.balances += 1;
  }

  return outcome;
}
