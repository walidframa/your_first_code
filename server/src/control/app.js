import express from 'express';
import jwt from 'jsonwebtoken';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureControlSchema } from '../lib/control.js';
import { mintTicket, pruneTickets } from '../lib/supportTickets.js';
import { MODULES, MODULE_KEYS, parseModules, serialiseModules } from '../lib/modules.js';
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
        modules: parseModules(row.modules),
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

  /* ------------------------------------------------------- going into a shop */

  /** A shop that is actually running, and where on this machine to reach it. */
  function reachable(slug) {
    const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
    if (!tenant) return { error: 'No such shop', status: 404 };
    if (tenant.removed_at) return { error: 'That shop has been removed', status: 400 };
    if (!tenant.port) return { error: 'That shop has no port recorded', status: 409 };
    return { tenant, base: `http://127.0.0.1:${tenant.port}` };
  }

  /**
   * Do something inside a shop, as the shop, on the vendor's behalf.
   *
   * Not by reaching into their database — by asking their own server, on a
   * ticket, exactly as a browser would. Three things follow from that and all
   * three are the point: the shop's own code enforces its own rules, the visit
   * is written into the shop's log like any other, and this console never needs
   * a key to anything.
   *
   * The reply is the shop's own. An error from in there is passed through
   * rather than reworded, because a vendor debugging a shop wants what the shop
   * said.
   */
  async function inside(slug, operator, reason, call) {
    const found = reachable(slug);
    if (found.error) return found;

    const { token } = mintTicket(db, { slug, operator, reason });
    let session;
    try {
      const res = await fetch(`${found.base}/api/support/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10000),
      });
      session = await res.json();
      if (!res.ok) return { error: session?.error || 'That shop refused the visit', status: 502 };
    } catch (err) {
      // The commonest cause by far, and the one worth naming: the shop is down.
      return { error: `Could not reach that shop: ${err.message}`, status: 502 };
    }

    return call(found.base, session.token);
  }

  /**
   * A link that signs the vendor into a client's shop, once, within five
   * minutes.
   *
   * The reason is required. Not as a formality — it is what the shop sees on
   * the bar across their screen while the visit lasts, and what stands in their
   * log afterwards. "Rami asked me to fix the iPhone price" is a different
   * thing to read a month later than a blank.
   */
  app.post('/api/tenants/:slug/support', requireOperator, (req, res) => {
    const found = reachable(req.params.slug);
    if (found.error) return res.status(found.status).json({ error: found.error });

    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Say what you are going in to do' });
    }

    const { token, expiresAt } = mintTicket(db, {
      slug: req.params.slug,
      operator: req.operator.username,
      reason,
    });
    pruneTickets(db);

    res.json({
      url: `https://${req.params.slug}.${domain}/support?t=${token}`,
      expiresAt,
      warning: 'They will see a bar naming you for as long as you are in there.',
    });
  });

  /* --------------------------------------------------- their copies of things */

  app.get('/api/tenants/:slug/backups', requireOperator, async (req, res) => {
    const out = await inside(req.params.slug, req.operator.username, 'Listing backups', async (base, token) => {
      const r = await fetch(`${base}/api/backups`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      return { status: r.status, body: await r.json() };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(out.status).json(out.body);
  });

  app.post('/api/tenants/:slug/backups', requireOperator, async (req, res) => {
    const out = await inside(
      req.params.slug,
      req.operator.username,
      req.body?.reason || 'Taking a backup',
      async (base, token) => {
        const r = await fetch(`${base}/api/support/backup`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(120000),
        });
        return { status: r.status, body: await r.json() };
      },
    );
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(out.status).json(out.body);
  });

  /**
   * A client's whole shop, downloaded.
   *
   * Streamed through rather than read into memory: this is the file the entire
   * business is in, and a console that loaded a 400MB database into a buffer to
   * hand it over would fall over on exactly the shop that mattered most.
   */
  app.get('/api/tenants/:slug/backups/:name', requireOperator, async (req, res) => {
    const out = await inside(
      req.params.slug,
      req.operator.username,
      'Downloading a backup',
      async (base, token) => {
        const r = await fetch(`${base}/api/backups/${encodeURIComponent(req.params.name)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(300000),
        });
        return { status: r.status, upstream: r };
      },
    );
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (out.status !== 200 || !out.upstream.body) {
      return res.status(out.status).json(await out.upstream.json().catch(() => ({
        error: 'That shop would not hand over the file',
      })));
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${req.params.slug}-${req.params.name}"`,
    );
    const length = out.upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);

    for await (const chunk of out.upstream.body) res.write(chunk);
    res.end();
  });

  /**
   * Put a shop back to one of its copies.
   *
   * The shop does this to itself: it takes a copy of where it is now, writes the
   * chosen one down beside its database and restarts onto it. This console does
   * not touch the file and could not — which is why a restore is a button here
   * and a purge is not.
   */
  app.post('/api/tenants/:slug/restore', requireOperator, async (req, res) => {
    const name = String(req.body?.name || '');
    if (!name) return res.status(400).json({ error: 'Which copy?' });

    const out = await inside(
      req.params.slug,
      req.operator.username,
      `Restoring ${name}`,
      async (base, token) => {
        const r = await fetch(`${base}/api/support/restore`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(120000),
        });
        return { status: r.status, body: await r.json() };
      },
    );
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(out.status).json(out.body);
  });

  /** A way back in for an owner who is locked out of their own shop. */
  app.post('/api/tenants/:slug/reset-password', requireOperator, async (req, res) => {
    const username = String(req.body?.username || 'admin').trim();

    const out = await inside(
      req.params.slug,
      req.operator.username,
      `Resetting the password for ${username}`,
      async (base, token) => {
        const r = await fetch(`${base}/api/support/reset-password`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username }),
          signal: AbortSignal.timeout(15000),
        });
        return { status: r.status, body: await r.json() };
      },
    );
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(out.status).json(out.body);
  });

  /* -------------------------------------------- what the shop is allowed */

  /** Everything that can be sold separately, so the console can list it. */
  app.get('/api/modules', requireOperator, (req, res) => {
    res.json({ modules: MODULES.map(([key, name, what]) => ({ key, name, what })) });
  });

  /**
   * Turn a feature on or off for one shop.
   *
   * Takes effect on their next request — the shop's process reads this table on
   * every call, so nothing has to be restarted and nobody has to be told to
   * refresh. Turning one off hides it from their menu and refuses the routes
   * behind it, including for their own owner.
   */
  app.post('/api/tenants/:slug/modules', requireOperator, (req, res) => {
    const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'No such shop' });

    const wanted = req.body?.modules;
    if (!Array.isArray(wanted)) return res.status(400).json({ error: 'Send a list of modules' });

    const unknown = wanted.filter((key) => !MODULE_KEYS.includes(key));
    if (unknown.length) {
      return res.status(400).json({ error: `Not a feature: ${unknown.join(', ')}` });
    }

    db.prepare('UPDATE tenants SET modules = ? WHERE id = ?').run(
      serialiseModules(wanted),
      tenant.id,
    );
    res.json({ modules: parseModules(serialiseModules(wanted)) });
  });

  /**
   * What this shop pays, and how often.
   *
   * Changed here rather than by editing the database, because a price is
   * something that gets renegotiated — and because the figure the console adds
   * up as "per month" is read straight off these two.
   *
   * It does not move the licence. A shop that has paid to March has paid to
   * March whatever it agrees to pay from now on, and quietly re-dating that
   * from a price change is how somebody loses a month they paid for.
   */
  app.post('/api/tenants/:slug/plan', requireOperator, (req, res) => {
    const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'No such shop' });

    const plan = String(req.body?.plan ?? tenant.plan);
    if (!PLANS[plan]) {
      return res.status(400).json({ error: `Plan must be one of: ${Object.keys(PLANS).join(', ')}` });
    }

    const price = Number(req.body?.price ?? tenant.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'That is not a price' });
    }

    db.prepare('UPDATE tenants SET plan = ?, price = ? WHERE id = ?').run(plan, price, tenant.id);
    res.json({ plan, price, paidThrough: tenant.paid_through });
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

  /*
   * Anything that went wrong and was not expected. Last, because Express only
   * offers an error to handlers registered after the route that threw.
   *
   * Without this a throw becomes Express's default HTML 500 with no JSON in it,
   * and the console — which reads `body.error` and falls back to a shrug —
   * shows "That did not work". That is exactly what the vendor saw when a
   * column was missing from the book of shops, and it cost a day to work out
   * from the outside what one line of the message would have said.
   *
   * The message is shown rather than swallowed because the only person who ever
   * reaches this page is the vendor, signed in, looking at their own machines.
   */
  // The unused fourth argument is not an oversight: Express identifies an error
  // handler by its arity, and a three-argument version of this is never called.
  app.use((err, req, res, _next) => {
    console.error('Console error:', err);
    res.status(500).json({ error: err?.message || 'Something went wrong' });
  });

  return app;
}
