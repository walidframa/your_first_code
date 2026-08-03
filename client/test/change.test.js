import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedUsd, splitStatus, suggestSplit } from '../src/lib/change.js';

const RATE = 89000;
const base = { rate: RATE, step: 1000 };
const untouched = { usdTouched: false, lbpTouched: false };

test('adds the two currencies up', () => {
  assert.equal(combinedUsd(5, 445000, RATE), 10);
  assert.equal(combinedUsd(0, 890000, RATE), 10);
  assert.equal(combinedUsd(5, 445000, 0), 5, 'with no rate the pounds cannot be valued');
});

test('two piles that come to the change read as exact', () => {
  const s = splitStatus({ changeDue: 10, usd: 5, lbp: 445000, ...base });
  assert.equal(s.exact, true);
  assert.equal(s.left, 0);
  assert.equal(s.over, false);
});

test('the rest of the change rounded up to a note still reads as exact', () => {
  /*
   * The bug this guards: $6.50 of change with $3 in notes leaves $3.50, which
   * is 311,500 LL. A drawer holding 1,000 LL notes pays 312,000 — and the sheet
   * used to fill that figure itself and then flag it as a cent over.
   */
  const s = splitStatus({ changeDue: 6.5, usd: 3, lbp: 312000, ...base });
  assert.equal(s.exact, true, '312,000 LL is the nearest note to 311,500');
  assert.equal(s.over, false);
});

test('a real shortfall is still a shortfall', () => {
  const s = splitStatus({ changeDue: 6.5, usd: 3, lbp: 0, ...base });
  assert.equal(s.exact, false);
  assert.ok(s.left > 3.4 && s.left < 3.6, `left ${s.left} is the missing 3.50`);
  assert.equal(s.over, false);
});

test('more than a rounding step over is a slipped digit', () => {
  const slipped = splitStatus({ changeDue: 6.5, usd: 3, lbp: 31200000, ...base });
  assert.equal(slipped.over, true);
  assert.ok(slipped.left < 0, 'and it reads as over, not short');

  // One whole note over is the cashier rounding, not a mistake to block.
  const rounded = splitStatus({ changeDue: 6.5, usd: 3, lbp: 313000, ...base });
  assert.equal(rounded.over, false);
});

test('neither pile counts as negative', () => {
  const s = splitStatus({ changeDue: 10, usd: -5, lbp: -100000, ...base });
  assert.equal(s.usd, 0);
  assert.equal(s.lbp, 0);
  assert.equal(s.total, 0);
});

/* ------------------------------------------------ suggesting the other pile */

test('the pounds follow the dollars the cashier names', () => {
  // The counter case: $20.87 sale, $50 handed over, $29.13 change, "here's $25".
  const s = suggestSplit({ changeDue: 29.13, usd: 25, lbp: '', ...untouched, usdTouched: true, ...base });
  assert.equal(s.usd, 25);
  assert.equal(s.lbp, 368000, '$4.13 at 89,000 = 367,570 → 368,000');
  assert.equal(s.suggested, 'lbp');
  assert.equal(splitStatus({ changeDue: 29.13, usd: s.usd, lbp: s.lbp, ...base }).exact, true);
});

test('the suggestion follows every keystroke, not just the last', () => {
  // Typing 2, then 5 — the pounds shrink as the dollars grow.
  const two = suggestSplit({ changeDue: 29.13, usd: 2, lbp: '', usdTouched: true, lbpTouched: false, ...base });
  const twentyFive = suggestSplit({ changeDue: 29.13, usd: 25, lbp: '', usdTouched: true, lbpTouched: false, ...base });
  assert.ok(two.lbp > twentyFive.lbp, `${two.lbp} should exceed ${twentyFive.lbp}`);
});

test('with nothing typed the whole change is suggested in pounds', () => {
  const s = suggestSplit({ changeDue: 29.13, usd: '', lbp: '', ...untouched, ...base });
  assert.equal(s.usd, 0);
  assert.equal(s.lbp, 2593000, '29.13 at 89,000 = 2,592,570 → 2,593,000');
});

test('naming the pounds instead makes the dollars follow', () => {
  // A drawer with 2,000,000 LL in notes pays those; the dollars cover the rest.
  const s = suggestSplit({ changeDue: 29.13, usd: '', lbp: 2000000, usdTouched: false, lbpTouched: true, ...base });
  assert.equal(s.lbp, 2000000);
  assert.equal(s.usd, 6.66, '29.13 less 2,000,000 LL (22.47) = 6.66');
  assert.equal(s.suggested, 'usd');
});

test('once both are typed neither is overwritten', () => {
  const s = suggestSplit({ changeDue: 29.13, usd: 25, lbp: 350000, usdTouched: true, lbpTouched: true, ...base });
  assert.equal(s.usd, 25);
  assert.equal(s.lbp, 350000);
  assert.equal(s.suggested, null);
  assert.equal(splitStatus({ changeDue: 29.13, usd: 25, lbp: 350000, ...base }).exact, false);
});

test('more dollars than the change leaves nothing to suggest in pounds', () => {
  const s = suggestSplit({ changeDue: 29.13, usd: 50, lbp: '', usdTouched: true, lbpTouched: false, ...base });
  assert.equal(s.usd, 50, 'not quietly corrected down to the change');
  assert.equal(s.lbp, 0);
  assert.equal(splitStatus({ changeDue: 29.13, usd: 50, lbp: 0, ...base }).over, true);
});
