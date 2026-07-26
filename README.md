# Front Desk POS

A point-of-sale web app in the spirit of Shopify POS: a fast, touch-friendly
register for cashiers, plus an admin back office for inventory, catalog imports,
orders and staff.

## Features

**Register (all staff)**
- Barcode / SKU scan-to-add — type or scan into the search bar and press Enter
- Product grid with search and category filters, live stock counts
- Cart with quantity steppers capped at available stock
- Order-level discount, automatic tax, live total
- Payment sheet: card, or cash with a numeric keypad and quick-cash amounts
- Change due surfaced prominently, plus a printable receipt
- Keyboard shortcuts: `/` focuses search, `F2` opens payment
- Stock decrements atomically as part of the sale, so it can't oversell

**Back office (admin only)**
- Dashboard: revenue hero figure, KPI tiles, a continuous daily-revenue column
  chart, top sellers, payment mix and restock alerts — all scoped by one date-range filter
- Inventory: stock levels with reorder points, value on hand, stock adjustments
  with reasons (received, damaged, theft, count correction, return, transfer),
  and a full movement ledger per product
- Import: bring a catalog over from **Shopify, Square, Lightspeed or any CSV**,
  with auto-detection, editable column mapping, a validated dry-run preview, and
  upsert-by-SKU
- Products: full CRUD with barcode, supplier, cost/margin, image URL, archive/restore
- Orders: every cashier's sales with full refunds that restock items
- Staff: `admin` / `cashier` accounts

Cashiers only see their own sales; admin routes are enforced server-side, not just
hidden in the UI.

## Stack

- **Frontend** — React 19, Vite, React Router, Tailwind CSS v4, lucide-react, axios
- **Backend** — Node, Express, better-sqlite3, JWT auth, bcrypt
- **Database** — SQLite (file-based, zero setup)

## Getting started

Requires Node 20 or newer (Node 22 recommended).

```bash
npm run setup   # installs all dependencies and seeds the database
npm run dev     # starts the API on :4000 and the app on :5173
```

Then open http://localhost:5173 and sign in with one of the demo accounts below —
the login screen has one-tap buttons for both.

To stop, press `Ctrl+C`. Data lives in `server/data.sqlite`; delete it and re-run
`npm run seed` to start over.

### Demo accounts

| Username  | Password     | Role    |
| --------- | ------------ | ------- |
| `admin`   | `admin123`   | admin   |
| `cashier` | `cashier123` | cashier |

Change these before deploying anywhere real.

## Tests

```bash
npm test   # server unit + API integration tests (node:test, no extra deps)
npm run e2e  # Playwright smoke test against a throwaway DB and a production build
```

`npm run e2e` seeds a temporary database, boots the API and a preview build of the
client on their own ports, drives Chromium through the register, back office and
import flows, then tears everything down. Set `E2E_SCREENSHOT_DIR` to capture
screenshots of each stage.

CI runs both suites plus the client build and lint on every pull request
(`.github/workflows/ci.yml`).

## Configuration

Copy `server/.env.example` to `server/.env` to override defaults:

| Variable     | Default      | Purpose                       |
| ------------ | ------------ | ----------------------------- |
| `PORT`       | `4000`       | API port                      |
| `TAX_RATE`   | `0.08`       | Sales tax applied at checkout  |
| `DB_PATH`    | `server/data.sqlite` | SQLite file location  |
| `JWT_SECRET` | —            | Token signing secret          |

**`JWT_SECRET` is required in production.** With `NODE_ENV=production` the server
refuses to start unless it is set to at least 32 characters. In development an
ephemeral random secret is generated per process (with a warning), so sessions do
not survive a restart until you set one.

## Importing an existing catalog

Admin → **Import**. Drop a CSV and the importer will:

1. Detect the source format from its headers (Shopify, Square, Lightspeed, or generic)
2. Auto-map columns onto `name`, `sku`, `price`, `cost`, `stock`, `category`,
   `barcode`, `supplier`, `image_url` and `reorder_point` — editable before you commit
3. Validate every row and show exactly what will be created, updated or skipped
4. Upsert by SKU, creating categories as needed and writing stock changes to the
   inventory ledger

The parser handles quoted fields, embedded commas and newlines, CRLF, BOMs,
`;`/tab/`|` delimiters, and prices written as `$1,299.00` or `1.299,50`.

## Project layout

```
server/
  src/
    db.js                 schema, migrations, connection
    seed.js               demo users, categories, products
    lib/csv.js            RFC 4180 CSV parser
    lib/importFormats.js  ERP column presets + number parsing
    middleware/auth.js    JWT verification and role guards
    routes/               auth, products, orders, reports, users, inventory, imports
client/
  src/
    components/ui/        design-system primitives (Button, Modal, Toast, …)
    components/charts.jsx dashboard charts
    context/              auth state
    pages/                login, register, my sales
    pages/admin/          dashboard, products, inventory, import, orders, staff
```

## API

All routes except `POST /api/auth/login` require a `Bearer` token.

| Method | Route                        | Role    |
| ------ | ---------------------------- | ------- |
| POST   | `/api/auth/login`            | public  |
| GET    | `/api/auth/me`               | any     |
| GET    | `/api/products`              | any     |
| GET    | `/api/products/lookup?code=` | any     |
| POST   | `/api/products`              | admin   |
| PUT    | `/api/products/:id`          | admin   |
| DELETE | `/api/products/:id`          | admin   |
| GET    | `/api/products/categories`   | any     |
| POST   | `/api/orders`                | any     |
| GET    | `/api/orders`                | any\*   |
| GET    | `/api/orders/:id`            | any\*   |
| POST   | `/api/orders/:id/refund`     | admin   |
| GET    | `/api/reports/summary`       | admin   |
| GET    | `/api/inventory`             | admin   |
| GET    | `/api/inventory/movements`   | admin   |
| POST   | `/api/inventory/adjust`      | admin   |
| GET    | `/api/imports/formats`       | admin   |
| POST   | `/api/imports/preview`       | admin   |
| POST   | `/api/imports/commit`        | admin   |
| GET    | `/api/users`                 | admin   |
| POST   | `/api/users`                 | admin   |
| DELETE | `/api/users/:id`             | admin   |

\* Cashiers are scoped to their own orders.

## Notes and limitations

- Payments are **recorded, not processed** — there is no card gateway integration,
  so this cannot take real money without connecting a provider such as Stripe.
- Refunds are full-order only; partial refunds are not implemented.
- Tax is a single store-wide rate, not per-product or per-jurisdiction.
- SQLite suits a single register well. Multi-location or high concurrency would
  want Postgres and a real payment provider.
