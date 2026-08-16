import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { recordMovement } from '../lib/cash.js';
import { round2 } from '../lib/currency.js';
import {
  PARTY_TABLES,
  addEntry,
  balanceMap,
  balanceOf,
  listEntries,
  recordPayment,
  dealingsWith,
} from '../lib/accounts.js';
import { statementFor } from '../lib/statements.js';

/**
 * Customers and suppliers are the same shape — a contact with a running
 * balance and a ledger — so one router serves both. They differ only in
 * whether a credit limit applies and in what a positive balance means.
 */
export function partyRouter(partyType) {
  const router = Router();
  const table = PARTY_TABLES[partyType];
  const isCustomer = partyType === 'customer';

  /** Cashiers need to pick a customer at the register; the rest is admin-only. */
  router.get('/', requireAuth, (req, res) => {
    const { search, includeArchived } = req.query;
    const rows = db
      .prepare(`SELECT * FROM ${table} ${includeArchived === 'true' ? '' : 'WHERE active = 1'} ORDER BY name`)
      .all();

    const balances = balanceMap(partyType);
    const term = String(search || '').trim().toLowerCase();

    const parties = rows
      .map((r) => ({ ...r, active: !!r.active, balance: balances.get(r.id) ?? 0 }))
      .filter(
        (r) =>
          !term ||
          r.name.toLowerCase().includes(term) ||
          (r.phone || '').includes(term) ||
          (r.email || '').toLowerCase().includes(term),
      );

    res.json({ parties });
  });

  router.get('/:id', requireAuth, (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    res.json({
      party: { ...party, active: !!party.active, balance: balanceOf(partyType, party.id) },
      entries: listEntries(partyType, party.id, req.query.limit),
      // What was actually done with them, on account or not — see accounts.js.
      dealings: dealingsWith(partyType, party.id, req.query.limit),
    });
  });

  router.post('/', requireAuth, requirePermission('parties'), (req, res) => {
    const { name, phone, email, address, notes, credit_limit: creditLimit, opening_balance: opening } =
      req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const limit = isCustomer ? Number(creditLimit) || 0 : 0;
    if (limit < 0) return res.status(400).json({ error: 'Credit limit cannot be negative' });

    const openingBalance = Number(opening) || 0;

    try {
      const id = transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO ${table} (name, phone, email, address, notes${isCustomer ? ', credit_limit' : ''})
             VALUES (?, ?, ?, ?, ?${isCustomer ? ', ?' : ''})`,
          )
          .run(
            ...[
              String(name).trim(),
              phone || null,
              email || null,
              address || null,
              notes || null,
              ...(isCustomer ? [limit] : []),
            ],
          );

        // An opening balance lets an existing book be carried over on day one.
        if (openingBalance !== 0) {
          addEntry({
            partyType,
            partyId: info.lastInsertRowid,
            kind: 'opening',
            amountUsd: openingBalance,
            note: 'Opening balance',
            userId: req.user.id,
          });
        }
        return info.lastInsertRowid;
      })();

      const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      res.status(201).json({ party: { ...party, active: true, balance: balanceOf(partyType, id) } });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/:id', requireAuth, requirePermission('parties'), (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    const fields = ['name', 'phone', 'email', 'address', 'notes', 'active'];
    if (isCustomer) fields.push('credit_limit');

    const merged = { ...party };
    for (const f of fields) if (req.body[f] !== undefined) merged[f] = req.body[f];

    if (!String(merged.name || '').trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (isCustomer && Number(merged.credit_limit) < 0) {
      return res.status(400).json({ error: 'Credit limit cannot be negative' });
    }

    db.prepare(
      `UPDATE ${table} SET name = ?, phone = ?, email = ?, address = ?, notes = ?, active = ?
       ${isCustomer ? ', credit_limit = ?' : ''} WHERE id = ?`,
    ).run(
      ...[
        String(merged.name).trim(),
        merged.phone || null,
        merged.email || null,
        merged.address || null,
        merged.notes || null,
        merged.active ? 1 : 0,
        ...(isCustomer ? [Number(merged.credit_limit) || 0] : []),
        req.params.id,
      ],
    );

    const updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    res.json({
      party: { ...updated, active: !!updated.active, balance: balanceOf(partyType, updated.id) },
    });
  });

  /** Archive rather than delete — the ledger must stay intact. */
  router.delete('/:id', requireAuth, requirePermission('parties'), (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    const balance = balanceOf(partyType, party.id);
    if (Math.abs(balance) > 0.004) {
      return res.status(400).json({
        error: `${party.name} still has an outstanding balance of ${balance.toFixed(2)} USD`,
      });
    }

    db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  /** Money received from a customer, or paid out to a supplier. */
  router.post('/:id/payments', requireAuth, requirePermission('parties'), (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    try {
      const result = recordPayment({
        partyType,
        partyId: party.id,
        payments: req.body?.payments,
        note: req.body?.note || null,
        userId: req.user.id,
      });

      /*
       * Settling an account moves real notes: a customer paying what they owe
       * fills the drawer, paying a supplier empties it. Cheques and transfers
       * do not, so only cash is recorded here.
       */
      if (req.body?.inCash !== false) {
        const sign = isCustomer ? 1 : -1;
        recordMovement({
          kind: isCustomer ? 'customer_payment' : 'supplier_payment',
          amountUsd: sign * result.paidUsd,
          amountLbp: sign * result.paidLbp,
          reason: isCustomer ? 'customer_payment' : 'supplier',
          note: `${party.name}${req.body?.note ? ` — ${req.body.note}` : ''}`,
          userId: req.user.id,
        });
      }

      res.status(201).json({ ...result, balance: balanceOf(partyType, party.id) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * The account, as a piece of paper.
   *
   * Behind the same permission as the rest of the account, and no further: it
   * contains nothing that is not already on the party's own screen — it is the
   * same facts arranged so they can be handed to the person they are about.
   */
  router.get('/:id/statement', requireAuth, requirePermission('parties'), (req, res) => {
    try {
      res.json(statementFor(partyType, req.params.id, { from: req.query.from, to: req.query.to }));
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  /** A supplier bill, or a manual charge on a customer account. */
  router.post('/:id/charges', requireAuth, requirePermission('parties'), (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than zero' });
    }

    addEntry({
      partyType,
      partyId: party.id,
      kind: isCustomer ? 'adjustment' : 'bill',
      amountUsd: round2(amount),
      note: req.body?.note || null,
      userId: req.user.id,
    });

    res.status(201).json({ balance: balanceOf(partyType, party.id) });
  });

  return router;
}
