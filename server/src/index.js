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
import inventoryRoutes from './routes/inventory.js';
import importRoutes from './routes/imports.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/users', userRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/settings', settingsRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`POS server listening on http://localhost:${PORT}`);
});
