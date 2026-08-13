/**
 * What the shop makes on a quotation, worked out while it is still being
 * written.
 *
 * The moment to know whether a quotation is worth sending is before it is
 * sent: a discount agreed on the phone can quietly take a line below what the
 * phone cost, and finding that out at the end of the month is finding it out
 * too late.
 *
 * The arithmetic is small and the consequences are not, so it is pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* The calculation exactly as `Documents.jsx` performs it. */
function summarise(lines, discountPercent = 0, taxRate = 0) {
  const priced = lines.map((l) => ({ ...l, lineTotal: (l.quantity || 0) * (l.price || 0) }));
  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);
  const discount = subtotal * ((discountPercent || 0) / 100);
  const tax = (subtotal - discount) * taxRate;
  const total = subtotal - discount + tax;

  const costOf = (l) => (l.quantity || 0) * (Number(l.product?.cost ?? l.cost ?? 0) || 0);
  const totalCost = priced.reduce((sum, l) => sum + costOf(l), 0);
  const revenue = subtotal - discount;
  const profit = revenue - totalCost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const linesWithoutCost = priced.filter(
    (l) => l.lineTotal > 0 && !(Number(l.product?.cost ?? l.cost ?? 0) > 0),
  ).length;

  return { subtotal, discount, tax, total, totalCost, profit, margin, linesWithoutCost };
}

const line = (price, cost, quantity = 1) => ({ price, quantity, product: { cost } });

test('an ordinary sale shows what is made on it', () => {
  // One iPhone bought at 690, sold at 799.
  const s = summarise([line(799, 690)]);
  assert.equal(s.totalCost, 690);
  assert.equal(s.profit, 109);
  assert.equal(Number(s.margin.toFixed(2)), 13.64);
});

test('a discount comes out of the profit, not out of the cost', () => {
  // 10% off an 800 phone that cost 690 leaves 30, not 110.
  const s = summarise([line(800, 690)], 10);
  assert.equal(s.discount, 80);
  assert.equal(s.profit, 30);
});

test('a discount deep enough to lose money says so', () => {
  /*
   * The case this whole panel exists for. Agreed on the phone, typed in, and
   * without this it looks exactly like every other quotation.
   */
  const s = summarise([line(800, 690)], 20);
  assert.ok(s.profit < 0, `profit was ${s.profit}`);
  assert.equal(Number(s.profit.toFixed(2)), -50);
});

test('tax is nobody profit — it is left out of both halves', () => {
  // The government's, never the shop's. Counting it as revenue would flatter
  // every figure on the panel.
  const without = summarise([line(100, 60)], 0, 0);
  const with8 = summarise([line(100, 60)], 0, 0.08);
  assert.equal(with8.total, 108, 'the customer still pays the tax');
  assert.equal(with8.profit, without.profit, 'but the shop does not make it');
  assert.equal(with8.margin, without.margin);
});

test('quantity multiplies both sides', () => {
  const s = summarise([line(799, 690, 3)]);
  assert.equal(s.totalCost, 2070);
  assert.equal(s.profit, 327);
});

test('several lines add up', () => {
  const s = summarise([line(799, 690), line(12, 4, 2), line(29, 21)]);
  assert.equal(s.subtotal, 799 + 24 + 29);
  assert.equal(s.totalCost, 690 + 8 + 21);
  assert.equal(s.profit, 133);
});

test('a line with no cost is counted as unknown, not as free money', () => {
  /*
   * Treating a missing cost as zero shows the full price as profit, which is
   * the one wrong answer that looks like good news — so the panel says how
   * many lines it could not account for.
   */
  const s = summarise([line(799, 690), { price: 50, quantity: 1, product: {} }]);
  assert.equal(s.linesWithoutCost, 1);
  assert.equal(s.totalCost, 690, 'the unknown line contributed no cost');
});

test('an empty document has no margin rather than a division by zero', () => {
  const s = summarise([]);
  assert.equal(s.margin, 0);
  assert.equal(s.profit, 0);
  assert.ok(Number.isFinite(s.margin));
});

test('a document discounted to nothing does not produce infinity', () => {
  const s = summarise([line(100, 60)], 100);
  assert.equal(s.margin, 0, 'revenue is zero, so there is no percentage to show');
  assert.ok(Number.isFinite(s.margin));
});
