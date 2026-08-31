/**
 * The cash drawers.
 *
 * One open session at a time *per till*. A shop with a register, a transfer
 * desk and a safe has three piles of money, counted by different people at
 * different times; one figure covering all of them is a figure nobody can
 * check. So a sitting belongs to a till, and so does every movement.
 *
 * Everything that moves physical money records a movement, so at any moment a
 * till's expected contents is its opening float plus its movements — a figure
 * that can be checked against a count rather than trusted.
 *
 * Dollars and pounds are tracked side by side, never converted into one
 * another. A drawer holding $100 and 2,000,000 LL is right or wrong in each
 * currency independently, and folding them together would make yesterday's
 * correct count look short after the rate moves.
 */
import { db, transaction } from '../db.js';
import { round2, roundLbp } from './currency.js';
import { getSettings } from './settings.js';
import { postCashMovement, postTillTransfer } from './postings.js';

/**
 * Why cash left the drawer, beyond the sale itself. Free text alone would make
 * a month's spending impossible to add up.
 */
export const CASH_OUT_REASONS = [
  'supplier',
  'expense',
  'wages',
  'owner_draw',
  'bank_drop',
  'refund',
  'other',
];

export const CASH_IN_REASONS = ['petty_cash', 'owner_funds', 'customer_payment', 'correction', 'other'];

/** Notes in circulation, for counting a drawer without adding up in your head. */
export const DENOMINATIONS = {
  USD: [100, 50, 20, 10, 5, 1],
  LBP: [100000, 50000, 20000, 10000, 5000, 1000],
};

/**
 * The till everything falls back to.
 *
 * Every caller that does not care which drawer — a sale at the register, a
 * supplier paid from the back office — gets this one, which is what lets tills
 * be added without touching any of them.
 */
export function defaultAccountId(branchId = null) {
  /*
   * A branch's own drawer first. Two shops sharing a till would mean the second
   * one's takings landing in the first one's count — and neither could be
   * closed against what is physically in it.
   */
  if (branchId) {
    const theirs = db
      .prepare('SELECT id FROM cash_accounts WHERE branch_id = ? AND active = 1 ORDER BY is_default DESC, id LIMIT 1')
      .get(branchId);
    if (theirs) return theirs.id;
  }
  return db.prepare('SELECT id FROM cash_accounts WHERE is_default = 1').get()?.id ?? null;
}

/**
 * The drawer the register rings into.
 *
 * Separate from the account above, and the separation is the point. A shop that
 * keeps its money in a safe and makes the safe its default account was, until
 * now, also ringing every sale at the counter straight into that safe: the
 * cashier counted a drawer at the end of the shift against a figure that
 * included every invoice the office had settled, and the count never agreed
 * with anything.
 *
 * So the register is tied to a **drawer** — the physical box in front of the
 * person taking the notes — and nothing else falls back to it. Sales, refunds,
 * repairs and the money handed over for a trade-in all move through it and
 * nothing else does.
 *
 * A shop with only the one account it started with has a drawer that is also
 * the default, so this returns the same thing it always did and nothing about
 * that shop changes.
 */
export function registerAccountId(branchId = null) {
  /*
   * This branch's own drawer first, for the same reason as above: two shops
   * sharing a till means the second one's takings landing in the first one's
   * count, and neither can be closed against what is physically in it.
   */
  if (branchId) {
    const theirs = db
      .prepare(
        `SELECT id FROM cash_accounts
         WHERE branch_id = ? AND active = 1 AND kind = 'drawer'
         ORDER BY is_default DESC, id LIMIT 1`,
      )
      .get(branchId);
    if (theirs) return theirs.id;
    // No drawer at this branch: whatever it does keep its money in, rather
    // than another branch's till.
    return defaultAccountId(branchId);
  }

  const drawer = db
    .prepare(
      "SELECT id FROM cash_accounts WHERE active = 1 AND kind = 'drawer' ORDER BY is_default DESC, id LIMIT 1",
    )
    .get();
  return drawer?.id ?? defaultAccountId(null);
}

/**
 * The name the office's own cash goes by when the app has to invent it.
 *
 * A shop that never opened the tills screen has one account — the drawer the
 * register rings into — and until it pays a bill outside opening hours that is
 * the literal truth about where its money is.
 */
export const OFFICE_CASH_NAME = 'Main cash';

/**
 * The shop's working cash: somewhere that is not a drawer, if it keeps one.
 *
 * A drawer is a shift. It is opened with a float, counted at the end, and the
 * difference is somebody's to explain. A safe or a desk float is not — nobody
 * hands the safe over at six — so money moves through it without anything to
 * open, which is already how `recordMovement` treats the two differently.
 *
 * Null when the shop has nothing but drawers, because that is a real answer:
 * for such a shop the drawer is where all the money is, and pretending
 * otherwise would put figures in its books it never had.
 */
export function officeCashId(branchId = null) {
  /*
   * Ordered so that a shop which has said which account it prefers is believed,
   * and one that has not gets the most likely place for working cash: the safe,
   * then a desk float, then anything else, with a bank account last because
   * notes handed to a supplier did not come out of one.
   */
  const preference = `is_default DESC,
    CASE kind WHEN 'safe' THEN 0 WHEN 'desk' THEN 1 WHEN 'other' THEN 2 ELSE 3 END,
    id`;

  if (branchId) {
    const theirs = db
      .prepare(
        `SELECT id FROM cash_accounts
         WHERE branch_id = ? AND active = 1 AND kind != 'drawer'
         ORDER BY ${preference} LIMIT 1`,
      )
      .get(branchId);
    if (theirs) return theirs.id;
  }

  /*
   * No such account at this branch. The company's own — a second shop whose
   * bills are paid out of the head office safe is the ordinary case, and it is
   * a better answer than that shop's counter drawer.
   */
  return (
    db
      .prepare(
        `SELECT id FROM cash_accounts
         WHERE active = 1 AND kind != 'drawer'
         ORDER BY ${preference} LIMIT 1`,
      )
      .get()?.id ?? null
  );
}

/**
 * The till a piece of office paperwork settles through.
 *
 * A purchase invoice is paid at a desk, out of the shop's money — not out of
 * the box in front of whoever is serving customers. The two were the same
 * account, and the result was this app's own refusal: *"Main drawer is closed —
 * open it before settling this in cash"*, told to an owner paying a supplier at
 * nine in the morning with the shop not yet open. Whether a cashier has started
 * a shift has nothing to do with whether the owner can pay a bill, and opening
 * a till nobody is going to use — then counting and closing it again — to get
 * past the message is a ritual, not a control.
 *
 * The order below is deliberately conservative: it changes the answer only in
 * the case that used to have no answer at all.
 *
 * 1. **The shop's standing account, if it is not a drawer.** A shop that keeps
 *    its money in a safe and said so is already served correctly, and moving
 *    that would rewrite where a live shop's cash has been going.
 * 2. **A drawer somebody has opened.** The notes really are in it, and taking
 *    them out is exactly what happened. Unchanged.
 * 3. **The office's own cash**, for the case this exists for: nobody has opened
 *    anything, so the money did not come from the register. It came from the
 *    safe, the office envelope, the owner's pocket.
 * 4. **The shut drawer**, when the shop keeps nothing else — and then the
 *    open-drawer rule applies as it always did, until `openingOfficeCash` is
 *    called to name the pile the money is actually coming from.
 *
 * The register is deliberately *not* routed here — see `registerAccountId`. A
 * sale taken at the counter belongs in the counter's drawer and in the count
 * the cashier signs for.
 */
export function settlementAccountId(branchId = null) {
  const standing = defaultAccountId(branchId);
  if (!needsOfficeCash(standing)) return standing;
  return officeCashId(branchId) ?? standing;
}

/**
 * Whether settling this way would be asking a shut drawer for money.
 *
 * The question the confirm step needs answered before it refuses anything: not
 * "is a drawer closed" but "is a closed drawer the only place this shop has to
 * pay from".
 */
export function needsOfficeCash(accountId) {
  if (!requiresSession()) return false;
  const till = db.prepare('SELECT kind FROM cash_accounts WHERE id = ?').get(accountId);
  return till?.kind === 'drawer' && !currentSession(accountId);
}

/**
 * What settling this way is *going* to do, without doing any of it.
 *
 * The confirm step and the screen that leads up to it must agree, and they did
 * not. `settlementAccountId` answers "which existing till", and for a shop whose
 * only account is a shut drawer that answer is the shut drawer — correct as far
 * as it goes, because `openingOfficeCash` is what happens next. But the screen
 * asked the same question and believed the literal answer, so it told the shop
 * it was about to pay out of a drawer that was closed, and then handed that
 * drawer back as the shop's own choice. A choice is held to the open-drawer
 * rule; the app's own default is not. The refusal came straight back.
 *
 * So the plan is a thing that can be read on its own, and it is a pure read —
 * nothing is created by looking at it.
 */
export function plannedSettlement(branchId = null) {
  const accountId = settlementAccountId(branchId);
  if (!needsOfficeCash(accountId)) {
    const till = db.prepare('SELECT name FROM cash_accounts WHERE id = ?').get(accountId);
    return { accountId, name: till?.name ?? null, willCreate: false };
  }
  // Nothing open and nowhere else to go: confirming will name the office's cash.
  return { accountId: null, name: OFFICE_CASH_NAME, willCreate: true };
}

/**
 * Name the pile the money actually came from, the first time it moves.
 *
 * Called only when a settlement has nowhere to go but a drawer nobody has
 * opened — which is a shop telling us, by doing it, that this money did not
 * come out of the register. It came from the safe, the office envelope, the
 * owner's pocket. That pile exists whether or not the app has a row for it, and
 * the choice is between recording it somewhere or recording it nowhere; the
 * second is what the old refusal amounted to.
 *
 * Created here rather than seeded for every shop on upgrade, because a shop
 * that pays its suppliers across the counter with the till open has no such
 * pile and should not be given an account that will only ever hold a phantom
 * negative. It appears when it is earned.
 *
 * It starts at zero and goes negative on the first payment, which is honest:
 * the shop has paid out from cash the app was never told about, and the figure
 * says exactly that until somebody records what was in there.
 */
export function openingOfficeCash(branchId = null) {
  const existing = officeCashId(branchId);
  if (existing) return existing;

  const branch =
    branchId ?? db.prepare('SELECT id FROM branches WHERE is_main = 1').get()?.id ?? null;

  const info = db
    .prepare(
      `INSERT INTO cash_accounts (name, kind, note, branch_id)
       VALUES (?, 'safe', ?, ?)`,
    )
    .run(
      OFFICE_CASH_NAME,
      'The money bills and suppliers are paid from when the register is shut. ' +
        'Unlike a drawer it is not opened and counted per shift.',
      branch,
    );
  return info.lastInsertRowid;
}

/**
 * Where a drawer's takings go when it is closed, or null if they stay put.
 *
 * A shift ends with the notes counted, a float left for tomorrow and the rest
 * lifted out. That money does not stop existing — it goes into the safe, and
 * the shop's cash on hand is the same before and after. Recording only the
 * half where it left the drawer is how a day's takings could disappear between
 * one screen and the next.
 *
 * Null in the two cases where there is nowhere to move it to: the drawer *is*
 * the shop's standing account (the one-till shop, where lifting the money out
 * really is a bank drop), or the default is another drawer — and a drawer is a
 * shift somebody has to open and count, not a place to leave money overnight.
 */
export function sweepTargetFor(accountId) {
  const target = db.prepare('SELECT id, name, kind, active FROM cash_accounts WHERE is_default = 1').get();
  if (!target || !target.active) return null;
  if (target.id === accountId) return null;
  if (target.kind === 'drawer') return null;
  return target;
}

/** What a till holds right now: every movement it has ever had, added up. */
function balanceOfAccount(accountId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS usd, COALESCE(SUM(amount_lbp), 0) AS lbp
       FROM cash_movements WHERE account_id = ?`,
    )
    .get(accountId);
  return { usd: round2(row.usd), lbp: Math.round(row.lbp) };
}

export function currentSession(accountId = null, branchId = null) {
  const id = accountId ?? defaultAccountId(branchId);
  return db
    .prepare(
      `SELECT s.*, u.name AS opened_by_name, a.name AS account_name
       FROM cash_sessions s
       LEFT JOIN users u ON u.id = s.opened_by
       LEFT JOIN cash_accounts a ON a.id = s.account_id
       WHERE s.status = 'open' AND s.account_id = ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(id);
}

/**
 * The sitting on the register's drawer, if it is open.
 *
 * Said once here rather than as `currentSession(registerAccountId(branchId))`
 * at every counter, so that "is the register open" cannot come to mean two
 * different accounts on two different screens.
 */
export function registerSession(branchId = null) {
  return currentSession(registerAccountId(branchId));
}

export function sessionById(id) {
  return db
    .prepare(
      `SELECT s.*, u.name AS opened_by_name, c.name AS closed_by_name, a.name AS account_name
       FROM cash_sessions s
       LEFT JOIN users u ON u.id = s.opened_by
       LEFT JOIN users c ON c.id = s.closed_by
       LEFT JOIN cash_accounts a ON a.id = s.account_id
       WHERE s.id = ?`,
    )
    .get(id);
}

export function requiresSession() {
  return getSettings().require_cash_session !== 'false';
}

/**
 * Open the drawer.
 *
 * The float is the money already in it — yesterday's carried-over change, or
 * petty cash put in now. Recording it as a movement rather than only a column
 * means the drawer's contents is one sum from one place.
 */
export function openSession({
  userId,
  openingUsd = 0,
  openingLbp = 0,
  note = null,
  accountId = null,
  branchId = null,
}) {
  const account = accountId ?? defaultAccountId(branchId);
  if (currentSession(account)) throw new Error('That cashbox is already open');

  const usd = round2(Number(openingUsd) || 0);
  const lbp = Math.round(Number(openingLbp) || 0);
  if (usd < 0 || lbp < 0) throw new Error('An opening float cannot be negative');

  const { exchange_rate: rate } = getSettings();

  /*
   * What is in the till before anybody adds anything — last night's carried
   * float, most often. It is money the sitting has to account for even though
   * nobody is declaring it now, so it is written down at the start rather than
   * discovered as a mysterious surplus at the count.
   */
  const held = balanceOfAccount(account);

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO cash_sessions
           (account_id, opened_by, opening_usd, opening_lbp, opening_note, exchange_rate,
            opening_balance_usd, opening_balance_lbp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(account, userId, usd, lbp, note || null, rate, held.usd, held.lbp);

    if (usd > 0 || lbp > 0) {
      db.prepare(
        `INSERT INTO cash_movements (session_id, account_id, kind, amount_usd, amount_lbp, reason, note, user_id)
         VALUES (?, ?, 'opening_float', ?, ?, 'petty_cash', ?, ?)`,
      ).run(info.lastInsertRowid, account, usd, lbp, note || 'Opening float', userId);

      /*
       * And into the books, which it never was.
       *
       * A float is money that was not in the drawer and now is — the owner's,
       * put in to make change. Recording it in `cash_movements` and nowhere
       * else left the ledger short by the float from the moment a till was
       * first opened, and the Exchange differences screen correctly reported
       * the gap as unexplained because it could not have come from the rate.
       *
       * Carried-over cash is deliberately not posted: it is already in the
       * drawer and already in the books, and `opening_balance_*` above records
       * it without a movement precisely so it is not counted twice.
       */
      postCashMovement({
        direction: 'in',
        amountUsd: usd,
        amountLbp: lbp,
        reason: 'petty_cash',
        note: note || 'Opening float',
        tillAccountId: account,
        branchId,
        userId,
      });
    }

    return sessionById(info.lastInsertRowid);
  })();
}

/**
 * Record money moving in or out.
 *
 * Called by the register and the back office alike, so a supplier paid from the
 * till and a sale rung up land in the same place.
 *
 * **It used to return null when no sitting was open, and that lost money.**
 *
 * The reasoning written here was that a card sale should not fail because the
 * drawer is shut — but a card sale moves no cash and already returns at the
 * zero check above, so the only thing the silence ever caught was real money
 * with nowhere to go. A shop that made an account other than the counter
 * drawer its default found out the hard way: a purchase invoice settled in cash
 * wrote the supplier's ledger entry, wrote the voucher, and recorded no cash
 * movement at all, because nobody had "opened" the safe. The books said the
 * supplier was paid and the cash records said nothing left the shop.
 *
 * So there is no silent path out of here any more. Either the money is
 * recorded, or this throws and the caller's transaction takes the ledger entry
 * back with it.
 */
export function recordMovement({
  kind,
  amountUsd = 0,
  amountLbp = 0,
  reason = null,
  note = null,
  orderId = null,
  documentId = null,
  userId = null,
  sessionId = null,
  accountId = null,
  branchId = null,
}) {
  const usd = round2(Number(amountUsd) || 0);
  const lbp = Math.round(Number(amountLbp) || 0);
  if (usd === 0 && lbp === 0) return null;

  const account = accountId ?? defaultAccountId(branchId);
  let session = sessionId ? sessionById(sessionId) : currentSession(account);

  if (!session) {
    /*
     * No sitting on the account the money is moving through, and what to do
     * about that depends on what kind of place the money is being kept in.
     *
     * **A drawer is a shift.** It is opened with a float, counted at the end,
     * and the difference is somebody's to explain — so taking cash out of one
     * that nobody opened is a refusal, and every caller already makes it
     * earlier with a message naming what to open. Reaching here means one of
     * them forgot, so it throws rather than shrugs: the alternative is what
     * used to happen, a ledger saying paid and a drawer saying nothing moved.
     *
     * **A safe is not.** Nor is a bank account or an office float. Nobody
     * counts the safe at the end of a shift and nobody hands it over; it is a
     * standing balance, and there is nothing to "open" about it except a row in
     * this table. Requiring a sitting for one is a till ritual applied to
     * something that is not a till — which is exactly how a shop that made its
     * safe the default came to have purchase invoices that moved no money at
     * all. So a sitting is opened for it, empty, and the money goes in.
     */
    const kind = db.prepare('SELECT kind, name FROM cash_accounts WHERE id = ?').get(account);

    if (kind?.kind === 'drawer' && requiresSession()) {
      throw new Error(
        `${kind.name || 'That cashbox'} is closed — open it before money moves through it`,
      );
    }

    session = openSession({ userId, accountId: account, note: 'Opened by a payment' });
  }

  const info = db
    .prepare(
      `INSERT INTO cash_movements
         (session_id, account_id, kind, amount_usd, amount_lbp, reason, note, order_id, document_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(session.id, session.account_id ?? account, kind, usd, lbp, reason, note, orderId, documentId, userId);

  return info.lastInsertRowid;
}

export function movementsFor(sessionId) {
  return db
    .prepare(
      `SELECT m.*, u.name AS user_name, o.order_number, d.doc_number
       FROM cash_movements m
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN orders o ON o.id = m.order_id
       LEFT JOIN documents d ON d.id = m.document_id
       WHERE m.session_id = ? ORDER BY m.created_at, m.id`,
    )
    .all(sessionId);
}

/**
 * What should be in the drawer: what it already held when the sitting opened,
 * plus everything that has moved through it since.
 *
 * The first half used to be missing, and it was not zero. A drawer closed with
 * a float left in it for tomorrow's change opens holding that float, and a
 * sitting that counted only its own movements declared the float a surplus at
 * the count — every morning, for ever, and the same money again the next day.
 */
export function expectedIn(sessionId) {
  const session = db
    .prepare('SELECT opening_balance_usd, opening_balance_lbp FROM cash_sessions WHERE id = ?')
    .get(sessionId);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usd), 0) AS usd, COALESCE(SUM(amount_lbp), 0) AS lbp
       FROM cash_movements WHERE session_id = ?`,
    )
    .get(sessionId);
  return {
    usd: round2((session?.opening_balance_usd || 0) + row.usd),
    lbp: Math.round((session?.opening_balance_lbp || 0) + row.lbp),
  };
}

/**
 * Whether the drawer has been taken below zero.
 *
 * A fact rather than a figure, so it can be told to a cashier who counts blind
 * without handing them the number the count is supposed to produce. Money going
 * out that is not there is allowed — refusing it does not put the money back,
 * it only stops the shop writing down what happened — but it is never silent.
 */
export function drawerShort(sessionId) {
  const held = expectedIn(sessionId);
  return held.usd < 0 || held.lbp < 0;
}

/** Said the same way wherever the drawer has just gone below zero. */
export const SHORT_DRAWER_WARNING =
  'That is more than the drawer holds. It is recorded — the till is now showing less than ' +
  'nothing, so something earlier is missing.';

/**
 * Everything a shopkeeper wants to see about one sitting: what came in, what
 * went out, and — once closed — whether the drawer agreed.
 *
 * This is the Z-report every till produces at the end of a shift.
 */
export function sessionSummary(sessionId) {
  const session = sessionById(sessionId);
  if (!session) return null;

  const movements = movementsFor(sessionId);
  const expected = expectedIn(sessionId);

  const byKind = {};
  for (const m of movements) {
    const entry = (byKind[m.kind] ||= { kind: m.kind, count: 0, usd: 0, lbp: 0 });
    entry.count += 1;
    entry.usd = round2(entry.usd + m.amount_usd);
    entry.lbp += m.amount_lbp;
  }

  // Sales in the sitting, however they were paid — a shift report that only
  // counted cash would understate the day's takings.
  const sales = db
    .prepare(
      `SELECT payment_method, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE status = 'completed' AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))
       GROUP BY payment_method`,
    )
    .all(session.opened_at, session.closed_at);

  const refunds = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE status = 'refunded' AND created_at >= ? AND created_at <= COALESCE(?, datetime('now'))`,
    )
    .get(session.opened_at, session.closed_at);

  return {
    session,
    movements,
    expected,
    byKind: Object.values(byKind),
    sales: sales.map((s) => ({ ...s, total: round2(s.total) })),
    salesTotal: round2(sales.reduce((sum, s) => sum + s.total, 0)),
    refunds: { orders: refunds.orders, total: round2(refunds.total) },
  };
}

/**
 * Close the drawer against a physical count.
 *
 * The count is taken before the expected figure is shown — a blind count. Told
 * the answer first, a tired cashier will write it down whether the money is
 * there or not, and the one number the exercise exists to produce becomes
 * meaningless.
 *
 * Whatever is not carried forward as the next float has left for the bank, and
 * is recorded as such so the drawer starts the next sitting at the right figure.
 */
export function closeSession({
  sessionId,
  userId,
  countedUsd = 0,
  countedLbp = 0,
  carriedUsd = null,
  carriedLbp = null,
  note = null,
}) {
  const session = sessionById(sessionId);
  if (!session) throw new Error('That cashbox session does not exist');
  if (session.status === 'closed') throw new Error('That session is already closed');

  const counted = { usd: round2(Number(countedUsd) || 0), lbp: Math.round(Number(countedLbp) || 0) };
  if (counted.usd < 0 || counted.lbp < 0) throw new Error('A count cannot be negative');

  const expected = expectedIn(sessionId);
  const overShort = {
    usd: round2(counted.usd - expected.usd),
    lbp: Math.round(counted.lbp - expected.lbp),
  };

  // Default to leaving nothing behind; the shop decides what float to keep.
  const carried = {
    usd: round2(carriedUsd === null ? 0 : Number(carriedUsd) || 0),
    lbp: Math.round(carriedLbp === null ? 0 : Number(carriedLbp) || 0),
  };
  if (carried.usd > counted.usd || carried.lbp > counted.lbp) {
    throw new Error('You cannot carry forward more than was counted');
  }

  return transaction(() => {
    // A miscount is a real difference in the drawer, so it is recorded as a
    // movement too — otherwise the next session would start from a figure the
    // drawer never held.
    if (overShort.usd !== 0 || overShort.lbp !== 0) {
      recordMovement({
        sessionId,
        kind: 'correction',
        amountUsd: overShort.usd,
        amountLbp: overShort.lbp,
        reason: overShort.usd < 0 || overShort.lbp < 0 ? 'short' : 'over',
        note: 'Counted at close',
        userId,
      });

      // A drawer that came up short is money the shop no longer has, and the
      // books have to say so rather than carrying a figure the till never held.
      postCashMovement({
        direction: overShort.usd < 0 || overShort.lbp < 0 ? 'out' : 'in',
        amountUsd: overShort.usd,
        amountLbp: overShort.lbp,
        reason: overShort.usd < 0 || overShort.lbp < 0 ? 'short' : 'over',
        note: `Counted at close — ${session.account_name || 'the drawer'}`,
        tillAccountId: session.account_id,
        branchId: session.branch_id ?? null,
        userId,
      });
    }

    /*
     * What is lifted out of the drawer, and where it lands.
     *
     * Both halves, or neither. The drawer emptying and the safe filling are one
     * event — the shop's cash on hand does not change when the notes are
     * carried ten feet — and recording only the first half is how a day's
     * takings vanished between the register screen and the accounts screen.
     *
     * With nowhere to move it to (see `sweepTargetFor`) it is what it always
     * was: money out of the drawer and out of the shop's records, which for a
     * one-till shop taking its takings to the bank is the truth.
     */
    const banked = { usd: round2(counted.usd - carried.usd), lbp: counted.lbp - carried.lbp };
    if (banked.usd > 0 || banked.lbp > 0) {
      const target = sweepTargetFor(session.account_id);

      if (target) {
        recordMovement({
          sessionId,
          kind: 'sweep',
          amountUsd: -banked.usd,
          amountLbp: -banked.lbp,
          reason: 'sweep',
          note: `Moved to ${target.name} at close`,
          userId,
        });
        recordMovement({
          accountId: target.id,
          kind: 'sweep',
          amountUsd: banked.usd,
          amountLbp: banked.lbp,
          reason: 'sweep',
          note: `From ${session.account_name || 'the drawer'} at close`,
          userId,
        });

        // One entry for one event. Nothing is written when both tills sit on
        // the same ledger account, which by default they do.
        postTillTransfer({
          fromTillId: session.account_id,
          toTillId: target.id,
          amountUsd: banked.usd,
          amountLbp: banked.lbp,
          note: `Drawer swept to ${target.name} at close`,
          branchId: session.branch_id ?? null,
          userId,
        });
      } else {
        recordMovement({
          sessionId,
          kind: 'bank_drop',
          amountUsd: -banked.usd,
          amountLbp: -banked.lbp,
          reason: 'bank_drop',
          note: 'Taken out of the drawer at close',
          userId,
        });

        /*
         * Money out of the drawer with nowhere in the shop to put it — the
         * one-till shop carrying its takings to the bank. That is a real
         * movement between two things the shop owns, and leaving it unposted
         * meant the books went on holding cash the drawer had not had since
         * closing time.
         */
        postCashMovement({
          direction: 'out',
          amountUsd: banked.usd,
          amountLbp: banked.lbp,
          reason: 'bank_drop',
          note: 'Taken out of the drawer at close',
          tillAccountId: session.account_id,
          branchId: session.branch_id ?? null,
          userId,
        });
      }
    }

    db.prepare(
      `UPDATE cash_sessions SET status = 'closed', closed_by = ?, closed_at = datetime('now'),
         counted_usd = ?, counted_lbp = ?, expected_usd = ?, expected_lbp = ?,
         over_short_usd = ?, over_short_lbp = ?, carried_usd = ?, carried_lbp = ?, closing_note = ?
       WHERE id = ?`,
    ).run(
      userId,
      counted.usd,
      counted.lbp,
      expected.usd,
      expected.lbp,
      overShort.usd,
      overShort.lbp,
      carried.usd,
      carried.lbp,
      note || null,
      sessionId,
    );

    return sessionSummary(sessionId);
  })();
}

export function listSessions(limit = 50, accountId = null) {
  return db
    .prepare(
      `SELECT s.*, u.name AS opened_by_name, c.name AS closed_by_name, a.name AS account_name,
              (SELECT COUNT(*) FROM cash_movements m WHERE m.session_id = s.id) AS movement_count
       FROM cash_sessions s
       LEFT JOIN users u ON u.id = s.opened_by
       LEFT JOIN users c ON c.id = s.closed_by
       LEFT JOIN cash_accounts a ON a.id = s.account_id
       WHERE (? IS NULL OR s.account_id = ?)
       ORDER BY s.opened_at DESC, s.id DESC LIMIT ?`,
    )
    .all(accountId, accountId, Math.min(Number(limit) || 50, 200));
}

/** Total a count entered note by note, e.g. { "50000": 3, "10000": 2 }. */
export function totalDenominations(counts, currency) {
  const allowed = new Set(DENOMINATIONS[currency] || []);
  let total = 0;
  for (const [note, quantity] of Object.entries(counts || {})) {
    const value = Number(note);
    const n = Number(quantity) || 0;
    if (!allowed.has(value) || n < 0) continue;
    total += value * n;
  }
  return currency === 'LBP' ? roundLbp(total, 1) : round2(total);
}
