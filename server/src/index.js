import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { db } from './db.js';
import { BUILD } from './lib/build.js';
import { enabledModules, enforceLicence, enforceModules, licenceStatus } from './middleware/licence.js';
import { licenceMessage } from './lib/licence.js';
import { getSettings } from './lib/settings.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import reportRoutes from './routes/reports.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import accountsRoutes from './routes/accounts.js';
import documentRoutes from './routes/documents.js';
import { partyRouter } from './routes/parties.js';
import inventoryRoutes from './routes/inventory.js';
import unitRoutes from './routes/units.js';
import heldAccountRoutes from './routes/accountsHeld.js';
import repairRoutes from './routes/repairs.js';
import importRoutes from './routes/imports.js';
import shopifyRoutes from './routes/shopify.js';
import cashRoutes from './routes/cash.js';
import expenseRoutes from './routes/expenses.js';
import ledgerRoutes from './routes/ledger.js';
import employeeRoutes from './routes/employees.js';
import walletRoutes from './routes/wallets.js';
import simRoutes from './routes/sims.js';
import creditRoutes from './routes/credit.js';
import backupRoutes from './routes/backups.js';
import { startNightlyBackups } from './lib/backups.js';
import installmentRoutes from './routes/installments.js';
import transferRoutes from './routes/transfers.js';
import voucherRoutes from './routes/vouchers.js';
import heldSaleRoutes from './routes/held.js';
import branchRoutes from './routes/branches.js';
import stockTransferRoutes from './routes/stockTransfers.js';
import supportRoutes from './routes/support.js';
import { recordSupportWrites } from './middleware/support.js';
import { startShopifyWorker } from './lib/shopifyWorker.js';
import { seedMissingPermissions } from './lib/permissions.js';

/*
 * Accounts that existed before permissions did have none, and an empty set
 * means "allowed nothing". Give each one its role's defaults once, at startup,
 * so an upgrade does not lock the staff out of the register on Monday morning.
 */
seedMissingPermissions();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
/*
 * Keep the raw body around: Shopify signs the exact bytes it sent, so a webhook
 * cannot be verified against a re-serialised object.
 */
app.use(
  express.json({
    /*
     * Generous because two things arrive as base64 inside JSON — a spreadsheet
     * to import and a photographed ID — and base64 costs a third on top. A 5MB
     * workbook is 6.7MB on the wire, so a 6mb ceiling would refuse a file the
     * import itself considers well within its limit, from underneath it, with
     * an error mentioning neither.
     */
    limit: '12mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

/*
 * The built client, served by the same process.
 *
 * In development Vite serves the pages and forwards `/api` here, so there are
 * two servers and two ports. In a shop there is one machine and one address, and
 * a second process whose only job is to hand over three static files is a second
 * thing that can be down while the till is up. So once the client has been
 * built, this serves it.
 *
 * Absent until `npm run build` has been run, which is what keeps development
 * and the tests on exactly the path they were on before.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/*
 * Resolved, because a relative CLIENT_DIST is a trap: the static handler
 * accepts one and serves the assets happily, while `res.sendFile` refuses
 * anything that is not absolute — so every asset answers 200 and every actual
 * page answers 500, which looks like the app being broken rather than a path
 * being written the short way.
 */
const clientDist = path.resolve(
  process.env.CLIENT_DIST || path.join(__dirname, '..', '..', 'client', 'dist'),
);
const indexHtml = path.join(clientDist, 'index.html');
const serveClient = existsSync(indexHtml);

if (serveClient) {
  /*
   * Vite puts a content hash in every asset's filename, so an asset that exists
   * can never change — cache it for a year. index.html is the opposite: it is
   * the file that names the current assets, so a cached copy is a browser
   * permanently stuck on the last deploy, still asking for files that are gone.
   * That is the difference between an update reaching the shop and not.
   */
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders: (res, filePath) => {
        /*
         * Two files must never be cached, and for the same reason: they are the
         * ones that say what the current version *is*.
         *
         * index.html names the hashed assets. sw.js names the cache the whole
         * app is served from — and it cannot carry a hash in its own filename,
         * because a service worker has to sit at the root to control the app.
         * Served `immutable` for a year it would be the one file a browser
         * never re-fetches, which is precisely the file that has to change for
         * an update to reach a till at all.
         */
        const name = path.basename(filePath);
        const pinned = name === 'index.html' || name === 'sw.js';
        res.setHeader(
          'Cache-Control',
          pinned ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
      },
    }),
  );
}

/*
 * Health, and the one thing the sign-in screen needs before anybody has signed
 * in: whether this is still a fresh copy with the demo logins in it.
 *
 * The one-tap demo buttons print `admin/admin123` on the front door. That is
 * exactly right on a demo and exactly wrong on a shop, so they are shown only
 * while those passwords are actually still in use — and the moment somebody
 * sets a real one, the hint goes with it.
 *
 * Saying so out loud gives an attacker nothing they could not learn by typing
 * the two passwords from the README, and it removes them from the page for
 * everybody else.
 */
app.get('/api/health', (req, res) => {
  const demo = db.prepare('SELECT COUNT(*) AS n FROM users WHERE must_change_password = 1').get();
  /*
   * `build` is what this *process* started with, not what is on disk now — see
   * lib/build.js. It is here so a deploy can ask each shop what it is actually
   * serving instead of assuming that having run `systemctl restart` means the
   * code changed. Unauthenticated like the rest of this endpoint: a commit hash
   * of a public repository is not a secret, and needing a token to ask would
   * defeat the one job it has.
   */
  res.json({ ok: true, demoAccounts: demo.n > 0, build: BUILD });
});
/*
 * Where the licence stands, before anybody has signed in.
 *
 * Unauthenticated on purpose: a till that has stopped has to be able to say why
 * on the screen a cashier is looking at, and the answer — a date, and whether
 * it has passed — is the shop's own business rather than a secret. It also
 * means the sign-in screen itself can carry the warning.
 */
/**
 * Who this shop is, for the screen that runs before anybody has signed in.
 *
 * The sign-in page is the first thing a cashier sees every morning and it says
 * "Front Desk POS" on it, which is the name of the software rather than the
 * name of the shop. Both of these are already on every receipt that leaves the
 * counter, so neither is a secret being handed to a stranger.
 */
app.get('/api/branding', (req, res) => {
  const settings = getSettings();
  res.json({
    companyName: settings.company_name || '',
    logoUrl: settings.company_logo_url || '',
  });
});

app.get('/api/licence', (req, res) => {
  const status = licenceStatus();
  res.json({
    licence: { ...status, message: licenceMessage(status) },
    /*
     * What this shop bought, alongside whether it has paid.
     *
     * On the same unauthenticated call the app already makes before anybody
     * signs in, so the menu is right on the first paint rather than showing a
     * Repairs screen for half a second and then taking it away.
     */
    modules: enabledModules(),
  });
});

/*
 * And from here down, nothing trades without one.
 *
 * Mounted before the routes rather than inside each of them: a rule that has to
 * be remembered on every new endpoint is a rule that will be missed on one, and
 * the one it is missed on will be the one that takes money.
 */
app.use(enforceLicence);

/*
 * Everything a support visit changes, written down as it goes.
 *
 * At the door rather than in each route. Twenty-odd route files would each have
 * to remember to log, and the one that forgot would be invisible — which makes
 * the log worse than useless, because it would be trusted and incomplete.
 *
 * Reads are not recorded. The interesting question a shopkeeper asks afterwards
 * is "what did you change", and a log of every list the vendor scrolled past
 * would bury the answer.
 */
/*
 * And nothing the shop did not buy.
 *
 * After the licence, because "you have stopped paying" is the more urgent
 * answer of the two, and before the routes for the same reason the licence is:
 * a rule each new endpoint has to remember is a rule one of them will miss.
 */
app.use(enforceModules);

app.use(recordSupportWrites);

app.use('/api/auth', authRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/held-accounts', heldAccountRoutes);
app.use('/api/repairs', repairRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/cash', cashRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/wallets', walletRoutes);
app.use('/api/sims', simRoutes);
app.use('/api/credit', creditRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/installments', installmentRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/held-sales', heldSaleRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/stock-transfers', stockTransferRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', partyRouter('customer'));
app.use('/api/suppliers', partyRouter('supplier'));

/*
 * Anything left over.
 *
 * The app routes in the browser, so `/admin/cashbox` typed into the address bar
 * or arriving from a bookmark is a real page that the server has never heard of
 * — it has to be answered with the app itself, which then reads the path. Only
 * for pages: a mistyped API route must still say plainly that it does not
 * exist, rather than handing back a page of HTML for something expecting JSON.
 */
app.use((req, res) => {
  /*
   * HEAD as well as GET.
   *
   * A HEAD is a GET that stops before the body, and it is what every uptime
   * monitor, load balancer and `curl -I` sends — so answering it with 404 means
   * a perfectly healthy shop is reported as missing by everything that checks
   * on it without opening a browser. Express already writes the headers and
   * omits the body; it only had to be let through.
   */
  const isPageRequest = req.method === 'GET' || req.method === 'HEAD';
  if (serveClient && isPageRequest && !req.path.startsWith('/api/')) {
    // Said here as well as in the static handler above, which never sees this
    // file: a cached index.html is a till permanently stuck on an old deploy,
    // asking for asset files that no longer exist.
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexHtml);
  }
  res.status(404).json({ error: 'Not found' });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`POS server listening on http://localhost:${PORT}`);
  console.log(
    serveClient
      ? `Serving the built client from ${clientDist}`
      : 'No built client found — run `npm run build` to serve the app from this process too',
  );
  // No-ops until a shop is connected and the sync is switched on.
  startShopifyWorker();

  /*
   * A copy of the books, once a day, without anybody remembering to.
   *
   * Skipped under test, where a hundred throwaway databases would each leave a
   * backup directory behind.
   */
  if (process.env.NODE_ENV !== 'test') startNightlyBackups();
});
