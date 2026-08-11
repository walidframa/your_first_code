import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { getSettings } from '../lib/settings.js';
import { getIdPhoto, removeIdPhoto, setIdPhoto } from '../lib/idPhotos.js';
import { listSims, receiveSims, simByNumber, simProducts } from '../lib/sims.js';

const router = Router();

/**
 * What the shop stocks as SIMs, and how many of each are left.
 *
 * Open to anyone signed in because the register needs it: selling a line is
 * counter work, and the picker has to know what there is.
 */
router.get('/products', requireAuth, (req, res) => {
  res.json({ products: simProducts({ activeOnly: req.query.all !== 'true' }) });
});

router.get('/', requireAuth, (req, res) => {
  res.json({
    sims: listSims({
      status: req.query.status || null,
      search: req.query.search || null,
      // Scoped to the branch unless asked otherwise: a SIM on the other shop's
      // shelf is not one this register can sell.
      branchId: req.query.all === 'true' ? null : req.branchId,
      limit: Number(req.query.limit) || 300,
    }),
  });
});

/**
 * One SIM by its number.
 *
 * A 404 here is an ordinary answer — the number is typed at the counter and
 * getting it wrong is the common case — so it carries a message the cashier can
 * act on rather than a bare status.
 */
router.get('/by-number/:msisdn', requireAuth, (req, res) => {
  const { phone_country_code: cc } = getSettings();
  let sim;
  try {
    sim = simByNumber(req.params.msisdn, cc);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!sim) return res.status(404).json({ error: 'No SIM on file with that number' });
  res.json({ sim });
});

/** Take a delivery in. Stock, so it needs the inventory permission. */
router.post('/receive', requireAuth, requirePermission('inventory'), (req, res) => {
  const { productId, sims, cost, documentId } = req.body || {};
  const { phone_country_code: cc } = getSettings();

  try {
    const result = receiveSims({
      productId: Number(productId),
      sims,
      cost,
      documentId: documentId || null,
      branchId: req.branchId,
      countryCode: cc,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* -------------------------------------------------------- the buyer's ID */

/**
 * The ID photographed when the line was sold, keyed on the order line.
 *
 * The line rather than the SIM, because it is evidence about a sale: if the
 * card comes back and goes out again to somebody else, the second sale has its
 * own buyer and its own photograph, and neither overwrites the other.
 *
 * Same permission split as a trade-in: taking one is counter work, reading one
 * back needs `secrets`.
 */
function orderItemOf(id) {
  return db
    .prepare(
      `SELECT oi.id, oi.name, o.order_number, u.msisdn
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN product_units u ON u.id = oi.unit_id
       WHERE oi.id = ?`,
    )
    .get(id);
}

router.post('/sales/:itemId/id-photo', requireAuth, requirePermission('register'), (req, res) => {
  const line = orderItemOf(req.params.itemId);
  if (!line) return res.status(404).json({ error: 'That sale line does not exist' });

  try {
    const saved = setIdPhoto('sim_sale', line.id, req.body?.idPhoto, req.user.id);
    res.status(201).json({ ...saved, orderItemId: line.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/sales/:itemId/id-photo', requireAuth, requirePermission('secrets'), (req, res) => {
  const photo = getIdPhoto('sim_sale', req.params.itemId);
  if (!photo) return res.status(404).json({ error: 'No ID on file for that sale' });

  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Content-Length', photo.byteSize);
  // Somebody's identity document has no business in a shared cache.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(photo.bytes);
});

router.delete('/sales/:itemId/id-photo', requireAuth, requirePermission('secrets'), (req, res) => {
  if (!removeIdPhoto('sim_sale', req.params.itemId)) {
    return res.status(404).json({ error: 'No ID on file for that sale' });
  }
  res.json({ removed: true });
});

export default router;
