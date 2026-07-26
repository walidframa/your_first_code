# Front Desk POS

A point-of-sale web app in the spirit of Shopify POS: a fast touch-friendly checkout
screen for cashiers, plus an admin back office for inventory, orders and staff.

## Features

**Checkout (all staff)**
- Product grid with search by name/SKU and category filters
- Cart with quantity controls, capped at available stock
- Order-level percentage discount, automatic tax, live total
- Cash or card payment; cash shows change due
- Printable-style receipt after each sale
- Stock is decremented atomically as part of the sale

**Back office (admin only)**
- Sales dashboard: revenue, order count, average order value, tax collected,
  14-day revenue chart, top sellers, low-stock alerts
- Product & inventory management (create, edit, archive/restore)
- All orders across cashiers, with full refunds that restock items
- Staff accounts with `admin` / `cashier` roles

Cashiers only see their own sales; admin routes are enforced server-side, not just hidden in the UI.

## Stack

- **Frontend** — React 19, Vite, React Router, Tailwind CSS, axios
- **Backend** — Node, Express, better-sqlite3, JWT auth, bcrypt
- **Database** — SQLite (file-based, zero setup)

## Getting started

```bash
npm run setup   # installs server + client deps and seeds the database
npm run dev     # starts API on :4000 and the app on :5173
```

Then open http://localhost:5173.

### Demo accounts

| Username  | Password     | Role    |
| --------- | ------------ | ------- |
| `admin`   | `admin123`   | admin   |
| `cashier` | `cashier123` | cashier |

Change these before deploying anywhere real.

## Configuration

Copy `server/.env.example` to `server/.env` to override defaults:

| Variable     | Default        | Purpose                          |
| ------------ | -------------- | -------------------------------- |
| `PORT`       | `4000`         | API port                         |
| `JWT_SECRET` | dev fallback   | Token signing secret             |
| `TAX_RATE`   | `0.08`         | Sales tax applied at checkout    |

## Project layout

```
server/
  src/
    db.js               schema + connection
    seed.js             demo users, categories, products
    middleware/auth.js  JWT verification and role guards
    routes/             auth, products, orders, reports, users
client/
  src/
    context/            auth state
    components/         layout, receipt, route guard
    pages/              login, checkout, my sales
    pages/admin/        dashboard, products, orders, staff
```

## API

All routes except `POST /api/auth/login` require a `Bearer` token.

| Method | Route                      | Role    |
| ------ | -------------------------- | ------- |
| POST   | `/api/auth/login`          | public  |
| GET    | `/api/auth/me`             | any     |
| GET    | `/api/products`            | any     |
| POST   | `/api/products`            | admin   |
| PUT    | `/api/products/:id`        | admin   |
| DELETE | `/api/products/:id`        | admin   |
| GET    | `/api/products/categories` | any     |
| POST   | `/api/orders`              | any     |
| GET    | `/api/orders`              | any\*   |
| GET    | `/api/orders/:id`          | any\*   |
| POST   | `/api/orders/:id/refund`   | admin   |
| GET    | `/api/reports/summary`     | admin   |
| GET    | `/api/users`               | admin   |
| POST   | `/api/users`               | admin   |
| DELETE | `/api/users/:id`           | admin   |

\* Cashiers are scoped to their own orders.

## Notes and limitations

- Payments are recorded, not processed — there is no real card gateway integration.
- Refunds are full-order only; partial refunds are not implemented.
- SQLite suits a single register well. Multi-location or high concurrency would
  want Postgres and a real payment provider.
