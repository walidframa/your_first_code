import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedUsd, splitStatus } from '../src/lib/change.js';

const RATE = 89000;
const base = { rate: RATE, step: 1000 };

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
