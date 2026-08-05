import 'dotenv/config';
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
import { startShopifyWorker } from './lib/shopifyWorker.js';

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
app.use('/api/customers', partyRouter('customer'));
app.use('/api/suppliers', partyRouter('supplier'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`POS server listening on http://localhost:${PORT}`);
  // No-ops until a shop is connected and the sync is switched on.
  startShopifyWorker();
});
