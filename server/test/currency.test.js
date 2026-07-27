import test from 'node:test';
import assert from 'node:assert/strict';
import {
  round2,
  roundLbp,
  usdToLbp,
  lbpToUsd,
  tenderTotals,
  changeBreakdown,
  validatePayments,
} from '../src/lib/currency.js';

const RATE = 89000;

test('rounds USD to cents', () => {
  assert.equal(round2(10.256), 10.26);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(7), 7);
});

test('rounds LBP to the configured step', () => {
  assert.equal(roundLbp(913140, 1000), 913000);
  assert.equal(roundLbp(913600, 1000), 914000);
  assert.equal(roundLbp(912500, 5000), 915000);
  assert.equal(roundLbp(913140, 1), 913140, 'step of 1 keeps the exact figure');
});

test('converts USD to LBP at the rate', () => {
  assert.equal(usdToLbp(10, RATE, 1000), 890000);
  assert.equal(usdToLbp(10.26, RATE, 1000), 913000);
  assert.equal(usdToLbp(0, RATE, 1000), 0);
});

test('converts LBP back to USD', () => {
  assert.equal(lbpToUsd(890000, RATE), 10);
  assert.equal(lbpToUsd(0, RATE), 0);
});

test('a zero or missing rate cannot produce Infinity', () => {
  assert.equal(lbpToUsd(890000, 0), 0);
  assert.equal(lbpToUsd(890000, undefined), 0);
});

test('totals a single USD tender', () => {
  const t = tenderTotals([{ currency: 'USD', amount: 20 }], RATE);
  assert.equal(t.paidUsd, 20);
  assert.equal(t.paidLbp, 0);
  assert.equal(t.totalUsdEquivalent, 20);
});

test('totals a single LBP tender', () => {
  const t = tenderTotals([{ currency: 'LBP', amount: 890000 }], RATE);
  assert.equal(t.paidUsd, 0);
  assert.equal(t.paidLbp, 890000);
  assert.equal(t.totalUsdEquivalent, 10);
});

test('totals a split USD + LBP tender', () => {
  const t = tenderTotals(
    [
      { currency: 'USD', amount: 5 },
      { currency: 'LBP', amount: 445000 },
    ],
    RATE,
  );
  assert.equal(t.paidUsd, 5);
  assert.equal(t.paidLbp, 445000);
  assert.equal(t.totalUsdEquivalent, 10, '5 USD + 445,000 LBP = 10 USD at 89,000');
});

test('combines multiple legs of the same currency', () => {
  const t = tenderTotals(
    [
      { currency: 'LBP', amount: 100000 },
      { currency: 'LBP', amount: 345000 },
      { currency: 'USD', amount: 2 },
      { currency: 'USD', amount: 3 },
    ],
    RATE,
  );
  assert.equal(t.paidUsd, 5);
  assert.equal(t.paidLbp, 445000);
  assert.equal(t.totalUsdEquivalent, 10);
});

test('gives change in LBP rounded to the step', () => {
  const c = changeBreakdown(0.976, 'LBP', RATE, 1000);
  assert.equal(c.changeUsd, 0);
  assert.equal(c.changeLbp, 87000, '0.976 USD ≈ 86,864 LBP → 87,000');
});

test('gives change in USD to the cent', () => {
  const c = changeBreakdown(0.976, 'USD', RATE, 1000);
  assert.equal(c.changeUsd, 0.98);
  assert.equal(c.changeLbp, 0);
});

test('never returns negative change', () => {
  const c = changeBreakdown(-5, 'LBP', RATE, 1000);
  assert.equal(c.changeLbp, 0);
  assert.equal(c.changeUsd, 0);
});

test('rejects malformed tender', () => {
  assert.match(validatePayments([]), /at least one payment/i);
  assert.match(validatePayments(null), /at least one payment/i);
  assert.match(validatePayments([{ currency: 'EUR', amount: 5 }]), /currency must be/i);
  assert.match(validatePayments([{ currency: 'USD', amount: -1 }]), /non-negative/i);
  assert.match(validatePayments([{ currency: 'USD', amount: 'abc' }]), /non-negative/i);
  assert.match(validatePayments([{ currency: 'USD', amount: 0 }]), /greater than zero/i);
});

test('accepts a well-formed split tender', () => {
  assert.equal(
    validatePayments([
      { currency: 'USD', amount: 5 },
      { currency: 'LBP', amount: 445000 },
    ]),
    null,
  );
});

test('a zero leg alongside a real one is fine', () => {
  assert.equal(
    validatePayments([
      { currency: 'USD', amount: 0 },
      { currency: 'LBP', amount: 445000 },
    ]),
    null,
  );
});
