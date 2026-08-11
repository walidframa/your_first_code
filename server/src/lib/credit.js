/**
 * Sending calling credit — the "$" a Lebanese shop tops customers up with.
 *
 * The shop holds a balance with each carrier and sends credit to a customer's
 * number by SMS. The carrier only accepts fixed amounts per message — 3, 2 or
 * 1 — so ten dollars is not one send but four: three threes and a one. **Every
 * message costs the shop 0.15 out of its balance on top of the credit itself**,
 * so what leaves the balance for a $10 top-up is $10.60, and a shop that prices
 * against the $10 is losing sixty cents a time without seeing it.
 *
 * That is the whole reason this is code rather than mental arithmetic at the
 * counter. The split is easy to do in your head and easy to do wrong when
 * somebody is waiting, and the fee is invisible until the balance runs out
 * earlier than it should have.
 */
import { round2 } from './currency.js';

/**
 * What one message can carry, biggest first.
 *
 * Greedy from the largest is also the fewest messages here: with 1 available,
 * every remainder can be finished off, and taking the largest first can never
 * cost more sends than another split. Fewest messages is the goal because each
 * one is a fee.
 */
export const DENOMINATIONS = [3, 2, 1];

/** What a message costs the shop, before the shop says otherwise. */
export const DEFAULT_SMS_FEE = 0.15;

/** The most that can go out in one go, so a slipped digit is not a disaster. */
export const MAX_CREDIT = 500;

/**
 * Break an amount into the messages that have to be sent.
 *
 * Returns them largest first, which is also the order they get sent in — a
 * ten becomes [3, 3, 3, 1].
 */
export function planFor(amount) {
  const total = Number(amount);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Say how much credit to send');
  }
  if (!Number.isInteger(total)) {
    // The carrier takes whole dollars per message and nothing smaller, so a
    // half-dollar cannot be sent at all — better said here than discovered
    // after the money is taken.
    throw new Error('Credit goes out in whole dollars — 3, 2 or 1 at a time');
  }
  if (total > MAX_CREDIT) {
    throw new Error(`That is more than $${MAX_CREDIT} in one go — send it in two if it is right`);
  }

  const messages = [];
  let left = total;
  for (const size of DENOMINATIONS) {
    while (left >= size) {
      messages.push(size);
      left -= size;
    }
  }
  return messages;
}

/**
 * What a top-up costs the shop's balance: the credit, plus a fee per message.
 *
 * `feePerSms` comes from the carrier rather than being fixed here — it is the
 * carrier's charge, and a shop whose deal changes should not need a new
 * version of the app to say so.
 */
export function quote(amount, feePerSms = DEFAULT_SMS_FEE) {
  const messages = planFor(amount);
  const fee = Number(feePerSms) || 0;
  if (fee < 0) throw new Error('A message fee cannot be negative');

  const credit = round2(messages.reduce((sum, n) => sum + n, 0));
  const fees = round2(messages.length * fee);

  return {
    amount: credit,
    messages,
    // How many of each, which is what actually gets typed out at the counter:
    // "three threes and a one".
    breakdown: DENOMINATIONS.map((size) => ({
      size,
      count: messages.filter((m) => m === size).length,
    })).filter((b) => b.count > 0),
    smsCount: messages.length,
    feeEach: round2(fee),
    fees,
    // What actually leaves the balance. The figure the shop should be pricing
    // against, and the one nobody works out by hand.
    cost: round2(credit + fees),
  };
}

/** "3 × $3 + 1 × $1" — the sends, as a line on a receipt or a cart row. */
export function describe(quoted) {
  return quoted.breakdown.map((b) => `${b.count} × $${b.size}`).join(' + ');
}
