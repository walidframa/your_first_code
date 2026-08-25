/**
 * The books, filling themselves from the till.
 *
 * Until now the ledger was written by hand, which makes it a second set of
 * books somebody has to keep in step with the first — and nobody ever does. A
 * shop that sells forty things a day is not going to journal forty sales, so
 * the books would be a month behind by the end of the week and wrong for ever
 * after.
 *
 * ## Two rules, and they pull against each other
 *
 * **The books must never drift.** A sale that moved stock and took money but
 * posted nothing leaves the ledger permanently wrong by that sale, and nothing
 * will ever find it again. So posting happens *inside the caller's
 * transaction*: the sale and its entry are written together or neither is.
 *
 * **A sale must never be refused because of the books.** A shop with a
 * customer at the counter cannot be stopped by an account somebody has not
 * mapped yet.
 *
 * Those two cannot both hold if posting is allowed to fail — so it is not
 * allowed to fail. Every account this file looks up falls back to **Suspense**
 * rather than throwing, and the debit side is completed against Suspense
 * rather than left short. An entry is therefore always balanced and always
 * written, and anything the mapping did not understand lands in one account
 * where it is *visible* — which is exactly what suspense accounts are for. A
 * shop reads its trial balance, sees money sitting in Suspense, and fixes the
 * mapping. It never sees a sale refused, and it never has books that quietly
 * disagree with the till.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import { postEntry } from './ledger.js';

/**
 * Where each kind of money goes, by account code.
 *
 * Codes rather than ids, because a code is what a shop knows its own accounts
 * by and what survives a database being rebuilt from a backup. Overridable one
 * at a time from settings, so a shop that files its card takings somewhere
 * else changes that one line and keeps the rest.
 */
export const DEFAULT_MAP = {
  cash: '1110',
  bank: '1120',
  customers: '1200',
  stock: '1300',
  suppliers: '2100',
  vat: '2200',
  sales: '4100',
  repairs: '4200',
  fees: '4300',
  cogs: '5100',
  wages: '5200',
  rent: '5300',
  expense: '5900',
  fx: '5800',
  drawings: '3200',
  capital: '3100',
};

/** The code money goes to when nothing else claims it. */
export const SUSPENSE_CODE = '9999';

function mapping() {
  try {
    const own = JSON.parse(getSettings().gl_map || '{}');
    return { ...DEFAULT_MAP, ...(own && typeof own === 'object' ? own : {}) };
  } catch {
    // A settings row that cannot be read must not stop a sale. The defaults
    // are a working answer, and Suspense catches anything they miss.
    return { ...DEFAULT_MAP };
  }
}

/**
 * The account id for a role, or Suspense.
 *
 * Never throws, and that is the whole design. A missing account here would
 * otherwise be a refused sale — see the note at the top of this file.
 */
export function accountFor(role) {
  const code = mapping()[role];
  const found = code
    ? db.prepare("SELECT id FROM gl_accounts WHERE code = ? AND active = 1 AND is_group = 0").get(code)
    : null;
  if (found) return found.id;
  return suspenseId();
}

/**
 * Suspense, made if it is not there.
 *
 * Created on demand rather than only in the seed, because a shop that has had
 * this app since before the books existed has a chart with no Suspense in it —
 * and that shop is exactly the one whose first automatic posting will need it.
 */
export function suspenseId() {
  const found = db.prepare('SELECT id FROM gl_accounts WHERE code = ?').get(SUSPENSE_CODE);
  if (found) return found.id;
  return db
    .prepare(
      `INSERT INTO gl_accounts (code, name, type, is_group, note)
       VALUES (?, 'Suspense', 'asset', 0, 'Money the books could not place. Anything here means a mapping needs fixing.')`,
    )
    .run(SUSPENSE_CODE).lastInsertRowid;
}

/** Which ledger account one of the shop's tills belongs to. */
export function accountForTill(cashAccountId) {
  const till = cashAccountId
    ? db.prepare('SELECT kind, gl_account_id FROM cash_accounts WHERE id = ?').get(cashAccountId)
    : null;
  if (till?.gl_account_id) {
    const live = db
      .prepare('SELECT id FROM gl_accounts WHERE id = ? AND active = 1 AND is_group = 0')
      .get(till.gl_account_id);
    if (live) return live.id;
  }
  // A bank account is the bank; everything else is cash in hand until a shop
  // says otherwise.
  return accountFor(till?.kind === 'bank' ? 'bank' : 'cash');
}

/**
 * Balance the entry against Suspense, and write it.
 *
 * The last line before anything is stored. Whatever the callers below worked
 * out, the two columns are made to agree here — because an entry that does not
 * balance is refused by `postEntry`, and a refusal at this point would take a
 * completed sale down with it.
 *
 * The gap is never silently dropped. It goes to Suspense, where a shop can see
 * it on the trial balance and come and ask why.
 */
function write({ lines, memo, entryDate = null, branchId = null, userId = null }) {
  const real = lines.filter((l) => round2(l.debit || 0) !== 0 || round2(l.credit || 0) !== 0);
  if (real.length === 0) return null;

  const debit = real.reduce((s, l) => round2(s + (l.debit || 0)), 0);
  const credit = real.reduce((s, l) => round2(s + (l.credit || 0)), 0);
  const gap = round2(debit - credit);
  if (gap !== 0) {
    real.push({
      accountId: suspenseId(),
      debit: gap < 0 ? Math.abs(gap) : 0,
      credit: gap > 0 ? gap : 0,
      memo: 'The books could not place this — check the account mapping',
    });
  }
  if (real.length < 2) return null;

  return postEntry({ entryDate, memo, lines: real, source: 'auto', branchId, userId });
}

/**
 * Never let the books take a sale down with them.
 *
 * The belt to the braces above. Everything in this file is written so that it
 * cannot throw — but "cannot" is a claim about code, and the cost of being
 * wrong is a shop that cannot sell anything. So each entry point is wrapped:
 * if it somehow fails, the sale stands and the failure is counted where the
 * trial balance can show it.
 */
function guarded(what, fn) {
  try {
    return fn();
  } catch (err) {
    try {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('gl_posting_error', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(`${what}: ${err.message}`.slice(0, 500));
    } catch {
      // Writing down that the books failed must not itself fail.
    }
    return null;
  }
}

/* -------------------------------------------------------------- the till */

/**
 * A sale, as the books see it.
 *
 * Credit what was earned, debit where the money went, and take the cost of
 * what left the shelf off stock. The debit side is built from what was
 * actually tendered rather than from the total, so a split payment lands in
 * the two places it really went — and whatever is left over is the customer's
 * account, which is what "on account" means.
 */
export function postSale({ order, items = [], tillAccountId = null, userId = null }) {
  return guarded(`sale ${order.order_number}`, () => {
    const map = mapping();
    const tax = round2(order.tax || 0);
    const total = round2(order.total || 0);
    const rate = Number(order.exchange_rate) || 0;

    const lines = [];

    // What the shop earned, and the tax it is holding for somebody else.
    lines.push({ accountId: accountFor('sales'), credit: round2(total - tax), memo: order.order_number });
    if (tax > 0) lines.push({ accountId: accountFor('vat'), credit: tax });

    // Where the money went. Cash is what stayed in the drawer — taken less
    // change handed back, in both currencies.
    const cashUsd = round2((order.paid_usd || 0) - (order.change_usd || 0));
    const cashLbp = (order.paid_lbp || 0) - (order.change_lbp || 0);
    const cash = round2(cashUsd + (rate > 0 ? cashLbp / rate : 0));
    if (cash > 0) lines.push({ accountId: accountForTill(tillAccountId), debit: cash });

    if (order.payment_method === 'card') {
      lines.push({ accountId: accountFor('bank'), debit: round2(total - cash) });
    } else if (order.customer_id) {
      /*
       * Anything the money did not cover is credit. Worked out as a remainder
       * rather than read from a column, so it cannot disagree with what was
       * actually taken — and if it comes out wrong, the difference is visible
       * in Suspense rather than hidden in a customer's balance.
       */
      const owed = round2(total - cash);
      if (owed > 0) lines.push({ accountId: accountFor('customers'), debit: owed });
    }

    // And the shelf. Only what the shop knows a cost for: a line with no cost
    // must not be booked out at zero, which would show the whole price as profit.
    const cost = round2(
      items.reduce((sum, i) => sum + (Number(i.cost) || 0) * (Number(i.quantity) || 0), 0),
    );
    if (cost > 0) {
      lines.push({ accountId: accountFor('cogs'), debit: cost, memo: 'Cost of what was sold' });
      lines.push({ accountId: accountFor('stock'), credit: cost });
    }

    /*
     * The penny a dual-currency till leaves behind.
     *
     * Change is given in pounds and rounded to the nearest note the shop
     * actually holds, so a $3.50 sale settled with a $5 note and 134,000 LL
     * back really does leave $3.4944 in the drawer. The gap is small, real, and
     * arrives on a large share of sales.
     *
     * It is an **exchange difference**, and it has an account. Letting the
     * catch-all in `write` send it to Suspense instead would be true but
     * useless: within a week Suspense holds a few dollars of accumulated
     * rounding and no longer means "something here is wrong", which is the only
     * thing it is for.
     */
    const debit = lines.reduce((sum, l) => round2(sum + (l.debit || 0)), 0);
    const credit = lines.reduce((sum, l) => round2(sum + (l.credit || 0)), 0);
    const rounding = round2(credit - debit);
    if (rounding !== 0) {
      lines.push({
        accountId: accountFor('fx'),
        debit: rounding > 0 ? rounding : 0,
        credit: rounding < 0 ? Math.abs(rounding) : 0,
        memo: 'Rounding on change given in another currency',
      });
    }

    void map;
    return write({
      lines,
      memo: `Sale ${order.order_number}`,
      entryDate: String(order.created_at || '').slice(0, 10) || null,
      branchId: order.branch_id,
      userId,
    });
  });
}

/** A sale handed back: the same entry, the other way round. */
export function postRefund({ order, items = [], amount = null, tillAccountId = null, userId = null }) {
  return guarded(`refund ${order.order_number}`, () => {
    const sale = postSale({ order, items, tillAccountId, userId: null });
    if (!sale) return null;

    /*
     * Built by turning the sale's own entry over rather than by working the
     * figures out again. Two separate derivations of the same sale are two
     * chances to disagree, and the one that disagrees is the refund — which is
     * the entry nobody checks.
     */
    const share = amount === null ? 1 : Math.min(1, Math.abs(amount) / (round2(order.total) || 1));
    const lines = sale.lines.map((l) => ({
      accountId: l.account_id,
      debit: round2(l.credit_usd * share),
      credit: round2(l.debit_usd * share),
    }));

    // The sale's entry was only ever a way to work out the shape; it is not
    // what happened, so it does not stay.
    db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(sale.id);
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(sale.id);

    return write({
      lines,
      memo: amount === null ? `Voided ${order.order_number}` : `Returned against ${order.order_number}`,
      branchId: order.branch_id,
      userId,
    });
  });
}

/* ------------------------------------------------------------ the office */

/** Money spent running the shop. */
export function postExpense({ expense, tillAccountId = null, userId = null }) {
  return guarded(`expense ${expense.id}`, () => {
    const amount = round2(
      (expense.amount_usd || 0) +
        (Number(expense.exchange_rate) > 0 ? (expense.amount_lbp || 0) / expense.exchange_rate : 0),
    );
    if (amount <= 0) return null;

    // A category with an account of its own uses it; the rest is other
    // expenses, which is honest rather than inventing a heading per category.
    const role = ['wages', 'rent'].includes(expense.category) ? expense.category : 'expense';

    return write({
      lines: [
        { accountId: accountFor(role), debit: amount, memo: expense.note || expense.category },
        {
          accountId: expense.paid_with === 'cash' ? accountForTill(tillAccountId) : accountFor('bank'),
          credit: amount,
        },
      ],
      memo: `Expense — ${expense.category}`,
      entryDate: expense.spent_on || null,
      branchId: expense.branch_id,
      userId,
    });
  });
}

/**
 * A confirmed document.
 *
 * A purchase brings stock in and owes a supplier; a sale sends it out and is
 * owed by a customer. What was paid on the spot moves the same money straight
 * through the till rather than parking it on the party's account.
 */
export function postDocument({ doc, tillAccountId = null, userId = null }) {
  return guarded(`document ${doc.doc_number}`, () => {
    const total = round2(doc.total || 0);
    if (total === 0) return null;

    const rate = Number(doc.exchange_rate) || 0;
    const paid = round2((doc.paid_usd || 0) + (rate > 0 ? (doc.paid_lbp || 0) / rate : 0));
    const buying = doc.doc_type === 'purchase_invoice';
    const till = doc.payment_method === 'cash' ? accountForTill(tillAccountId) : accountFor('bank');

    const lines = buying
      ? [
          { accountId: accountFor('stock'), debit: total, memo: doc.doc_number },
          ...(paid > 0 ? [{ accountId: till, credit: Math.min(paid, total) }] : []),
          ...(total > paid ? [{ accountId: accountFor('suppliers'), credit: round2(total - paid) }] : []),
        ]
      : [
          { accountId: accountFor('sales'), credit: total, memo: doc.doc_number },
          ...(paid > 0 ? [{ accountId: till, debit: Math.min(paid, total) }] : []),
          ...(total > paid ? [{ accountId: accountFor('customers'), debit: round2(total - paid) }] : []),
        ];

    return write({
      lines,
      memo: `${String(doc.doc_type).replace(/_/g, ' ')} ${doc.doc_number}`,
      entryDate: String(doc.confirmed_at || doc.created_at || '').slice(0, 10) || null,
      branchId: doc.branch_id,
      userId,
    });
  });
}

/** Money in or out of a drawer by hand. */
export function postCashMovement({ direction, amountUsd = 0, amountLbp = 0, reason, note, tillAccountId = null, branchId = null, userId = null }) {
  return guarded('cash movement', () => {
    const rate = Number(getSettings().exchange_rate) || 0;
    const amount = round2(Math.abs(amountUsd) + (rate > 0 ? Math.abs(amountLbp) / rate : 0));
    if (amount <= 0) return null;

    const other = {
      supplier: 'suppliers',
      wages: 'wages',
      expense: 'expense',
      owner_draw: 'drawings',
      owner_funds: 'capital',
      petty_cash: 'capital',
      customer_payment: 'customers',
      bank_drop: 'bank',
    }[reason] || 'expense';

    const till = accountForTill(tillAccountId);
    const lines =
      direction === 'in'
        ? [{ accountId: till, debit: amount }, { accountId: accountFor(other), credit: amount }]
        : [{ accountId: accountFor(other), debit: amount }, { accountId: till, credit: amount }];

    return write({ lines, memo: `Cash ${direction} — ${reason || 'other'}${note ? ` · ${note}` : ''}`, branchId, userId });
  });
}
