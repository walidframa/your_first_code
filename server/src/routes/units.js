import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  UNIT_CONDITIONS,
  UNIT_STATUSES,
  findByImei,
  isAvailable,
  normaliseImei,
  receiveUnits,
  syncStockFromUnits,
  unitsFor,
} from '../lib/units.js';

const router = Router();

router.get('/meta', requireAuth, (req, res) => {
  res.json({ conditions: UNIT_CONDITIONS, statuses: UNIT_STATUSES });
});

/**
 * Counter lookup by IMEI.
 *
 * Someone walks in with a phone and a complaint. This answers "did we sell it,
 * when, and to whom" from the number on the box, which is the only thing they
 * reliably have. Any signed-in user can ask — refusing a cashier the ability to
 * check a warranty would defeat the point.
 */
router.get('/lookup', requireAuth, (req, res) => {
  const imei = normaliseImei(req.query.imei);
  if (!imei) return res.status(400).json({ error: 'Give an IMEI or serial number to look up' });

  const unit = findByImei(imei);
  if (!unit) return res.status(404).json({ error: `Nothing in the shop's records for ${imei}` });

  res.json({ unit, available: isAvailable(unit.status) });
});

/** Every unit of a product, for the stock list and the sale picker. */
router.get('/product/:productId', requireAuth, (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { status } = req.query;
  if (status && !UNIT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${UNIT_STATUSES.join(', ')}` });
  }

  const units = unitsFor(product.id, status || null);
  res.json({
    product,
    units,
    available: units.filter((u) => isAvailable(u.status)).length,
  });
});

/** Book handsets in against a product. */
router.post('/product/:productId', requireAuth, requireRole('admin'), (req, res) => {
  const { units, documentId = null } = req.body || {};
  try {
    const result = transaction(() => receiveUnits(req.params.productId, units, { documentId }))();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Correct a unit's condition, cost or note. */
router.patch('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const unit = db.prepare('SELECT * FROM product_units WHERE id = ?').get(req.params.id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const { condition = unit.condition, cost = unit.cost, note = unit.note, status = unit.status } = req.body || {};

  if (!UNIT_CONDITIONS.includes(condition)) {
    return res.status(400).json({ error: `condition must be one of: ${UNIT_CONDITIONS.join(', ')}` });
  }
  if (!UNIT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${UNIT_STATUSES.join(', ')}` });
  }
  if (Number(cost) < 0) return res.status(400).json({ error: 'A unit cannot cost less than nothing' });

  /*
   * Selling is what a sale does, not what an edit does. Letting this endpoint
   * write 'sold' would mark a handset gone with no order behind it, and the
   * next stock count would be wrong with nothing to explain it.
   */
  if (status === 'sold' && unit.status !== 'sold') {
    return res.status(400).json({ error: 'A unit is marked sold by selling it, not by editing it' });
  }
  if (unit.status === 'sold' && status !== 'sold') {
    return res.status(400).json({ error: 'Refund the order to bring this unit back' });
  }

  try {
    transaction(() => {
      db.prepare(
        'UPDATE product_units SET condition = ?, cost = ?, note = ?, status = ? WHERE id = ?',
      ).run(condition, Number(cost) || 0, note || null, status, unit.id);
      syncStockFromUnits(unit.product_id);
    })();
    res.json({ unit: db.prepare('SELECT * FROM product_units WHERE id = ?').get(unit.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Remove a unit booked in by mistake.
 *
 * Only one that never left: a sold handset is part of a sale's history, and
 * deleting it would leave the order pointing at nothing.
 */
router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const unit = db.prepare('SELECT * FROM product_units WHERE id = ?').get(req.params.id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  if (unit.sold_order_id || unit.status === 'sold') {
    return res.status(400).json({ error: 'This unit has been sold — refund the order instead' });
  }

  transaction(() => {
    db.prepare('DELETE FROM product_units WHERE id = ?').run(unit.id);
    syncStockFromUnits(unit.product_id);
  })();
  res.json({ ok: true });
});

export default router;
