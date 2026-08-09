/**
 * Counting a till against the app.
 *
 * The thread: each currency is right or wrong on its own, and the two only
 * become one number through the rate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countDifference } from '../src/lib/cashCount.js';

const RATE = 89000;

test('a drawer that matches reads as zero in both currencies and together', () => {
  const diff = countDifference({
    expected: { usd: 250, lbp: 5000000 },
    counted: { usd: 250, lbp: 5000000 },
    rate: RATE,
  });

  assert.equal(diff.usd, 0);
  assert.equal(diff.lbp, 0);
  assert.equal(diff.combined, 0);
});

test('the combined figure converts the pounds and adds them to the dollars', () => {
  const diff = countDifference({
    expected: { usd: 2996.07, lbp: 0 },
    counted: { usd: 3000, lbp: 3000000 },
    rate: RATE,
  });

  assert.equal(diff.usd, 3.93, 'the dollars on their own');
  assert.equal(diff.lbp, 3000000, 'the pounds on their own');

  // $3.93 plus 3,000,000 LL at 89,000 — about $33.71 — is $37.64.
  assert.equal(diff.combined, 37.64);
  assert.equal(diff.countedCombined, 3033.71);
});

test('a shortfall in one currency can be covered by the other', () => {
  const diff = countDifference({
    expected: { usd: 100, lbp: 0 },
    counted: { usd: 60, lbp: 3560000 },
    rate: RATE,
  });

  assert.equal(diff.usd, -40, 'forty dollars short');
  assert.equal(diff.lbp, 3560000);
  // 3,560,000 at 89,000 is exactly $40, so the till is whole.
  assert.equal(diff.combined, 0, 'somebody changed dollars into pounds, and nothing is missing');
});

test('being short reads as a negative, in each currency and together', () => {
  const diff = countDifference({
    expected: { usd: 500, lbp: 2000000 },
    counted: { usd: 480, lbp: 1000000 },
    rate: RATE,
  });

  assert.equal(diff.usd, -20);
  assert.equal(diff.lbp, -1000000);
  assert.ok(diff.combined < 0);
  assert.equal(diff.combined, -31.24);
});

test('without a rate the piles cannot be added, and say so rather than reading zero', () => {
  const diff = countDifference({
    expected: { usd: 100, lbp: 500000 },
    counted: { usd: 100, lbp: 0 },
    rate: 0,
  });

  assert.equal(diff.usd, 0);
  assert.equal(diff.lbp, -500000, 'the pounds are still counted');
  assert.equal(diff.combined, null, 'a zero here would read as "the drawer agrees"');
});

test('cents do not drift', () => {
  const diff = countDifference({
    expected: { usd: 20.1, lbp: 0 },
    counted: { usd: 20.1, lbp: 0 },
    rate: RATE,
  });
  assert.equal(diff.usd, 0, 'not three ten-thousandths over');
});

test('no expected figure means no comparison — a cashier counts blind', () => {
  assert.equal(countDifference({ expected: null, counted: { usd: 10 }, rate: RATE }), null);
});
