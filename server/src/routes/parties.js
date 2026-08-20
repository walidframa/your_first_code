import { Router } from 'express';
import { db, transaction } from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { defaultAccount } from '../lib/cashAccounts.js';
import { recordVoucher } from '../lib/vouchers.js';
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
import { lastPricesFor } from '../lib/lastPrices.js';

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

  /**
   * What this customer was last charged, product by product.
   *
   * Asked once when a sales invoice picks its customer, not once per line: an
   * invoice with twenty lines on it is one question about one person's
   * history. Suppliers have no such thing — what a shop *pays* is on the
   * purchase side, and lives with the costs.
   */
  if (isCustomer) {
    router.get('/:id/last-prices', requireAuth, (req, res) => {
      const party = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(req.params.id);
      if (!party) return res.status(404).json({ error: 'Not found' });
      res.json({ prices: lastPricesFor(party.id) });
    });
  }

  router.get('/:id', requireAuth, (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    /*
     * The slip behind each line, where there is one.
     *
     * Keyed by the ledger entry the voucher wrote, so a payment on the account
     * can be printed again — or cancelled — from the same row that shows it,
     * rather than by finding it again in the voucher book by its number.
     */
    const vouchers = db
      .prepare(
        `SELECT id, voucher_number, kind, status, entry_id, amount_usd, amount_lbp, issued_on
           FROM vouchers WHERE entry_id IS NOT NULL
            AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))`,
      )
      .all(partyType, party.id, partyType, party.id);

    res.json({
      party: { ...party, active: !!party.active, balance: balanceOf(partyType, party.id) },
      entries: listEntries(partyType, party.id, req.query.limit),
      // What was actually done with them, on account or not — see accounts.js.
      dealings: dealingsWith(partyType, party.id, req.query.limit),
      vouchers,
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

  /**
   * Money received from a customer, or paid out to a supplier.
   *
   * Written as a **voucher**, which is the change worth explaining. Settling an
   * account is the same act as every other movement of money in and out of a
   * till, and the shop's voucher book already knows how to do it: one
   * transaction that moves the drawer, moves the party's balance, and produces
   * a numbered slip the person handing the money over can sign.
   *
   * It used to be two calls that each did half of it, and the half that could
   * fail did so quietly — `recordMovement` returns null when no cashbox is
   * open, so a customer paying cash into a shut till left a ledger saying paid
   * and a drawer that never saw it. The voucher path refuses instead, with the
   * same message the register gives, which is the answer a counter can act on.
   *
   * A settlement that is not cash — a transfer, a cheque — has no till at
   * either end and no slip to print, so it stays on the ledger-only path.
   */
  router.post('/:id/payments', requireAuth, requirePermission('parties'), (req, res) => {
    const party = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!party) return res.status(404).json({ error: 'Not found' });

    const inCash = req.body?.inCash !== false;
    const till = req.body?.accountId ?? (inCash ? defaultAccount()?.id ?? null : null);

    try {
      if (inCash && till) {
        let amountUsd = 0;
        let amountLbp = 0;
        for (const p of req.body?.payments || []) {
          if (p?.currency === 'USD') amountUsd += Number(p.amount) || 0;
          if (p?.currency === 'LBP') amountLbp += Number(p.amount) || 0;
        }

        /*
         * Which way round it goes is the two accounts, never a flag: in from a
         * customer is a receipt, out to a supplier is a payment, and the ledger
         * sign falls out of that rather than being asserted here.
         */
        const voucher = recordVoucher({
          fromType: isCustomer ? 'customer' : 'cash',
          fromId: isCustomer ? party.id : till,
          toType: isCustomer ? 'cash' : 'supplier',
          toId: isCustomer ? till : party.id,
          amountUsd,
          amountLbp,
          reason: isCustomer ? 'customer' : 'supplier',
          note: req.body?.note || null,
          userId: req.user.id,
        });

        /*
         * `amountUsd` is what the payment came to *in dollars* — the two piles
         * added up at the rate the voucher was written at, not the dollar pile
         * on its own. It is the figure the balance moved by, and callers have
         * always read it that way.
         */
        const rate = Number(voucher.exchange_rate) || 0;
        return res.status(201).json({
          voucher,
          amountUsd: round2(amountUsd + (rate > 0 ? amountLbp / rate : 0)),
          paidUsd: round2(amountUsd),
          paidLbp: Math.round(amountLbp),
          balance: balanceOf(partyType, party.id),
        });
      }

      const result = recordPayment({
        partyType,
        partyId: party.id,
        payments: req.body?.payments,
        note: req.body?.note || null,
        userId: req.user.id,
      });

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
