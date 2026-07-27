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
- **Dual currency (USD + LBP)** — totals shown in both; the customer can pay in
  dollars, pounds, or a mix of the two in one sale, and the cashier chooses which
  currency to give change in. The exact amount to hand back is shown for both.
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
- **Labels**: printable barcode and price labels for roll or A4 stock, in five
  built-in sizes or any size you type in, preloaded from a purchase invoice's
  received quantities
- **Documents**: quotations, sales orders, sales invoices and purchase invoices —
  a purchase invoice receives stock, a sales invoice issues it, and quotations
  convert through to invoices
- **Customers**: contacts with credit limits, running balances, a full ledger and
  recorded payments — sell on account straight from the register
- **Suppliers**: bills and payments made, so you can see what you owe
- Staff: `admin` / `cashier` accounts
- Settings: the USD→LBP exchange rate, the pound rounding step, a live preview
  and a full history of who changed the rate and when

Cashiers only see their own sales; admin routes are enforced server-side, not just
hidden in the UI.

## Stack

- **Frontend** — React 19, Vite, React Router, Tailwind CSS v4, lucide-react, axios
- **Backend** — Node, Express, JWT auth, bcrypt
- **Database** — SQLite via Node's built-in `node:sqlite` (file-based, no native
  build step and nothing to compile)

## Getting started

**Requires Node 24 or newer.** The database layer uses `node:sqlite`, which is
built into Node and only available unflagged from Node 24. `npm run setup`
refuses to start on an older version rather than failing part-way through.

```bash
node -v          # expect v24 or newer
```

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

## Dual currency

Products are priced in **US dollars only**. Lebanese pounds are derived from a
single exchange rate set in Admin → Settings, so there is one number to update
each morning and the two price lists can never drift apart.

- Every total is shown in both currencies, on the register, the payment sheet and
  the receipt.
- A sale can be settled with any mix of USD and LBP notes. The app converts the
  pound legs at the current rate and tells the cashier what is still due.
- Change is given in whichever currency the cashier picks, rounded to the
  configured step (1,000 LL by default — quoting to the single pound is
  meaningless).
- **The rate in force is stored on each order.** Changing the rate never
  retroactively alters past sales, so a receipt still reconciles months later.

| Route | Method | Role |
| ----- | ------ | ---- |
| `/api/settings` | GET | any (the register needs the live rate) |
| `/api/settings` | PUT | admin |
| `/api/settings/rate-history` | GET | admin |

## Documents

Quotations, sales orders, sales invoices and purchase invoices are one table with
different consequences. A document is **inert while it is a draft** — confirming
it is the moment stock moves and the ledger is posted.

| Type | On confirm |
| ---- | ---------- |
| Quotation | nothing — it is an offer |
| Sales order | nothing — it is a commitment |
| Sales invoice | stock out, customer billed (credit limit enforced) |
| Purchase invoice | **stock in**, supplier payable raised |

### Paying at the counter

Not everything is bought on credit. An invoice can be settled **on account**,
**paid in full**, or **part paid** — some now, the rest owing — by cash, card or
bank transfer, and a part payment can be entered in **pounds or dollars**.

Both halves are posted: the bill goes on the party's statement and the payment
comes straight off it. A delivery paid in cash therefore leaves the supplier's
balance at zero while still showing on their statement and in the day's cash
movements — which a document that quietly posted nothing never did. The credit
limit applies to what is actually left owing, so a customer with no credit can
still buy, as long as they pay for it.

- **Convert** a quotation to a sales order, and either to a sales invoice. Lines
  and figures carry over and the chain is recorded both ways.
- **Cancelling a confirmed document reverses everything it did** — stock back,
  ledger entry reversed.
- **Any document can be edited or deleted**, whatever its status. A draft is
  simply rewritten. A confirmed one is *undone and re-applied* in a single
  transaction: editing a purchase invoice from 10 units to 6 takes the ten back
  out of stock, puts six in, and rebills the supplier at the new total. If the
  new version cannot be applied — the goods have been sold on, the customer is
  over their limit — nothing changes at all.
- Corrections are **recorded, not hidden**. Both halves appear in the stock
  history and on the party's account, tagged `Edited PI-0007` or
  `Deleted PI-0007`, so a balance can always be traced back to what caused it.
- A document another was created from is kept until that successor is cancelled
  or deleted, so nothing is left pointing at a document that no longer exists.
- Lines may reference a product or be free text (delivery, labour), and free-text
  lines are skipped when stock moves.
- Purchase-invoice lines default to product **cost**; sales documents to price.
- Stock movements are written to the inventory ledger tagged with the document
  number, so a receipt is traceable from the product's history.

Numbers are sequential per type: `QT-0001`, `SO-0001`, `SI-0001`, `PI-0001`.

## Printing labels

Admin → **Labels**, or **Print labels** on a confirmed purchase invoice — which
preloads its lines with the quantities just received, since that is usually why
you are printing.

Each label carries the product name, the price in **both currencies**, a barcode
and its human-readable number. Printing hides the whole app so only the sheet
reaches the page.

Choose the stock first, because it decides the page:

- **Label printer** — one physical label is one page, and the page is sized to
  the label. Without this the whole run is squeezed onto the first label.
- **A4 label sheet** — a grid of die-cut labels on one page. Print at 100%
  scale; "fit to page" shifts the grid off the die-cut.

Five sizes are built in — 40×20, 38×21, 50×30, 63.5×34 and 70×42 mm — and
**Custom size…** takes any stock between 10×8 and 210×297 mm. Type sizes, the
barcode height and how many fit across a sheet are all derived from the
dimensions, so a size typed in is laid out as carefully as a built-in one.

**Barcodes are rendered by JsBarcode, not hand-rolled** — a subtly wrong barcode
scans as the wrong product. What the app decides is the *symbology*: a valid
EAN-13, UPC-A or EAN-8 is encoded as such, and anything else — an internal SKU, or
a code whose check digit is wrong — falls back to Code 128 so a label always
prints something scannable. A retail-length code with a bad check digit is
flagged in the UI rather than silently mis-encoded.

## Customers, credit and cash flow

One ledger records both sides of the book. Every entry carries a signed amount
where **positive always means outstanding** — a credit sale to a customer, a bill
from a supplier — and negative reduces it. A balance is therefore just the sum of
a party's entries, and the same query serves receivables and payables.

- Customers have a **credit limit**. An account sale is refused if it would push
  them over, and the check runs inside the sale's transaction so a concurrent
  sale cannot slip past it.
- Payments can be taken in **USD, LBP or both**, converted at the current rate.
- Refunding an account sale credits the customer back automatically.
- A party with an outstanding balance cannot be archived.
- New customers can carry an **opening balance**, so an existing paper book can
  be brought across on day one.
- The dashboard shows receivables, payables and the net position.

| Route | Method | Role |
| ----- | ------ | ---- |
| `/api/customers`, `/api/suppliers` | GET | any (the register picks customers) |
| `/api/customers/:id` | GET | any |
| `/api/customers`, `/api/suppliers` | POST / PUT / DELETE | admin |
| `/api/customers/:id/payments` | POST | admin |
| `/api/customers/:id/charges` | POST | admin |
| `/api/accounts/summary`, `/api/accounts/entries` | GET | admin |

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

## Shopify

Admin → **Shopify**. Sell an item on the website and it leaves the shelf here;
sell it at the counter and it leaves the website. Stock is the only thing
synced — prices, product copy and images stay wherever you edit them.

### Setup

In Shopify: **Settings → Apps and sales channels → Develop apps → Create an
app**, give it the scopes `read_products`, `read_inventory`, `write_inventory`
and `read_locations`, install it, and copy the Admin API access token. Paste
that and the shop address here, choose which **location** this till represents
— stock in a warehouse is then left alone — and press **Match by SKU**.

Matching is by SKU, then by barcode, and always exact. A fuzzy match on names
would eventually tie two different products together and quietly move the wrong
stock; anything it cannot place is listed so you can fix the SKU or link it by
hand.

### How it stays right in both directions

The hard part of two-way sync is deciding who wins when both sides have moved.
This never compares the two sides to each other. Each link remembers the
quantity Shopify held when the two last agreed, and both differences are
measured against *that*:

```
remote − remembered  → sold or restocked on Shopify   → applied here
local  − remembered  → sold or restocked here         → pushed there
```

So two sold at the counter and three on the website in the same minute ends at
five gone, not one side overwriting the other. Pushes set an absolute quantity
rather than a delta, so a sync that was missed while the internet was down still
lands on the right number afterwards instead of being wrong for ever.

Every stock change queues its own push — from a sale, a refund, a manual
adjustment or a purchase invoice — through a database trigger rather than a call
at each site, so a way of moving stock added later cannot forget to sync. The
push happens after the transaction commits: a slow Shopify must never hold up
the register.

A sale on Shopify appears in the product's own stock history, tagged
**Sold on Shopify**, not just in a sync log.

### When they disagree

Existing stock that has never matched is not silently overwritten. The page
lists what differs and asks which figure is right — after a stocktake the shop
is, after a rush of website orders Shopify is, and only you know which happened.
Settle them one at a time or all at once.

### Timing

Pushes go out every 15 seconds; the shop is polled every two minutes. Shopify
can also call `POST /api/shopify/webhook` to make a website sale appear in
seconds — the signature is verified with the app's own token. Polling stays on
regardless, since a shop behind a home router has no address Shopify can reach
and an undelivered webhook is simply never delivered.

Both intervals are configurable with `SHOPIFY_PUSH_INTERVAL_MS` and
`SHOPIFY_PULL_INTERVAL_MS`.

## Project layout

```
server/
  src/
    db.js                 schema, migrations, connection, transaction helper
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
- The Shopify sync covers **stock only**, against **one location**. Prices,
  product details and orders are not synced, and a Shopify product with several
  variants needs each variant linked to its own product here.
- The Shopify integration is tested against a stand-in shop that speaks the same
  API — see `server/test/fakeShopify.js`. That exercises every path including
  retries and conflicts, but the first connection to a real shop is still the
  real test; **Connect** reports Shopify's own error message so a wrong scope or
  token says so plainly.
