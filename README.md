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
  dollars, pounds, or a mix of the two in one sale, and change can go back the
  same way: all dollars, all pounds, or some of each. In a split the cashier
  names both piles and the sheet totals them against what is owed.
- Payment sheet: card, or cash with a numeric keypad and quick-cash amounts
- Change due surfaced prominently, plus a printable receipt
- **Hold a sale** and take the next customer, then pick it back up where it was
  left — the lines, the discount, the customer and the buyer's details all come
  back. Nothing is reserved, and whatever has been sold or archived meanwhile is
  reported on the way back in
- Keyboard shortcuts: `/` focuses search, `F2` charges, `F3` holds the sale,
  `F4` opens the shelf of held ones
- Stock decrements atomically as part of the sale, so it can't oversell

**The transfer counter** (needs the `transfers` permission)
- Send and pay out money for OMT, Whish, Western Union and the rest, with the
  reference, both sides' names and the fee kept — and **every one of them moving
  the drawer** so the till still counts right at the end of the day
- Expenses paid out of the same drawer, recorded from the same screen
- The day's takings split into money in, money out and fees earned, with the
  cashbox panel beside the work that moves it

**Vouchers** (needs the `vouchers` permission)
- Money moving **from one account to another**, both ends named: a till, a
  wallet, a customer, a supplier, or somebody typed in words like the landlord
- Out of the shop's own account is a **payment**, into one is a **receipt**, and
  between two of its own it is just money **moved**
- Each posts to both accounts and prints a numbered slip with two signature lines

**Back office**
- Dashboard: revenue hero figure, KPI tiles, a continuous daily-revenue column
  chart, top sellers, payment mix and restock alerts — all scoped by one date-range filter
- **Handsets tracked by IMEI** — tick "Track each one by IMEI" on a product and
  its stock becomes the individual devices booked in, each with its own cost and
  condition. The register makes the cashier pick which one is leaving, the sale
  records it, and `IMEI lookup` answers "did we sell this, when, and to whom"
  from the number on the box. Accessories stay quantity-tracked; both live in
  one catalogue.
- Inventory: stock levels with reorder points, value on hand, stock adjustments
  with reasons (received, damaged, theft, count correction, return, transfer),
  and a full movement ledger per product
- Import: bring a catalog over from **Shopify, Square, Lightspeed or any CSV**,
  with auto-detection, editable column mapping, a validated dry-run preview, and
  upsert-by-SKU
- Products: full CRUD with supplier, cost/margin, image URL, archive/restore, and
  **as many barcodes as the thing actually has** — scan them in one after another
- Orders: every cashier's sales with full refunds that restock items
- **Labels**: printable barcode and price labels for roll or A4 stock, in five
  built-in sizes or any size you type in, preloaded from a purchase invoice's
  received quantities
- **Cards**: recharge, validity and gift cards sold from a **wallet** instead of
  from stock — they never run out, and each sale spends what the card cost out
  of the credit the shop holds with that supplier. One press loads a ready-made
  Lebanese catalogue (Alfa and touch validity, whole recharge, iTunes, Google
  Play, PlayStation, Roblox, Steam)
- **Documents**: quotations, sales orders, sales invoices and purchase invoices —
  a purchase invoice receives stock, a sales invoice issues it, and quotations
  convert through to invoices
- **Customers**: contacts with credit limits, running balances, a full ledger and
  recorded payments — sell on account straight from the register
- **Suppliers**: bills and payments made, so you can see what you owe
- **Accounts**: cash accounts, wallets, customers and suppliers in one place,
  with who owes you and who you owe
- Staff: accounts with **per-person permissions** — seventeen sections that can be
  granted one by one, so somebody hired to run the transfer desk gets the
  transfer desk and nothing else
- Settings: the USD→LBP exchange rate, the pound rounding step, a live preview
  and a full history of who changed the rate and when

Cashiers only see their own sales; permissions are enforced server-side on every
request, not just hidden in the UI.

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

## Putting it live

Everything for this is in `deploy/`. The target is one small VPS — €4–6 a month
at Hetzner or DigitalOcean is plenty; this is a Node process and a file.

**Before you start, one thing worth knowing.** A till on a cloud server stops
selling when the shop's internet drops. If that is a real risk where the shop
is, the same setup runs on a mini PC at the counter with a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
in front of it — the counter keeps working offline, and it is still reachable
from anywhere. Nothing below changes except that the machine is in the shop.

### How it serves itself

In development Vite serves the pages on :5173 and forwards `/api` to Express on
:4000. In production there is no Vite: once `npm run build` has produced
`client/dist`, **the API server serves the built app itself**, so there is one
process on one port. nginx sits in front of it for HTTPS, and for nothing else.

Assets are cached for a year — Vite hashes their filenames, so a given asset can
never change. `index.html` is sent `no-cache`, because it is the file that names
the current assets and a cached copy is a till permanently stuck on the last
deploy.

### First time

```bash
# On the server, as root
adduser --system --group --home /srv/pos pos
apt update && apt install -y nginx git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs

git clone https://github.com/walidframa/your_first_code /srv/pos
chown -R pos:pos /srv/pos

# The books live outside the checkout, so a deploy can never touch them
mkdir -p /var/lib/pos /var/backups/pos
chown pos:pos /var/lib/pos /var/backups/pos

# Settings and the two secrets
cp /srv/pos/deploy/pos.env.example /etc/pos.env
chown pos:pos /etc/pos.env && chmod 600 /etc/pos.env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # twice
nano /etc/pos.env          # paste one into JWT_SECRET, the other into ACCOUNT_SECRET

# Build, seed, and start
cd /srv/pos && sudo -u pos npm run setup && sudo -u pos npm run build
cp deploy/pos.service /etc/systemd/system/pos.service
systemctl daemon-reload && systemctl enable --now pos

# HTTPS on your own domain
cp deploy/nginx.conf /etc/nginx/sites-available/pos
sed -i 's/pos.example.com/YOUR-DOMAIN/' /etc/nginx/sites-available/pos
ln -sf /etc/nginx/sites-available/pos /etc/nginx/sites-enabled/pos
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx && certbot --nginx -d YOUR-DOMAIN
```

Then **change the demo passwords immediately** — `admin` / `admin123` on a public
address is an open shop.

### Every update after that

Edit locally, push to `main`, then on the server:

```bash
cd /srv/pos && ./deploy/deploy.sh
```

That backs up the database, fast-forwards to `origin/main`, installs, rebuilds
the client, restarts the service and then **waits until the app answers** before
saying it worked — a deploy that finished is not the same as a shop that is
serving. It refuses to run if somebody has edited files directly on the server,
rather than pulling over their work or throwing it away.

It is a command you choose to run rather than something that fires on every
push, because a restart drops whoever is mid-sale back to a loading screen, and
that should be somebody's decision rather than a side effect of a merge.

Schema changes need no separate step: the database migrates itself on boot.

### Backups

The whole shop is one SQLite file. `deploy/backup.sh` takes a consistent
snapshot of it — using SQLite's own backup rather than `cp`, which on a live
WAL database can produce a file that will not open. `deploy.sh` runs it before
every deploy; run it nightly too:

```
0 2 * * * /srv/pos/deploy/backup.sh >> /var/log/pos-backup.log 2>&1
```

Set `BACKUP_SYNC` in `/etc/pos.env` to somewhere off the machine. A backup on
the same disk as the database is a second copy of the same disk failure.

**Back up `ACCOUNT_SECRET` separately, somewhere that is not this server.** The
customer account passwords are encrypted with it, and a database restored
without it is a database with those passwords gone for good.

### When something is wrong

```bash
systemctl status pos          # is it running
journalctl -u pos -f          # what it is saying
journalctl -u pos -n 100      # what it said before it stopped
curl localhost:4000/api/health
```

The commonest cause of a service that will not start is a missing or too-short
`JWT_SECRET` or `ACCOUNT_SECRET` — in production the server refuses to run
rather than come up insecure, and says which one in the log.

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
| `ACCOUNT_SECRET` | —        | Encrypts stored customer account passwords |

**`JWT_SECRET` is required in production.** With `NODE_ENV=production` the server
refuses to start unless it is set to at least 32 characters. In development an
ephemeral random secret is generated per process (with a warning), so sessions do
not survive a restart until you set one.

**`ACCOUNT_SECRET` is required to keep customer account passwords** (the iCloud
or Gmail the shop set up for a buyer). It is deliberately separate from
`JWT_SECRET`: one is rotated when a session leaks and the other must not be, and
sharing them would make every stored password unreadable the moment you rotated
either. Without it, development uses a per-process key so anything saved stops
being readable on restart — a nuisance on purpose. In production the server
refuses to start.

## Individually identified stock

A phone shop does not sell seven interchangeable iPhone 13s. It sells *this*
handset — bought at its own price, in its own condition, and traceable to the
customer who walked out with it. A quantity cannot answer "who has IMEI 35…?"
or "what did that one actually cost me?".

Tick **Track each one by IMEI** on a product and it changes how it is counted:

- Stock is no longer typed. It is the number of handsets booked in and not yet
  sold, recounted from the units themselves so the two can never drift apart.
- **Book in** takes a list of handsets, one per line, with a condition and a cost
  — spaces and dashes are stripped so they can be typed straight off the box. A
  batch containing a number already known is refused whole rather than half kept.
- **Dual-SIM phones carry two IMEIs.** Put both on the line separated by a comma
  or a slash (`3599…441, 3599…449`); a space cannot be the separator because
  spaces appear *inside* a single IMEI as printed. Either number finds the
  handset — at a counter the customer reads whichever one they can see, and
  asking which SIM slot it belongs to would be a strange question. A number is a
  number: it cannot be IMEI 1 of one phone and IMEI 2 of another.
- The register will not let a serialised product into the cart as a quantity: it
  asks which handset, and the cart line shows the IMEI going out of the door.
- The sale records the unit and **its** cost, so margin is per device rather than
  a shelf average.
- Refunding puts the handset back as *returned* rather than *in stock* — one
  that has been out of the shop and come back is not the same proposition as one
  still in its box, and whoever sells it next should be told. It is still
  sellable.
- `GET /api/units/lookup?imei=…` answers the counter question: did we sell it,
  when, on which order, and to whom. Any signed-in user can ask, because
  refusing a cashier the ability to check a warranty would defeat the point.

**Handsets are booked in on the supplier's purchase invoice**, which is where a
delivery actually arrives. A serialised line on a purchase invoice grows an IMEI
box with a live "3 of 5 handsets" counter; confirming the invoice creates the
units at the price on the line, and the count must match the quantity or the
invoice will not confirm. Deleting a delivery removes the handsets it brought in
— unless one has already sold, in which case it is refused rather than leaving a
sale pointing at a phone the shop has no record of receiving.

## Selling a phone

A handset sale carries more than a line and a price.

- **The buyer's name and number** sit on the order. Most buyers never become a
  customer account — they walk in, buy a phone and leave — but months later
  somebody has to be able to ring them about a warranty.
- **Gifts.** Any cart line can be marked a gift: it costs the customer nothing
  and is not revenue, but the stock still moves, because the case really did
  leave the shop. Counting it at full price would flatter the margin on every
  handset sold with something in the box.
- **iCloud / Gmail the shop set up.** Recorded against the sale and the handset,
  so when the customer comes back having forgotten it, the counter can find it
  by IMEI, by account name, or by the buyer's own name or number.

Those passwords are **encrypted at rest** (`ACCOUNT_SECRET`, AES-256-GCM). A
copy of the database file is otherwise a list of live logins — a backup on a
laptop, a stolen machine. Searching returns the account names only; reading one
password is a separate, deliberate request needing the **`secrets`** permission,
so a screen of twenty customers is not twenty passwords on display behind the
counter.

| Route | Method | Needs |
| ----- | ------ | ----- |
| `/api/held-accounts?q=` | GET | any signed-in user |
| `/api/held-accounts/:id/password` | GET | `secrets` |

## Warranty, repairs and trade-ins

**Warranty** is the shop's own promise, not the manufacturer's. A product carries
the policy ("all our phones, six months") and the figure is **copied onto the
handset when it sells**, so shortening the policy tomorrow cannot quietly shorten
cover somebody is already holding. Months, not days: a shop says six months, and
adding 180 days would end the cover on a different date than the customer was
told. No warranty and an expired one are different answers, and the lookup gives
both.

**Repairs.** A device comes in, and the ticket is the record of it: what it was,
in what state, what was wrong, what was done and what it cost.

- Typing the IMEI at intake links the ticket to the handset if the shop sold it,
  and answers the warranty question **before** the price conversation starts.
  A phone the shop never sold is still taken in, described in words.
- **The condition it arrived in** is written down in the customer's presence and
  printed on their ticket. The scratch that was already there is only "already
  there" if it was recorded before the phone went behind the counter.
- The passcode is encrypted like any other credential the shop is trusted with;
  a technician can be given it, but a screen listing every phone in the shop
  does not also list how to unlock them.
- **Parts come out of stock when they are fitted**, not when the job is invoiced
  — the screen has left the drawer either way, and waiting would let the shop
  sell one it no longer has. Taking a part back off returns it.
- Statuses are not a strict pipeline; a job goes back to *awaiting parts* as
  often as it goes forward. Every move is on the ticket's history, so "when did
  you say it was ready?" has an answer.
- **Collection happens at the register**, not by editing a status, so the money
  reaches the drawer and the close still balances. A warranty job collects at
  nothing to pay — which is the whole point of having recorded the warranty.

**The ticket prints on the receipt printer.** One narrow column of plain text at
72mm, no rules or shading, sized to thermal roll and left to run as long as the
job needs.

**Trade-ins** (admin → Trade-ins) are the mirror of a sale: money out of the drawer, a handset onto
the shelf at the grade and price agreed across the counter. It becomes an
ordinary unit from that moment — it sells, costs and reports like any other, with
its margin against what the shop actually paid. The cash-out is recorded, because
a trade-in paid from the register and not recorded is a shortfall nobody can
explain at close.

| Route | Method | Role |
| ----- | ------ | ---- |
| `/api/repairs` | GET, POST | any signed-in user |
| `/api/repairs/:id` | GET, PATCH | any signed-in user |
| `/api/repairs/:id/parts` | POST | any signed-in user |
| `/api/repairs/:id/collect` | POST | any signed-in user |
| `/api/repairs/:id/passcode` | GET | `secrets` |
| `/api/repairs/warranty/:imei` | GET | any signed-in user |
| `/api/repairs/trade-ins` | POST | any signed-in user |
| `/api/repairs/trade-ins/list` | GET | `repairs` |

**Customer accounts** has its own screen, and it is *not* an admin one: handing
somebody back the iCloud the shop set up for them is counter work, so whoever is
at the counter can search. One box takes whatever the customer remembers — the
IMEI off the phone, the account name, their own name, the number they called
from. The password still takes an admin, and a cashier is told so rather than
shown a dead button.

Accessories, parts and recharge cards stay quantity-tracked — nobody serialises
a screen protector — so the two kinds of stock sit side by side in one
catalogue. Switching a product between them is only allowed from zero stock with
no units booked in; either way round, the shelf and the record would otherwise
part company.

| Route | Method | Role |
| ----- | ------ | ---- |
| `/api/units/lookup?imei=` | GET | any signed-in user |
| `/api/units/product/:id` | GET | any signed-in user |
| `/api/units/product/:id` | POST | `inventory` |
| `/api/units/:id` | PATCH, DELETE | `inventory` |


## Who can do what

Two roles were enough while the shop was one counter. They stop being enough the
moment somebody is hired to run one part of it, because "cashier" then means
either too little to do the job or the run of the whole back office.

So the role is the coarse answer and permissions are the fine one:

- **Admin** is the owner. They pass every check by definition — there are no
  boxes to tick, and none to accidentally untick.
- **Staff** hold exactly what they have been given, in Admin → **Staff** →
  **Access**: seventeen permissions grouped as Selling, Money, Stock and Setup.

The same list drives both sides. The navigation rail only shows the sections
someone can reach, and the server refuses everything else whether or not they
find the address — a cashier typing `/admin/inventory` lands back on the
register.

Permissions are read from the database on every request rather than carried in
the session token, so **taking one away takes effect on the next click**, not
whenever the login happens to expire.

New accounts start with their role's defaults — a cashier gets the register and
nothing more. It is easier to hand somebody the transfer desk on their first
morning than to discover a month later that everyone hired since could edit
prices.

## The money transfer counter

Most phone shops in Lebanon are an OMT or Whish agent as well, and that is a
different trade running out of the same drawer. It is not selling: nothing
leaves the shelf, and the money handed over is not the shop's. What the shop
keeps is the fee.

Which is exactly why it belongs in the app rather than in a notebook. Every one
of these moves cash in or out of the till, and a drawer counted at the end of a
day with thirty unrecorded transfers in it will never agree with anything.

**Transfers** (in the rail, for anyone with the permission) records:

- a **send** — the customer hands over the amount and the fee, so the drawer
  goes **up** by both
- a **payout** — the shop counts the amount out, keeping any fee, so the drawer
  goes **down** by the difference

with the company, the reference number, both sides' names, the phone and ID
number, and a note. Dollars and pounds move separately and are never converted:
a transfer is sent in one currency or the other, not in a rate-dependent figure.

The drawer sits on the same screen, because an operator who has to go and look
somewhere else for the till figure will not look — and that is the one number
this screen exists to protect. **Expenses** paid out of the counter go through
the same button, so the water, the generator subscription and the delivery come
off the till like everything else instead of turning into a shortfall somebody
gets blamed for.

Cancelling a transfer puts the money back with an opposite movement and keeps
the row: a drawer that was briefly wrong is part of what happened, and a
cancelled transfer somebody has to explain to the company is exactly the one
worth keeping.

## Accounts

Four kinds of account, and what a balance means is different for each:

| Type | The balance is |
| --- | --- |
| **Cash accounts** | what is actually in that till, dollars and pounds apart |
| **Wallets** | credit held with a supplier, in that wallet's own currency |
| **Customers** | what they owe the shop |
| **Suppliers** | what the shop owes them |

**Admin → Accounts** lists all four with their balances, and answers the two
questions the balances exist for — **who owes you** and **who you owe** —
without opening anything. Customers, suppliers and wallets are managed on their
own screens; a **cash account** has no screen of its own, so it is created,
renamed and put away here.

The registry is deliberately a view rather than a table. Each kind keeps the
storage that suits it — a customer has a credit limit and a ledger, a till has
sittings and a count — and one shape is laid over the top so a picker can offer
all four.

### More than one till

One drawer was enough while there was one counter. It stops being enough the
moment the transfer desk runs its own float and a safe sits in the back: three
piles of money, counted by different people at different times.

So a till is a named account, and **sittings and movements belong to one**. The
transfer desk can close and count at six while the register is still trading,
and each drawer is right or wrong on its own. The **Transfers** screen picks
which till it works from and remembers it; a voucher names the till on each end;
everything else — sales, expenses, documents — uses the default one, which is
the drawer that was always there.

## Payment and receipt vouchers

Every movement of money that is neither a sale nor a purchase order: wages,
rent, an owner putting money in, a supplier settled in cash, a customer paying
off what they owe, credit bought for a wallet. A shop that only records selling
ends the day with a drawer nobody can explain.

A voucher names **both ends**. That is the whole idea: money never simply
appears or vanishes, it leaves one account and arrives at another, and until
both are written down somebody has to remember which drawer it came out of.

Either end can be one of the shop's own accounts (a till, a wallet) or somebody
else's (a customer, a supplier, a name typed in words — creating a contact
record for the man who fixes the generator is not worth anybody's time). Which
makes the kind of voucher a consequence rather than a choice:

| From | To | It is a |
| --- | --- | --- |
| the shop's own | somebody else's | **payment** — `PV-0001` |
| somebody else's | the shop's own | **receipt** — `RV-0001` |
| the shop's own | the shop's own | **transfer** — `TV-0001` |

A transfer counts in neither total: the money did not leave, and showing it as
both would double the day.

Which way a party's balance moves follows one rule:

- A customer's balance is what they owe the shop. Paying them makes them owe
  more; being paid makes them owe less.
- A supplier's balance is what the shop owes them. Paying them makes the shop
  owe less; being refunded by them makes it owe more.
- A wallet is credit, so paying one buys credit and being paid by one takes it
  back out.

Each one **prints a slip with two signature lines**, because a voucher is a
piece of paper before it is a row: the person handed the money signs to say they
took it.

Cancelling reverses both ends at once and keeps the row. The number was on
something somebody signed, so it is never reused.

## Recharge and gift cards

A recharge card is not stock. Nothing comes out of a box when one sells: the
shop holds credit with Alfa, with touch, with whoever supplies its iTunes codes,
and every sale spends a little of it. So these products are sold from a
**wallet** rather than from a shelf.

Set up in Admin → **Cards**:

- A **wallet** is credit held with one supplier — its balance is the sum of
  every movement against it, so it can be checked against the supplier's own
  statement rather than trusted. Top it up when you pay them.
- A **card** is a product pointed at a wallet. That one link is what makes it a
  card: it has no stock to run out of, and its cost comes off the wallet each
  time it sells. Margin still reaches the books the ordinary way, because the
  line keeps the cost that was true when it sold.

**Load the Lebanese starter set** fills the catalogue in one press: Alfa and
touch validity at the usual counter prices, whole recharge, and the common gift
cards, split into `Recharge`, `Whole Recharge` and `Gift Cards` sections that
show up as tabs on the register. It is idempotent — press it twice and nothing
duplicates. Each card is seeded with **cost equal to price**, so every margin
reads "Set the cost" until you put your dealer price in; a guessed discount
would report a margin nobody earned.

Buying credit on a **purchase invoice** works too: a card line on a delivery
tops its wallet up by what was paid instead of adding a meaningless quantity,
and cancelling the invoice takes it back off.

One deliberate choice: **a wallet is allowed to go negative.** A cashier facing
a customer cannot fix a supplier balance, and a card that has been handed over
is sold whatever the ledger says — so the sale goes through and the overdraft is
shown in red on the wallet and on the register tile. It is a bill to settle, not
a sale to lose.

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
- **Change is always two fields**, dollars and pounds, side by side from the
  moment there is change to give. There is no currency to choose first: a
  drawer rarely holds enough of either note to settle up cleanly in one, and
  which it is short of is not known until the till is open. What the customer
  gets is simply the two figures added together, shown against what is owed and
  labelled exact, short or over.
- **The pile the cashier has not named follows the one they have**, live. Change
  of $27.87 with "here's $25" typed into the dollars shows 255,000 LL beside it,
  updating on every keystroke and marked *suggested* so it is clear which figure
  is the till's. Type the pounds instead and the dollars follow. **All dollars**
  and **All pounds** are one-tap shortcuts, not modes — both figures stay on
  screen either way.
- Touching both stops the suggestion. Which notes are actually in the drawer is
  something only the cashier can see — 2,500,000 LL may be four notes where the
  exact remainder is seven — so two deliberate figures are left alone and the
  sheet reports the difference instead of overwriting either. **Let the till
  fill this** hands a field back, and it stays live from then on.
- Landing a little either side of the exact change is normal when rounding to
  real notes and is recorded as given, so it shows up in the drawer at close
  rather than being smoothed away. Handing back far more than is owed — a
  slipped digit — is refused.
- **The rate in force is stored on each order.** Changing the rate never
  retroactively alters past sales, so a receipt still reconciles months later.

| Route | Method | Role |
| ----- | ------ | ---- |
| `/api/settings` | GET | any (the register needs the live rate) |
| `/api/settings` | PUT | `settings` |
| `/api/settings/rate-history` | GET | `settings` |

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

## Barcodes

**A product can have as many barcodes as the thing on the shelf actually has.**
The maker's EAN is on the box, the distributor sticks their own label over it,
the shop prints a third for loose stock, and the same charger arrives from a
second supplier with a fourth. Whichever one is facing up when the scanner goes
off finds the product.

This matters more than it sounds. With one barcode per product, the way a shop
works around the second number is to create a second product — and then the
stock of one thing is split across two rows, and every count, every restock
alert and every profit figure is wrong.

In the product form, scan into the barcode box and press Enter (which a scanner
does for you); scan again and the next one lands beside it. Backspace on an
empty box removes the last. Scanning the same box twice adds one, not two.

The **starred** one is the primary: the number printed on a label and pushed to
Shopify. Any of the others can be promoted to it. A code that already belongs to
a different product is refused by name — a scan that could mean two things is
not a scan, and the counter is the worst place to find that out.

`products.barcode` is still there and still holds the primary, so labels,
Shopify and the CSV importer are unchanged. It is written in exactly one place
(`server/src/lib/barcodes.js`) so it cannot drift from the list. A CSV naming
one barcode sets the primary and **leaves the ones the shop added by scanning**
— losing those to a routine catalogue refresh would quietly make half the shelf
unscannable.

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
| `/api/customers`, `/api/suppliers` | POST / PUT / DELETE | `parties` |
| `/api/customers/:id/payments` | POST | `parties` |
| `/api/customers/:id/charges` | POST | `parties` |
| `/api/accounts/summary`, `/api/accounts/entries` | GET | `parties` |

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

## The cashbox

The register's drawer is opened at the start of a sitting and closed with a
count at the end. **A cash sale is refused while it is shut** — a till that can
take money with nowhere to put it cannot be counted, which is the whole point.
Card and account sales are unaffected, and the requirement can be turned off
with the `require_cash_session` setting.

**Opening** asks what is already in the drawer — yesterday's carried-over change,
or petty cash put in now.

**During the sitting**, everything that moves real money is recorded against it:
cash sales (what stayed in the drawer, not what was handed over), refunds,
customers settling accounts, suppliers paid from the till, invoices marked paid
in cash, and **Cash in / Cash out** by hand with a reason — petty cash, an
expense, wages, the owner taking money out, a run to the bank. Reasons come from
a fixed list so a month's spending can actually be added up.

**Closing counts the drawer against the app.** Count it note by note, or type
the total straight in — plenty of shopkeepers counted it on the counter before
opening the app, and making them enter it again a denomination at a time is how
a count gets rushed. Either way it is the same figure, and counting notes fills
the total in.

For a cashier it is a **blind count**: the expected figure is withheld until the
count is submitted, because told the answer first a tired cashier writes it down
whether the money is there or not. Anyone with the `cashbox` permission already
sees that figure on the panel behind the dialog, so for them the difference is
shown **as they type**: each currency on its own, and then **altogether** — the
pounds converted at the rate and added to the dollars, because "am I short" is
one question about a drawer holding both. The per-currency figures are what get
recorded; the combined one is a reading. Whatever is not left as tomorrow's
float is recorded as going to the bank.

Dollars and pounds are counted side by side and never converted into one
another: a drawer is right or wrong in each currency independently, and folding
them together would make yesterday's correct count look short as soon as the rate
moved. Change given in the other currency is handled properly — a $20 note for a
$3 sale with change in pounds leaves the drawer twenty dollars heavier and its
pounds lighter, and both are recorded. Change split across both currencies comes
out of both piles for the same reason.

Admin → **Cashbox** lists every sitting with what it was out by, and opens the
report.

### The cashbox report

One sitting of one till, start to finish: the count against what the app
expected, in each currency and altogether; what moved through the drawer by
kind; the sitting's sales by payment method; and every individual movement. It
is offered the moment the drawer is closed — that is when somebody wants it —
and again from Admin → Cashbox for any past sitting.

**Download PDF** produces an A4 page to file, print or send on. The file is
drawn by the server rather than by the browser's print dialog, so it is the same
document however it was asked for and the shop's receipt printer being set to
72mm rolls does not decide what a report looks like. It has no dependency behind
it — see `server/src/lib/pdf.js`. The one limit: the standard PDF fonts are
Latin, so Arabic text is printed as `?` and the page says so rather than
silently mangling it.

The report is readable by anyone with the `cashbox` permission, plus whoever
actually sat at that till — a cashier who has just counted the drawer can print
what they signed off without also being handed every other sitting in the shop.
**Profit is on the report only for whoever holds `reports`**, in the PDF as well
as on screen: a permission that a download walks around is not a permission.

### Profit on the register

Above the drawer on the register sits **what the shop has made since the till
was opened** — sold, cost of goods, gross and net. It is a different question
from cash on hand, which includes the float, customer payments and money that is
not the shop's to keep, and the two get read for each other all day.

It needs the `reports` permission, which in practice means the owner. A cashier
is not shown a blanked-out box; the server does not send the figure at all. It
is the shop's whole trade over the hours the till was open, not that one
drawer's — profit is made on the sale, not on the till the cash landed in —
which is why it is shown on the register and not over the transfer desk.

## Expenses and profit

**Expenses** is the money that keeps the doors open — rent, wages, electricity,
the van's fuel — none of which appears on an invoice. Categories are a fixed
list so a month's spending can be compared with last month's rather than read.

An expense **paid in cash comes out of the open cashbox**, so the drawer still
counts right at close. One that would empty a drawer it was never in is refused,
with the suggestion to record it as paid by bank instead.

**Profit** answers three questions in order:

```
revenue        what was sold for
− cost         what those goods cost to buy    → gross profit
− expenses     what it cost to keep open       → net profit
```

Reported for **today, this week, this month, this year, any two dates, or one
sitting of the cashbox**. Expenses can be switched off, because gross profit
says whether the pricing works and net profit says whether the shop does — two
different questions, both worth asking.

**Cost comes from the figure stored on each sold line**, not from what the
product costs today. Otherwise a supplier raising a price next week would
quietly rewrite last month's profit. Lines sold before this was recorded have no
cost to subtract, and the report says how many rather than quietly reporting a
figure that is too good.

Refunded orders are left out of revenue entirely rather than netted off: an
order that was refunded did not happen, and counting it twice would distort the
average sale.

## What an item did

Products → the history button on any row. Sales, deliveries, stock corrections
and every cost change, in one list in order — because the useful question is
usually "what happened around the time the margin moved", and that only answers
itself when purchases and cost changes sit in the same column.

Cost changes are recorded when the cost is edited **and when a delivery arrives
at a different price** — a purchase invoice updates the product's cost and keeps
the old figure on the record, so the margin's movement can be explained later.

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
    lib/permissions.js    what each member of staff may do
    lib/transfers.js      the money transfer counter
    lib/vouchers.js       money moving between two accounts
    lib/cashAccounts.js   the shop's tills
    lib/registry.js       all four kinds of account in one shape
    lib/heldSales.js      sales put to one side
    lib/cashReport.js     one sitting of one till, as data and as a page
    lib/pdf.js            a very small PDF writer — no dependency
    middleware/auth.js    JWT verification, role and permission guards
    routes/               auth, products, orders, reports, users, inventory, imports
client/
  src/
    components/ui/        design-system primitives (Button, Modal, ModalActions, Toast, …)
    components/BarcodeField.jsx  scan one barcode after another onto a product
    components/charts.jsx dashboard charts
    context/              auth state
    pages/                login, register, my sales
    pages/admin/          dashboard, products, inventory, import, orders, staff
```

## API

All routes except `POST /api/auth/login` require a `Bearer` token.

Routes are guarded by **permission**, not by role — an admin holds all of them.

| Method | Route                          | Needs        |
| ------ | ------------------------------ | ------------ |
| POST   | `/api/auth/login`              | public       |
| GET    | `/api/auth/me`                 | any          |
| GET    | `/api/products`                | any          |
| GET    | `/api/products/lookup?code=`   | any          |
| POST   | `/api/products`                | `catalogue`  |
| PUT    | `/api/products/:id`            | `catalogue`  |
| DELETE | `/api/products/:id`            | `catalogue`  |
| GET    | `/api/products/categories`     | any          |
| POST   | `/api/orders`                  | `register`   |
| GET    | `/api/orders`                  | any\*        |
| GET    | `/api/orders/:id`              | any\*        |
| POST   | `/api/orders/:id/refund`       | `refunds`    |
| GET    | `/api/accounts/registry`       | any          |
| POST   | `/api/accounts/cash`           | `cashbox`    |
| PUT    | `/api/accounts/cash/:id`       | `cashbox`    |
| DELETE | `/api/accounts/cash/:id`       | `cashbox`    |
| GET    | `/api/vouchers`                | `vouchers`   |
| GET    | `/api/vouchers/meta`           | `vouchers`   |
| POST   | `/api/vouchers`                | `vouchers`   |
| POST   | `/api/vouchers/:id/cancel`     | `vouchers`   |
| GET    | `/api/transfers`               | `transfers`  |
| POST   | `/api/transfers`               | `transfers`  |
| POST   | `/api/transfers/:id/cancel`    | `transfers`  |
| GET    | `/api/expenses`                | `expenses`   |
| POST   | `/api/expenses`                | `expenses`   |
| GET    | `/api/cash/current`            | any          |
| POST   | `/api/cash/open`, `/close`     | any          |
| GET    | `/api/cash/sessions`           | `cashbox`    |
| GET    | `/api/cash/sessions/:id/report`     | `cashbox`, or having sat at that till |
| GET    | `/api/cash/sessions/:id/report.pdf` | `cashbox`, or having sat at that till |
| GET    | `/api/held-sales`              | `register`   |
| POST   | `/api/held-sales`              | `register`   |
| POST   | `/api/held-sales/:id/resume`   | `register`   |
| DELETE | `/api/held-sales/:id`          | `register`   |
| GET    | `/api/reports/summary`         | `reports`    |
| GET    | `/api/inventory`               | `inventory`  |
| POST   | `/api/inventory/adjust`        | `inventory`  |
| GET    | `/api/wallets`                 | any          |
| POST   | `/api/wallets`, `/:id/…`       | `cards`      |
| POST   | `/api/imports/preview`,`commit`| `imports`    |
| GET    | `/api/users`                   | `users`      |
| GET    | `/api/users/permissions`       | `users`      |
| POST   | `/api/users`                   | `users`      |
| PUT    | `/api/users/:id/permissions`   | `users`      |
| DELETE | `/api/users/:id`               | `users`      |

\* Cashiers are scoped to their own orders.

## Notes and limitations

- Payments are **recorded, not processed** — there is no card gateway integration,
  so this cannot take real money without connecting a provider such as Stripe.
- Refunds are full-order only; partial refunds are not implemented.
- Transfer fees are counted on the transfer screen but are not yet folded into
  the Profit page, which still reports margin on goods sold.
- A card wallet can go **negative** — see above; that is deliberate, but nothing
  stops it, so the balances need reading rather than assuming.
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
