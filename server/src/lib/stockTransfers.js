/**
 * Stock moving from one shop to the other.
 *
 * The thing this is not: a purchase. Nothing is bought, nothing is sold, no
 * money moves and no product is created — the same product simply sits on a
 * different shelf. That is the whole point of one catalogue across branches: a
 * phone sent to the second shop is the same phone, at the same price, with the
 * same barcodes and the same cost behind its margin.
 *
 * Sending and receiving are two steps, deliberately. Between them the goods are
 * in somebody's car: they have left one branch and not yet arrived at the
 * other, and the app says exactly that. Moving the stock in one step would mean
 * either counting it at both ends for a while — where it can be sold twice — or
 * at neither, where it looks lost. A box in transit is a real state and it is
 * worth having a word for it.
 */
import { db, transaction } from '../db.js';
import { mainBranchId, moveStock, stockAt } from './stock.js';
import { AVAILABLE_STATUSES, isAvailable, syncStockFromUnits } from './units.js';

export const TRANSFER_STATUSES = ['draft', 'sent', 'received', 'cancelled'];

const nextReference = () => {
  const { last } = db.prepare('SELECT COALESCE(MAX(id), 0) AS last FROM stock_transfers').get();
  return `TR-${String(last + 1).padStart(4, '0')}`;
};

function itemsOf(transferId) {
  return db
    .prepare(
      `SELECT i.*, p.name, p.sku, p.tracks_units, u.imei
       FROM stock_transfer_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN product_units u ON u.id = i.unit_id
       WHERE i.transfer_id = ? ORDER BY i.id`,
    )
    .all(transferId);
}

export function transferById(id) {
  const transfer = db
    .prepare(
      `SELECT t.*, f.name AS from_branch_name, d.name AS to_branch_name,
              c.name AS created_by_name, s.name AS sent_by_name, r.name AS received_by_name
       FROM stock_transfers t
       JOIN branches f ON f.id = t.from_branch_id
       JOIN branches d ON d.id = t.to_branch_id
       LEFT JOIN users c ON c.id = t.created_by
       LEFT JOIN users s ON s.id = t.sent_by
       LEFT JOIN users r ON r.id = t.received_by
       WHERE t.id = ?`,
    )
    .get(id);

  return transfer ? { ...transfer, items: itemsOf(id) } : null;
}

/**
 * Transfers this branch is involved in.
 *
 * Both directions on purpose: what is coming *to* you is the more urgent half —
 * a box waiting to be received is stock the shop cannot sell yet.
 */
export function listTransfers({ branchId = null, status = null, limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT t.*, f.name AS from_branch_name, d.name AS to_branch_name,
              c.name AS created_by_name,
              (SELECT COALESCE(SUM(i.quantity), 0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS item_count
       FROM stock_transfers t
       JOIN branches f ON f.id = t.from_branch_id
       JOIN branches d ON d.id = t.to_branch_id
       LEFT JOIN users c ON c.id = t.created_by
       WHERE (? IS NULL OR t.from_branch_id = ? OR t.to_branch_id = ?)
         AND (? IS NULL OR t.status = ?)
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ?`,
    )
    .all(branchId, branchId, branchId, status, status, Math.min(Number(limit) || 50, 200));
}

/**
 * Start a transfer and send it in one go.
 *
 * The stock leaves the source branch now — the box is going in the car, and a
 * shelf that still counts what has physically left is a shelf that will oversell.
 */
/**
 * Every last thing standing on one branch's shelf, as transfer lines.
 *
 * For the mistake that has to be undone rather than corrected item by item:
 * a delivery booked in — or a catalogue imported — while standing at the wrong
 * counter. Ninety-seven products and five hundred handsets cannot be searched
 * for and added one at a time, and a shop told to do that will instead leave
 * the stock where it wrongly is.
 *
 * Handsets are listed one line per phone because that is what a serialised
 * product's stock *is*, and what `sendTransfer` requires: a quantity would say
 * "five of these" about five objects with five different numbers on them.
 *
 * Archived products are included. A product hidden from the shop still has a
 * quantity somewhere, and "everything on this shelf" that quietly left some of
 * it behind would be worse than not offering the button.
 */
export function everythingAt(branchId) {
  const main = mainBranchId();

  /* A handset booked in before branches existed carries no branch, and belongs
     to the main shop — the same reading `sendTransfer` takes below. */
  const units = db
    .prepare(
      `SELECT u.product_id AS productId, u.id AS unitId
       FROM product_units u
       WHERE u.status IN (${AVAILABLE_STATUSES.map(() => '?').join(', ')})
         AND COALESCE(u.branch_id, ?) = ?
       ORDER BY u.product_id, u.id`,
    )
    .all(...AVAILABLE_STATUSES, main, branchId)
    .map((u) => ({ productId: u.productId, unitId: u.unitId, quantity: 1 }));

  const loose = db
    .prepare(
      `SELECT s.product_id AS productId, s.stock AS quantity
       FROM branch_stock s
       JOIN products p ON p.id = s.product_id
       WHERE s.branch_id = ? AND s.stock > 0
         AND p.wallet_id IS NULL AND p.tracks_units = 0
       ORDER BY p.name`,
    )
    .all(branchId)
    .map((r) => ({ productId: r.productId, unitId: null, quantity: r.quantity }));

  return [...loose, ...units];
}

export function sendTransfer({
  fromBranchId,
  toBranchId,
  items,
  /* Fill the transfer from the shelf itself rather than from a list built in a
     browser: five hundred handset ids do not belong in a request body, and the
     shelf is the only thing that knows what is actually standing on it. Every
     line is still checked one by one in the loop below, so anything that moved
     in between fails loudly instead of being sent twice. */
  everything = false,
  note = null,
  userId = null,
}) {
  if (!fromBranchId || !toBranchId) throw new Error('A transfer needs a branch at each end');
  if (Number(fromBranchId) === Number(toBranchId)) {
    throw new Error('A transfer has to go somewhere else');
  }

  const from = db.prepare('SELECT * FROM branches WHERE id = ?').get(fromBranchId);
  const to = db.prepare('SELECT * FROM branches WHERE id = ?').get(toBranchId);
  if (!from || !to) throw new Error('One of those branches does not exist');
  if (!to.active) throw new Error(`${to.name} is closed`);

  const lines = (everything ? everythingAt(fromBranchId) : items || [])
    .map((line) => ({
      productId: Number(line.productId),
      unitId: line.unitId ? Number(line.unitId) : null,
      quantity: line.unitId ? 1 : Math.round(Number(line.quantity) || 0),
    }))
    .filter((line) => line.productId && line.quantity > 0);

  if (lines.length === 0) {
    throw new Error(
      everything
        ? `There is nothing on the shelf at ${from.name} to send`
        : 'There is nothing on this transfer to send',
    );
  }

  return transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO stock_transfers
           (reference, from_branch_id, to_branch_id, status, note, created_by, sent_by, sent_at)
         VALUES (?, ?, ?, 'sent', ?, ?, ?, datetime('now'))`,
      )
      .run(nextReference(), fromBranchId, toBranchId, note?.trim() || null, userId, userId);

    const transferId = info.lastInsertRowid;
    const insertItem = db.prepare(
      'INSERT INTO stock_transfer_items (transfer_id, product_id, unit_id, quantity) VALUES (?, ?, ?, ?)',
    );

    for (const line of lines) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.productId);
      if (!product) throw new Error('One of those products no longer exists');
      if (product.wallet_id) {
        // Credit is not on a shelf. A card's wallet is shared by the company
        // already, so there is nothing to move.
        throw new Error(`${product.name} is sold from a wallet — there is no stock to move`);
      }

      if (product.tracks_units) {
        if (!line.unitId) throw new Error(`${product.name} is tracked by IMEI — pick which handset`);
        const unit = db.prepare('SELECT * FROM product_units WHERE id = ?').get(line.unitId);
        if (!unit) throw new Error('That handset is not in the records');
        /*
         * Anything the shop could still sell can be sent to the shop that
         * would sell it — which includes a handset that came back over the
         * counter and is sitting in the cabinet. It counts as stock at this
         * branch (see syncStockFromUnits), so refusing to move it left a shelf
         * showing one that no transfer could shift.
         */
        if (!isAvailable(unit.status)) {
          throw new Error(`${unit.imei} has been ${unit.status.replace('_', ' ')} and cannot be sent`);
        }
        if ((unit.branch_id ?? from.id) !== from.id) {
          throw new Error(`${unit.imei} is not at ${from.name}`);
        }
        /*
         * The handset is put at the destination now, and its shelf recounted at
         * both ends. A phone is one object: it cannot be half-moved, and
         * pretending it is still here until somebody clicks receive is how it
         * gets sold twice.
         */
        db.prepare('UPDATE product_units SET branch_id = ? WHERE id = ?').run(toBranchId, line.unitId);
        syncStockFromUnits(product.id);
      } else {
        const here = stockAt(fromBranchId, line.productId);
        if (here < line.quantity) {
          throw new Error(`Not enough ${product.name} at ${from.name} (have ${here}, sending ${line.quantity})`);
        }
        moveStock({ branchId: fromBranchId, productId: line.productId, delta: -line.quantity });
      }

      insertItem.run(transferId, line.productId, line.unitId, line.quantity);

      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
         VALUES (?, ?, ?, ?, 'transfer', ?, ?)`,
      ).run(
        line.productId,
        userId,
        -line.quantity,
        stockAt(fromBranchId, line.productId),
        `Sent to ${to.name}`,
        fromBranchId,
      );
    }

    return transferById(transferId);
  })();
}

/**
 * Take delivery at the other end.
 *
 * What arrived is counted, not assumed. Usually it is what was sent; when it is
 * not — a box short, something broken on the way — the difference is recorded
 * against the sending branch as a loss rather than quietly written off, because
 * somebody needs to go and ask about it.
 */
export function receiveTransfer(id, { userId = null, counts = null } = {}) {
  const transfer = transferById(id);
  if (!transfer) throw new Error('That transfer does not exist');
  if (transfer.status === 'received') throw new Error('That transfer has already been received');
  if (transfer.status !== 'sent') throw new Error('That transfer has not been sent yet');

  return transaction(() => {
    for (const item of transfer.items) {
      const received = counts?.[item.id] === undefined ? item.quantity : Math.max(0, Math.round(Number(counts[item.id]) || 0));
      if (received > item.quantity) {
        throw new Error(`More ${item.name} arrived than was sent — count it again`);
      }

      db.prepare('UPDATE stock_transfer_items SET received_quantity = ? WHERE id = ?').run(received, item.id);

      // A serialised handset was moved when it was sent; receiving it only
      // confirms what already happened.
      if (item.unit_id) continue;

      if (received > 0) {
        moveStock({ branchId: transfer.to_branch_id, productId: item.product_id, delta: received });
        db.prepare(
          `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
           VALUES (?, ?, ?, ?, 'transfer', ?, ?)`,
        ).run(
          item.product_id,
          userId,
          received,
          stockAt(transfer.to_branch_id, item.product_id),
          `Received from ${transfer.from_branch_name} · ${transfer.reference}`,
          transfer.to_branch_id,
        );
      }

      const missing = item.quantity - received;
      if (missing > 0) {
        /*
         * Left one branch and never arrived at the other. Recorded as a loss at
         * the sending end, where it was last seen, so the company's total stops
         * counting something nobody has.
         */
        db.prepare(
          `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
           VALUES (?, ?, 0, ?, 'damaged', ?, ?)`,
        ).run(
          item.product_id,
          userId,
          stockAt(transfer.from_branch_id, item.product_id),
          `${missing} short on ${transfer.reference} — sent but never arrived`,
          transfer.from_branch_id,
        );
      }
    }

    db.prepare(
      `UPDATE stock_transfers SET status = 'received', received_by = ?, received_at = datetime('now')
       WHERE id = ?`,
    ).run(userId, id);

    return transferById(id);
  })();
}

/**
 * Call it off, and put the goods back where they came from.
 *
 * Only while it is still in transit: once received the stock is on the other
 * shelf and has probably been sold from, and reversing it would take a count
 * below what is physically there. Send it back the other way instead, which is
 * what actually happened.
 */
export function cancelTransfer(id, userId = null) {
  const transfer = transferById(id);
  if (!transfer) throw new Error('That transfer does not exist');
  if (transfer.status === 'received') {
    throw new Error('That transfer has already been received — send it back the other way instead');
  }
  if (transfer.status === 'cancelled') throw new Error('That transfer was already cancelled');

  return transaction(() => {
    for (const item of transfer.items) {
      if (item.unit_id) {
        db.prepare('UPDATE product_units SET branch_id = ? WHERE id = ?').run(
          transfer.from_branch_id,
          item.unit_id,
        );
        syncStockFromUnits(item.product_id);
      } else {
        moveStock({ branchId: transfer.from_branch_id, productId: item.product_id, delta: item.quantity });
      }

      db.prepare(
        `INSERT INTO stock_adjustments (product_id, user_id, delta, resulting_stock, reason, note, branch_id)
         VALUES (?, ?, ?, ?, 'return', ?, ?)`,
      ).run(
        item.product_id,
        userId,
        item.quantity,
        stockAt(transfer.from_branch_id, item.product_id),
        `${transfer.reference} cancelled`,
        transfer.from_branch_id,
      );
    }

    db.prepare("UPDATE stock_transfers SET status = 'cancelled' WHERE id = ?").run(id);
    return transferById(id);
  })();
}

/** What is on its way to a branch, so somebody knows to expect it. */
export function incomingCount(branchId) {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM stock_transfers WHERE to_branch_id = ? AND status = 'sent'")
      .get(branchId)?.n ?? 0
  );
}
