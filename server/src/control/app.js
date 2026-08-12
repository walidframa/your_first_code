import express from 'express';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureControlSchema } from '../lib/control.js';
import { PLANS, extend, licenceMessage, licenceState, today } from '../lib/licence.js';
import {
  attemptKey,
  ensureOperatorSchema,
  lockedFor,
  noteFailure,
  noteSuccess,
  touchOperator,
  verifyOperator,
} from '../lib/operators.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The vendor's console: the book of shops, and what each one has paid.
 *
 * **What it deliberately cannot do.** Setting a shop up, taking one off the
 * air, and deleting one's data all need root — they write systemd units, edit
 * nginx and remove files. This runs as an ordinary user and stays that way. Two
 * reasons, and the second is the real one:
 *
 *   A web page that can run root commands is a web page worth attacking, and
 *   this one is on the open internet with a password in front of it.
 *
 *   And the destructive actions are the ones you want to be slightly hard. A
 *   shop's data should be deleted by somebody sitting at a terminal, having
 *   typed the name twice, not by a mis-click on a phone.
 *
 * So the console does the daily work — who has paid, who is about to lapse,
 * taking a payment, stopping and starting a shop — and prints the exact command
 * for the three that belong on the server.
 */
export function createConsoleApp({ controlDb, secret, domain = 'xtechpos.com' }) {
  const db = ensureOperatorSchema(ensureControlSchema(new DatabaseSync(controlDb)));

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  // Behind nginx, so the address in the log is the visitor's rather than the
  // proxy's — which matters for the lockout below.
  app.set('trust proxy', 1);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  /* ------------------------------------------------------------- signing in */

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const key = attemptKey(username, req.ip);

    const waitMs = lockedFor(key);
    if (waitMs > 0) {
      return res.status(429).json({
        error: `Too many wrong tries. Try again in ${Math.ceil(waitMs / 60000)} minutes.`,
      });
    }

    const operator = verifyOperator(db, username, password);
    if (!operator) {
      noteFailure(key);
      // The same words either way: which usernames exist is not a hint worth
      // giving away on the one login that can stop every shop.
      return res.status(401).json({ error: 'Wrong username or password' });
    }

    noteSuccess(key);
    touchOperator(db, operator.id);
    const token = jwt.sign({ id: operator.id, username: operator.username }, secret, {
      expiresIn: '8h',
    });
    res.json({ token, username: operator.username });
  });

  function requireOperator(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in first' });
    try {
      req.operator = jwt.verify(header.slice(7), secret);
    } catch {
      return res.status(401).json({ error: 'Session expired — sign in again' });
    }
    // Still a real account: removing an operator has to end their session, not
    // wait eight hours for it.
    const live = db.prepare('SELECT id FROM operators WHERE id = ?').get(req.operator.id);
    if (!live) return res.status(401).json({ error: 'That console account no longer exists' });
    next();
  }

  /* --------------------------------------------------------------- the book */

  app.get('/api/tenants', requireOperator, (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM tenants ORDER BY removed_at IS NOT NULL, shop_name`)
      .all();

    const tenants = rows.map((row) => {
      const status = row.removed_at ? { state: 'removed' } : licenceState(row);
      return {
        slug: row.slug,
        shopName: row.shop_name,
        ownerName: row.owner_name,
        ownerPhone: row.owner_phone,
        plan: row.plan,
        price: row.price,
        port: row.port,
        paidThrough: row.paid_through,
        graceDays: row.grace_days,
        suspended: Boolean(row.suspended),
        removedAt: row.removed_at,
        address: `https://${row.slug}.${domain}`,
        licence: { ...status, message: licenceMessage(status) },
      };
    });

    /*
     * What the vendor actually wants to know on opening this: who is about to
     * stop, and how much is riding on it.
     */
    const owing = tenants.filter((t) => ['due', 'overdue', 'locked'].includes(t.licence.state));
    res.json({
      tenants,
      summary: {
        total: tenants.filter((t) => !t.removedAt).length,
        needAttention: owing.length,
        monthlyValue: tenants
          .filter((t) => !t.removedAt && !t.suspended)
          .reduce((sum, t) => sum + (t.plan === 'yearly' ? t.price / 12 : t.price), 0),
      },
    });
  });

  app.get('/api/tenants/:slug/payments', requireOperator, (req, res) => {
    const tenant = db.prepare('SELECT id FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'No such shop' });
    res.json({
      payments: db
        .prepare('SELECT * FROM payments WHERE tenant_id = ? ORDER BY id DESC LIMIT 50')
        .all(tenant.id),
    });
  });

  /* ------------------------------------------------------------- the money */

  app.post('/api/tenants/:slug/pay', requireOperator, (req, res) => {
    const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'No such shop' });
    if (tenant.removed_at) return res.status(400).json({ error: 'That shop has been removed' });

    const periods = Number(req.body?.periods ?? 1);
    if (!Number.isInteger(periods) || periods < 1 || periods > 60) {
      return res.status(400).json({ error: 'Periods must be a whole number between 1 and 60' });
    }
    const amount = Number(req.body?.amount ?? tenant.price * periods);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'That is not an amount' });
    }
    if (!PLANS[tenant.plan]) return res.status(400).json({ error: `Unknown plan ${tenant.plan}` });

    /*
     * From the day already paid for, unless that is in the past — the same rule
     * as the command line, and the reason it is in one function rather than
     * two: a shop paying late still buys a whole month, a shop paying early
     * keeps the remainder, and a shop returning after six months does not buy a
     * month that has already been and gone.
     */
    const from =
      tenant.paid_through && tenant.paid_through >= today() ? tenant.paid_through : today();
    const now = extend(from, tenant.plan, periods);

    db.prepare('UPDATE tenants SET paid_through = ?, suspended = 0 WHERE id = ?').run(now, tenant.id);
    db.prepare(
      `INSERT INTO payments (tenant_id, amount, periods, was_paid_through, now_paid_through, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(tenant.id, amount, periods, tenant.paid_through, now, req.body?.note || null);

    res.json({ paidThrough: now, wasPaidThrough: tenant.paid_through });
  });

  /* --------------------------------------------------------- the on/off switch */

  app.post('/api/tenants/:slug/suspend', requireOperator, (req, res) => {
    const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'No such shop' });

    const suspended = req.body?.suspended ? 1 : 0;
    db.prepare('UPDATE tenants SET suspended = ? WHERE id = ?').run(suspended, tenant.id);
    res.json({ suspended: Boolean(suspended) });
  });

  /* ------------------------------------------------- the ones that need root */

  /**
   * The commands this console will not run for you.
   *
   * Handed over as text to paste into a terminal rather than as a button,
   * because each of them writes systemd units, edits nginx or deletes a shop's
   * database — and a page on the open internet that can do those is a page
   * worth breaking into.
   */
  app.get('/api/commands', requireOperator, (req, res) => {
    res.json({
      add: 'pos-tenant add <name> "Shop Name" --plan monthly --price 25 --trial 14',
      remove: 'pos-tenant remove <name>',
      purge: 'pos-tenant purge <name> --yes',
      note: 'Run these on the server, as root. Add --dry-run to any of them first.',
    });
  });

  /* ---------------------------------------------------------------- the page */

  const page = readFileSync(path.join(here, 'console.html'), 'utf8');
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(page);
  });

  return app;
}
