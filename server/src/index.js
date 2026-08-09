import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import './db.js';
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
import walletRoutes from './routes/wallets.js';
import transferRoutes from './routes/transfers.js';
import voucherRoutes from './routes/vouchers.js';
import heldSaleRoutes from './routes/held.js';
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
    limit: '6mb',
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
const clientDist = process.env.CLIENT_DIST || path.join(__dirname, '..', '..', 'client', 'dist');
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
        res.setHeader(
          'Cache-Control',
          filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
        );
      },
    }),
  );
}

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
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
app.use('/api/wallets', walletRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/vouchers', voucherRoutes);
app.use('/api/held-sales', heldSaleRoutes);
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
  if (serveClient && req.method === 'GET' && !req.path.startsWith('/api/')) {
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
});
