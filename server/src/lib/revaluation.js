/**
 * Restating the pounds at today's rate.
 *
 * Every LBP amount in this app is converted to dollars at the rate on the day
 * it happened and posted in dollars, which is correct: an entry records what
 * something was worth when it happened, and rewriting history every time the
 * rate moves would make last month's accounts disagree with last month's
 * accounts. But it leaves a shop holding a pile of pounds that the books value
 * at rates from every week it has traded, while the pile itself is worth
 * whatever it is worth this morning.
 *
 * The gap is real money. In a country where the rate has moved by a factor of
 * a thousand inside a decade, it is not a rounding curiosity — a drawer holding
 * fifty million pounds booked at 15,000 and worth 89,000 today is not off by
 * cents. Revaluation is the entry that says so.
 *
 * ## What it deliberately does not do
 *
 * It does not touch the entries that are already written. The original sale
 * stays at the rate it was rung up at, for ever. This adds one new entry, dated
 * today, moving the difference to Exchange differences — which is what the gap
 * *is*: not income the shop earned by selling anything, but a change in what
 * the money it was already holding is worth.
 *
 * It also does not guess. If the shop holds no pounds at all, a gap between the
 * books and the drawer is not an exchange difference and this refuses to call
 * it one.
 */
import { db } from '../db.js';
import { round2 } from './currency.js';
import { getSettings } from './settings.js';
import { signedBalance } from './ledger.js';
import { DEFAULT_MAP, accountFor } from './postings.js';

/** Where a revaluation difference belongs. */
export const FX_ROLE = 'fx';

/**
 * What each ledger account that holds the shop's own money is carrying, and
 * what is actually in the tills behind it.
 *
 * Grouped by ledger account rather than by till, because several tills map to
 * one account by default — the counter drawer, the safe and the transfer desk
 * are all "cash in hand" until a shop says otherwise. Comparing one drawer
 * against an account three drawers share would report a gap that is only the
 * other two.
 */
function holdings() {
  const rows = db
    .prepare(
      `SELECT c.gl_account_id AS gl_id, c.id AS till_id, c.name AS till_name, c.kind
       FROM cash_accounts c
       WHERE c.active = 1`,
    )
    .all();

  const balances = new Map(
    db
      .prepare(
        `SELECT account_id, COALESCE(SUM(amount_usd), 0) AS usd, COALESCE(SUM(amount_lbp), 0) AS lbp
         FROM cash_movements GROUP BY account_id`,
      )
      .all()
      .map((r) => [r.account_id, { usd: round2(r.usd), lbp: Math.round(r.lbp) }]),
  );

  const groups = new Map();
  for (const till of rows) {
    /* A till with no ledger account of its own still posts somewhere — the
       same default the postings use — so it has to be counted against that
       account rather than skipped, or its pounds go missing from the report
       while its dollars sit in the total it is being compared to. */
    const glId = till.gl_account_id
      || accountFor(till.kind === 'bank' ? 'bank' : 'cash');
    if (!glId) continue;

    const held = balances.get(till.till_id) ?? { usd: 0, lbp: 0 };
    const group = groups.get(glId) ?? { glId, tills: [], heldUsd: 0, heldLbp: 0 };
    group.tills.push(till.till_name);
    group.heldUsd = round2(group.heldUsd + held.usd);
    group.heldLbp = Math.round(group.heldLbp + held.lbp);
    groups.set(glId, group);
  }
  return [...groups.values()];
}

/** What the books say one account stands at, in its own direction. */
function bookBalance(glId) {
  const row = db
    .prepare(
      `SELECT a.type,
              COALESCE(SUM(l.debit_usd), 0) AS debit,
              COALESCE(SUM(l.credit_usd), 0) AS credit
       FROM gl_accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'posted'
       WHERE a.id = ?
       GROUP BY a.id`,
    )
    .get(glId);
  if (!row) return 0;
  return signedBalance(row.type, round2(row.debit), round2(row.credit));
}

/**
 * The revaluation as it stands right now.
 *
 * Shows its working rather than only its answer, because the answer is a
 * number a shopkeeper is being asked to put in their accounts and the only way
 * to check it is to see what it was made of.
 */
export function revaluation() {
  const settings = getSettings();
  const rate = Number(settings.exchange_rate) || 0;

  const lastChange = db
    .prepare('SELECT rate, created_at FROM exchange_rate_history ORDER BY id DESC LIMIT 1')
    .get() ?? null;

  const accounts = holdings()
    .map((group) => {
      const account = db
        .prepare('SELECT id, code, name FROM gl_accounts WHERE id = ?')
        .get(group.glId);
      if (!account) return null;

      const bookUsd = bookBalance(group.glId);

      /*
       * What the books are carrying the *pounds* at.
       *
       * The dollars in a till are on the books at face value — a dollar is a
       * dollar whatever the rate does — so whatever the account holds beyond
       * them is the pounds. Stating it this way rather than as one lump makes
       * the assumption visible and checkable, and it is the assumption the
       * whole figure rests on.
       */
      const bookedLbpUsd = round2(bookUsd - group.heldUsd);
      const worthTodayUsd = rate > 0 ? round2(group.heldLbp / rate) : 0;
      const difference = round2(worthTodayUsd - bookedLbpUsd);

      /* The rate the books are implicitly holding those pounds at. Shown so a
         shopkeeper can sanity-check the figure against a rate they recognise:
         if it comes out at 3,000 when the shop has never traded below 15,000,
         the gap is not a rate move and this says so rather than posting it. */
      const impliedRate = bookedLbpUsd !== 0 && group.heldLbp !== 0
        ? Math.round(group.heldLbp / bookedLbpUsd)
        : null;

      return {
        id: account.id,
        code: account.code,
        name: account.name,
        tills: group.tills,
        heldUsd: group.heldUsd,
        heldLbp: group.heldLbp,
        bookUsd,
        bookedLbpUsd,
        worthTodayUsd,
        difference,
        impliedRate,
        /* Nothing to revalue is not the same as nothing wrong. An account
           holding no pounds cannot have an exchange difference, so if its books
           and its till disagree that is something else and must not be swept
           into Exchange differences. */
        holdsPounds: group.heldLbp !== 0,
        unexplained: group.heldLbp === 0 ? round2(bookUsd - group.heldUsd) : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.code.localeCompare(b.code));

  const revaluable = accounts.filter((a) => a.holdsPounds);

  return {
    rate,
    lastChange,
    accounts,
    /** Only what the pounds explain. */
    total: revaluable.reduce((sum, a) => round2(sum + a.difference), 0),
    /** What they do not, which is a different conversation. */
    unexplained: accounts.reduce((sum, a) => round2(sum + a.unexplained), 0),
    fxAccount: DEFAULT_MAP[FX_ROLE],
  };
}

/**
 * The lines that would restate it, or null when there is nothing to restate.
 *
 * Built only from accounts that actually hold pounds. An account whose books
 * and till disagree while holding none is reported and left alone: posting it
 * here would file a bookkeeping error under "the rate moved", which is the one
 * place nobody would ever look for it.
 */
export function revaluationLines() {
  const report = revaluation();
  if (!(report.rate > 0)) return null;

  const moved = report.accounts.filter((a) => a.holdsPounds && a.difference !== 0);
  if (moved.length === 0) return null;

  const fx = accountFor(FX_ROLE);
  const lines = moved.map((a) => ({
    accountId: a.id,
    debit: a.difference > 0 ? a.difference : 0,
    credit: a.difference < 0 ? Math.abs(a.difference) : 0,
    memo: `${a.name} restated at ${report.rate.toLocaleString('en-US')}`,
  }));

  // The other side, in one line: the whole point is what the rate did to the
  // shop, not what it did to each drawer.
  const total = round2(moved.reduce((sum, a) => round2(sum + a.difference), 0));
  if (total !== 0) {
    lines.push({
      accountId: fx,
      debit: total < 0 ? Math.abs(total) : 0,
      credit: total > 0 ? total : 0,
      memo: total > 0 ? 'Gain on holding pounds' : 'Loss on holding pounds',
    });
  }

  return { lines, total, rate: report.rate, accounts: moved };
}
