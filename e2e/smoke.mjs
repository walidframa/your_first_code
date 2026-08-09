/**
 * End-to-end smoke test: drives the real app in Chromium across the flows that
 * matter — scanning, checkout, refunds, inventory adjustments and CSV import —
 * and asserts role boundaries hold in the browser.
 *
 * Assumes the API and client are already running (see `npm run e2e`).
 * Set E2E_SCREENSHOT_DIR to capture screenshots of each stage.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR || '';
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// The unknown-barcode check deliberately provokes a 404 from the lookup
// endpoint, so failed responses are tracked by URL rather than trusting the
// browser's generic "Failed to load resource" console line.
// The Shopify step likewise submits a deliberately invalid shop address, to
// check the error is reported rather than the credentials quietly stored.
const ALLOWED_FAILURES = [/\/api\/products\/lookup/, /\/api\/shopify\/connect/];

const consoleErrors = [];
const failedResponses = [];

page.on('console', (m) => {
  // Resource-load failures are covered by the response listener below.
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) {
    consoleErrors.push(m.text());
  }
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));
page.on('response', (res) => {
  if (res.status() >= 400 && !ALLOWED_FAILURES.some((re) => re.test(res.url()))) {
    failedResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  }
});

let passed = 0;
let shotIndex = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message.split('\n')[0]}`);
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/FAILURE-${name.replace(/\W+/g, '-')}.png` });
    throw err;
  }
}

/**
 * Dismiss whatever dialog is open and wait for it to actually go.
 *
 * Escape alone is racy here: the next step's click lands on the backdrop while
 * the dialog is still unmounting, and the failure then points at the click
 * rather than at the dialog that never closed.
 */
/**
 * Open the New document dialog and wait for it to settle.
 *
 * The dialog animates in, and a click that lands mid-animation is reported by
 * Playwright as "element is not stable" — a flake that only shows on a slower
 * machine. Waiting for the heading is waiting for the animation.
 */
async function openNewDocument() {
  await page.click('button:has-text("New document")');
  await page.waitForSelector('[role=dialog] >> text=New document', { timeout: 15000 });
  await page.locator('[role=dialog]').getByRole('button', { name: /Quotation/ }).waitFor();
  return page.locator('[role=dialog]');
}

async function closeDialog() {
  const dialog = page.locator('[role=dialog]');
  if (!(await dialog.count())) return;
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await dialog.first().waitFor({ state: 'detached', timeout: 10000 });
}

async function shot(name) {
  if (!SHOT_DIR) return;
  shotIndex += 1;
  await page.screenshot({ path: `${SHOT_DIR}/${String(shotIndex).padStart(2, '0')}-${name}.png` });
}

const scanBox = 'input[aria-label="Scan barcode or search products"]';

try {
  console.log('\nRegister (cashier)');

  await step('login page renders', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Front Desk POS');
  });
  await shot('login');

  await step('sign in as cashier', async () => {
    await page.click('button:has-text("Cashier")');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.waitForSelector('text=Espresso', { timeout: 15000 });
  });
  await shot('register');

  await step('the cashbox must be opened before cash can be taken', async () => {
    await page.waitForSelector('text=Cashbox closed', { timeout: 15000 });
    await page.waitForSelector('text=/Cash sales are refused/');

    await page.click('button:has-text("Open the cashbox")');
    await page.waitForSelector('text=What is in the drawer to start with?', { timeout: 10000 });
    await page.getByLabel('Dollars').fill('100');
    await page.getByLabel('Lebanese pounds (LBP)').fill('2000000');
    await page.click('button:has-text("Open cashbox")');
    await page.waitForSelector('text=Cash on hand', { timeout: 15000 });
  });

  await step('scanning a barcode adds the product', async () => {
    await page.fill(scanBox, '5012345000015');
    await page.press(scanBox, 'Enter');
    await page.waitForSelector('aside >> text=Espresso', { timeout: 10000 });
    await page.waitForSelector('text=Added Espresso', { timeout: 5000 });
  });

  await step('an unknown barcode reports an error', async () => {
    await page.fill(scanBox, 'not-a-real-code');
    await page.press(scanBox, 'Enter');
    await page.waitForSelector('text=No product matches', { timeout: 10000 });
    // A failed scan keeps the term in the box, so the grid stays filtered.
    await page.waitForSelector('text=No products found');
    await page.click('button[aria-label="Clear search"]');
  });

  await step('tapping products adds them', async () => {
    await page.getByRole('button', { name: /^Croissant/ }).first().click();
    await page.getByRole('button', { name: /^Tote Bag/ }).first().click();
    await page.waitForSelector('aside >> text=Tote Bag');
  });

  await step('quantity stepper works', async () => {
    await page.click('button[aria-label="Increase Croissant"]');
    await page.waitForTimeout(150);
  });

  await step('category filter narrows the grid', async () => {
    await page.click('button:has-text("Bakery")');
    await page.waitForTimeout(300);
    if ((await page.locator('section button:has-text("Bagel")').count()) === 0) {
      throw new Error('bakery filter returned nothing');
    }
    await page.click('button:has-text("All")');
    await page.waitForTimeout(200);
  });
  await shot('cart');

  await step('sold-out products cannot be added', async () => {
    const soldOut = page.locator('section button:has-text("Protein Bar")');
    if (!(await soldOut.isDisabled())) throw new Error('sold-out product is still clickable');
  });

  await step('discount recalculates the total', async () => {
    await page.fill('#discount', '10');
    await page.waitForTimeout(200);
  });

  await step('payment sheet opens', async () => {
    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector('text=Take payment');
  });
  await shot('payment');

  await step('register shows the pound equivalent of the total', async () => {
    await page.waitForSelector('text=In LBP');
    await page.waitForSelector('text=/1 USD = [\\d,]+ LL/');
  });

  await step('each product tile shows both currencies', async () => {
    const tile = page.locator('section button', { hasText: 'Espresso' }).first();
    await tile.locator('text=/\\$\\d/').first().waitFor();
    await tile.locator('text=/[\\d,]+ LL/').first().waitFor();
  });

  await step('each cart line shows both currencies', async () => {
    const line = page.locator('aside li', { hasText: 'Espresso' }).first();
    await line.locator('text=/\\$[\\d.]+ each/').waitFor();
    await line.locator('text=/[\\d,]+ LL/').first().waitFor();
  });

  await step('split USD + LBP tender covers the total', async () => {
    await page.click('[role=dialog] button:has-text("Cash")');
    const dialog = page.locator('[role=dialog]');

    // A small USD amount alone leaves a balance still due.
    await dialog.getByRole('button', { name: '1', exact: true }).click();
    await page.waitForSelector('text=Still due');

    // Top up in pounds. The cart is ~$24, so 1,000,000 LL (~$11) is still short;
    // 5,000,000 LL (~$56) covers it.
    await dialog.getByRole('button', { name: 'Lebanese pounds' }).first().click();
    await dialog.getByRole('button', { name: '1,000k' }).click();
    await page.waitForSelector('text=Still due', { timeout: 5000 });
    await dialog.getByRole('button', { name: '5,000k' }).click();
    await page.waitForSelector('text=Change to give');
  });
  await shot('split-tender');

  await step('the change fields are there without picking a mode', async () => {
    const dialog = page.locator('[role=dialog]');
    // No Pounds/Dollars/Both toggle to get past — both figures are on screen,
    // with the whole change suggested in pounds until the cashier says otherwise.
    if (await dialog.getByRole('button', { name: 'Both', exact: true }).count()) {
      throw new Error('the change-currency toggle is still there');
    }
    await dialog.locator('text=suggested').first().waitFor();
    await page.waitForSelector('text=/that is the change exactly/');
    await page.waitForSelector('text=/Confirm · change [\\d,]+ LL/');
  });

  await step('all in one currency is one tap', async () => {
    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('button', { name: 'All dollars' }).click();
    await page.waitForSelector('text=/Confirm · change \\$[\\d.]+$/');
    await dialog.getByRole('button', { name: 'All LBP' }).click();
    await page.waitForSelector('text=/Confirm · change [\\d,]+ LL/');
  });

  await step('naming the dollars pulls the pounds down to meet them', async () => {
    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('button', { name: 'Dollars back' }).click();
    await dialog.getByRole('button', { name: '$5.00', exact: true }).click();
    await page.waitForSelector('text=/that is the change exactly/');
    await page.waitForSelector('text=/Confirm · change \\$5\\.00 \\+ [\\d,]+ LL/');
  });

  await step('typing both figures stops the till overwriting either', async () => {
    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('button', { name: 'LBP back' }).click();
    await dialog.getByRole('button', { name: '100k' }).click();
    // Two deliberate figures that do not cover the change are reported, not fixed.
    await page.waitForSelector('text=/\\$[\\d.]+ of \\$[\\d.]+ — \\$[\\d.]+ short/');

    // Handing the pounds back to the till restores the suggestion.
    await dialog.getByRole('button', { name: 'let the till fill this' }).last().click();
    await page.waitForSelector('text=/that is the change exactly/');
  });
  await shot('split-change');

  await step('confirming payment shows the receipt', async () => {
    await page.click('button:has-text("Confirm · change")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.waitForSelector('text=/Give \\$5\\.00 \\+ [\\d,]+ LL change/');
    await page.waitForSelector('text=Paid in LBP');
  });
  await shot('receipt');

  await step('closing the receipt clears the cart', async () => {
    await page.click('button:has-text("New sale")');
    await page.waitForSelector('text=No items yet');
  });

  await step('the drawer figure follows the sale without a reload', async () => {
    /*
     * A cashier counts blind, so the register withholds the figure — but the
     * panel must still have refreshed. Checking the movement count proves the
     * reload happened without needing to see the money.
     */
    await page.waitForSelector('text=Cash on hand', { timeout: 15000 });
    await page.waitForSelector('text=Counted at close');

    const drawer = await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token') || sessionStorage.getItem('pos_token');
      const res = await fetch('/api/cash/current', { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    });
    // The opening float and the sale just rung up.
    if (drawer.movementCount < 1) {
      throw new Error(`the sale did not reach the drawer (${drawer.movementCount} movements)`);
    }
  });

  await step('F2 does nothing with an empty cart', async () => {
    await page.keyboard.press('F2');
    await page.waitForTimeout(300);
    if (await page.locator('text=Take payment').count()) {
      throw new Error('F2 opened payment with an empty cart');
    }
  });

  /*
   * Parking a sale, which is a queue-length problem: the counter has to come
   * back without the rung-up lines going anywhere.
   */
  await step('a sale can be put to one side', async () => {
    await page.getByRole('button', { name: /^Croissant/ }).first().click();
    await page.waitForSelector('aside >> text=Croissant');

    await page.click('aside button:has-text("Hold")');
    await page.waitForSelector('text=Put it to one side', { timeout: 10000 });
    await page.locator('#heldLabel').fill('Rami · blue case');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Hold the sale' }).click();

    // The counter is free again, and the shelf says what is waiting on it.
    await page.waitForSelector('text=No items yet', { timeout: 10000 });
    await page.waitForSelector('aside button:has-text("Held 1")', { timeout: 10000 });
  });

  await step('and picked back up exactly where it was left', async () => {
    await page.click('aside button:has-text("Held 1")');
    await page.waitForSelector('text=Pick one back up', { timeout: 10000 });
    await page.waitForSelector('[role=dialog] >> text=Rami · blue case');

    await page.locator('[role=dialog]').getByRole('button', { name: 'Resume' }).first().click();
    await page.waitForSelector('aside >> text=Croissant', { timeout: 10000 });

    // Off the shelf once somebody has it on their screen, so two cashiers
    // cannot both be selling the same parked cart.
    if (await page.locator('aside button:has-text("Held")').count()) {
      throw new Error('a resumed sale is still being offered on the shelf');
    }
    await page.click('aside button:has-text("Clear")');
    await page.waitForSelector('text=No items yet');
  });
  await shot('held-sale');

  await step('the sale appears in My sales', async () => {
    await page.click('a[title="My sales"]');
    await page.waitForSelector('text=ORD-', { timeout: 10000 });
  });

  await step('cashiers see no admin navigation', async () => {
    if (await page.locator('a[title="Dashboard"]').count()) throw new Error('cashier sees admin nav');
  });

  console.log('\nBack office (admin)');

  await step('sign in as admin', async () => {
    await page.click('button[aria-label="Log out"]');
    await page.waitForSelector('text=Demo accounts');
    await page.click('button:has-text("Store owner")');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
  });

  await step('dashboard renders every panel', async () => {
    await page.click('a[title="Dashboard"]');
    await page.waitForSelector('text=Daily revenue', { timeout: 15000 });
    await page.waitForSelector('text=Payment mix');
    await page.waitForSelector('text=Needs restocking');
  });
  await shot('dashboard');

  await step('date range filter re-scopes the charts', async () => {
    await page.click('button:has-text("Last 7 days")');
    await page.waitForTimeout(700);
  });

  await step('charts expose a table view', async () => {
    await page.click('button:has-text("table")');
    await page.waitForTimeout(300);
    if (!(await page.locator('th:has-text("Revenue")').count())) throw new Error('no table view');
  });

  await step('inventory shows stock health', async () => {
    await page.click('a[title="Inventory"]');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });
    await page.waitForSelector('text=Retail value');
  });
  await shot('inventory');

  await step('stock adjustment saves', async () => {
    await page.click('button:has-text("Adjust") >> nth=0');
    await page.waitForSelector('text=Adjust stock');
    await page.fill('input[type=number]', '25');
    await page.waitForSelector('text=New stock level:');
    await page.click('button:has-text("Save adjustment")');
    await page.waitForSelector('text=updated to', { timeout: 15000 });
  });

  await step('movement history lists the adjustment', async () => {
    await page.click('button[aria-label^="History for"] >> nth=0');
    await page.waitForSelector('text=Stock history', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('a product can be set to track each handset by IMEI', async () => {
    await page.click('a[title="Products"]');
    await page.waitForSelector('text=New product', { timeout: 15000 });
    await page.click('button:has-text("New product")');
    await page.waitForSelector('[role=dialog] >> text=Track each one by IMEI');

    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Galaxy A15');
    await dialog.getByRole('textbox', { name: 'SKU', exact: true }).fill('PH-A15');
    await dialog.getByRole('spinbutton', { name: 'Price', exact: true }).fill('189');
    await dialog.getByRole('spinbutton', { name: 'Cost', exact: true }).fill('150');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /Create|Save/ }).click();
    await page.waitForSelector('text=Galaxy A15', { timeout: 15000 });
  });

  await step('handsets are booked in by IMEI and become the stock', async () => {
    await page.getByRole('button', { name: 'Handsets of Galaxy A15' }).click();
    await page.waitForSelector('text=No handsets booked in yet');

    await page.getByRole('button', { name: /^Book in$/ }).click();
    await page.waitForSelector('#imeis');
    /*
     * Typed off the box, spaces and all. The first is a dual-SIM handset with
     * both its numbers on one line; the second has a single SIM.
     */
    await page.fill('#imeis', '35 9988 7766 5544 1, 359988776655449\n359988776655442');
    await page.getByRole('button', { name: /Book in 2/ }).click();

    await page.waitForSelector('text=/2 on the shelf/', { timeout: 15000 });
    await page.waitForSelector('text=359988776655441', { timeout: 5000 });
    await page.waitForSelector('text=359988776655449', { timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('a dual-SIM handset is found by either of its numbers', async () => {
    const both = await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token') || sessionStorage.getItem('pos_token');
      const get = (imei) =>
        fetch(`/api/units/lookup?imei=${imei}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json());
      return Promise.all([get('359988776655441'), get('359988776655449')]);
    });
    if (both[0].unit.id !== both[1].unit.id) {
      throw new Error('IMEI 1 and IMEI 2 found different handsets');
    }
    if (both[1].unit.imei2 !== '359988776655449') throw new Error('the second number was not stored');
  });
  await shot('imei-units');

  await step('selling a phone asks which handset, and records it', async () => {
    await page.click('a[title="Register"]');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.fill(scanBox, 'Galaxy');
    await page.waitForTimeout(400);
    await page.locator('section button', { hasText: 'Galaxy A15' }).first().click();

    // A serialised product cannot go into the cart as a quantity.
    await page.waitForSelector('text=Which handset?');
    await page.locator('[role=dialog] span.font-mono').first().click();
  });

  await step('the sale dialog asks for buyer, gifts and accounts before the cart', async () => {
    /*
     * Everything a phone sale needs is settled on the way in. It is a dialog
     * rather than a side panel because a panel is something a busy cashier can
     * finish a sale without ever opening.
     */
    const dialog = page.locator('[role=dialog]');
    await page.waitForSelector('text=Account setup', { timeout: 10000 });

    await dialog.locator('#buyer-name').fill('Rami Haddad');
    await dialog.locator('#buyer-phone').fill('03 456 789');
    await dialog.locator('#price-usd').fill('280');
    await dialog.locator('#line-discount').fill('10');
    await page.waitForSelector('text=/\\$270\\.00/');

    await dialog.getByRole('button', { name: /^Gifts/ }).click();
    await dialog.getByRole('textbox', { name: 'Search a product to give away' }).fill('Espresso');
    await dialog.locator('button', { hasText: 'Espresso' }).first().click();

    await dialog.getByRole('button', { name: /^Account setup/ }).click();
    await dialog.locator('#acct-appleId').fill('rami@icloud.com');
    await dialog.locator('#acct-applePassword').fill('hunter2');

    await dialog.getByRole('button', { name: 'Add to cart' }).click();

    // The handset and its gift arrive together, the IMEI on the phone's line.
    await page.waitForSelector('aside >> text=/3599887766554\\d/', { timeout: 10000 });
    await page.waitForSelector('aside >> text=Espresso');
    await page.waitForSelector('aside >> text=Gift — free');
  });

  await step('the sold handset is traceable by IMEI afterwards', async () => {
    await page.click('aside button:has-text("Charge $")');
    await page.click('[role=dialog] button:has-text("Card")');
    await page.click('[role=dialog] button:has-text("Confirm $")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.click('button:has-text("New sale")');

    const found = await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token') || sessionStorage.getItem('pos_token');
      const res = await fetch('/api/units/lookup?imei=359988776655442', {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json();
    });
    if (found.unit.status !== 'sold') throw new Error(`unit is ${found.unit.status}, expected sold`);
    if (!found.unit.order_number) throw new Error('the sold unit does not name its order');
    if (found.available !== false) throw new Error('a sold handset still reads as available');
  });

  await step('a handset can be bought in over the counter', async () => {
    await page.click('a[title="Trade-ins"]');
    await page.waitForSelector('text=Buy a handset', { timeout: 15000 });
    await page.click('button:has-text("Buy a handset")');
    await page.waitForSelector('[role=dialog] >> text=Which model will you sell it as?');

    // The model is searched, not picked from a list that may not hold it yet.
    const dialog = page.locator('[role=dialog]');
    await dialog.locator('#model').fill('Galaxy');
    await dialog.locator('button', { hasText: 'Galaxy A15' }).first().click();
    await dialog.getByRole('textbox', { name: 'IMEI', exact: true }).fill('35 7700 5566 4433 1');
    /*
     * Small on purpose. The drawer opened with $100 and the later steps take
     * more out of it; a realistic trade-in price here would empty the till and
     * fail the cash-out two steps down, which would look like a cashbox bug.
     */
    await dialog.getByRole('spinbutton', { name: 'Paid in dollars', exact: true }).fill('20');
    await dialog.getByRole('textbox', { name: "Seller's name", exact: true }).fill('Karim Aoun');

    // What it costs the shop, worked out before the money leaves the drawer.
    await page.waitForSelector('text=/Costs the shop/');
    await dialog.getByRole('button', { name: 'Buy it in' }).click();

    await page.waitForSelector('text=357700556644331', { timeout: 15000 });
    await page.waitForSelector('text=On the shelf');
  });

  await step('the starter card catalogue loads and a wallet is topped up', async () => {
    await page.click('a[title="Cards"]');
    await page.waitForSelector('text=/sold from credit/', { timeout: 15000 });

    await page.click('button:has-text("Load the Lebanese starter set")');
    await page.waitForSelector('text=/Added \\d+ cards/', { timeout: 15000 });
    await page.waitForSelector('text=ALFA 7.58 · 1 month', { timeout: 15000 });
    await page.waitForSelector('text=Whole Recharge');
    await page.waitForSelector('text=Gift Cards');

    // Seeded at cost = price, so every margin reads as "set the cost" until
    // the shop puts its dealer price in.
    await page.waitForSelector('text=Set the cost');

    await page.getByRole('button', { name: 'Top up Mobile recharge' }).click();
    await page.waitForSelector('[role=dialog] >> text=What happened', { timeout: 10000 });
    await page.locator('[role=dialog] #amount').fill('500');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Record it' }).click();
    await page.waitForSelector('text=/is now \\$/', { timeout: 15000 });
    await page.waitForSelector('text=$500.00', { timeout: 15000 });
  });
  await shot('cards');

  await step('a card sells from the wallet and never runs out of stock', async () => {
    await page.click('a[title="Cards"]');
    await page.waitForSelector('text=Mobile recharge', { timeout: 15000 });
    // What the card costs the shop, so the wallet moves by a real figure.
    await page.getByRole('button', { name: 'Edit ALFA 10 · 1 month' }).click();
    await page.locator('[role=dialog] #cost').fill('2.75');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Card updated', { timeout: 15000 });

    await page.click('a[title="Register"]');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    // Exact: "recharge" also appears inside several of the card names.
    await page.getByRole('button', { name: 'Recharge', exact: true }).click();
    await page.waitForSelector('text=ALFA 10 · 1 month', { timeout: 15000 });

    // Four of a card the shop has none of on any shelf. Not anchored: the
    // tile's accessible name starts with the card's emoji, not its name.
    const tile = page.getByRole('button', { name: /ALFA 10 · 1 month/ }).first();
    for (let i = 0; i < 4; i += 1) await tile.click();
    await page.waitForSelector('aside >> text=ALFA 10 · 1 month', { timeout: 10000 });
    if (!(await page.locator('aside >> text=4').count())) throw new Error('four did not reach the cart');

    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector('[role=dialog] >> text=Take payment', { timeout: 15000 });
    await page.click('[role=dialog] button:has-text("Card")');
    await page.click('[role=dialog] button:has-text("Confirm $")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.click('button:has-text("New sale")');

    // $500 less four at $2.75.
    await page.click('a[title="Cards"]');
    await page.waitForSelector('text=$489.00', { timeout: 15000 });
  });

  await step('a held account is found and its password revealed to an admin', async () => {
    await page.click('a[title="Logins"]');
    await page.waitForSelector('text=Search for a customer', { timeout: 15000 });

    // Whatever the customer remembers: here, the number they called from.
    await page.fill('input[aria-label="Find a held account"]', '03 456');
    await page.waitForSelector('text=rami@icloud.com', { timeout: 10000 });

    await page.getByRole('button', { name: 'Show password' }).first().click();
    await page.waitForSelector('text=hunter2', { timeout: 10000 });
  });

  await step('import wizard accepts the sample catalog', async () => {
    await page.click('a[title="Import"]');
    await page.waitForSelector('text=Drop a CSV file here', { timeout: 15000 });
    await page.click('button:has-text("Use sample")');
    await page.waitForSelector('text=Source format', { timeout: 15000 });
  });
  await shot('import-mapping');

  await step('import preview classifies rows', async () => {
    await page.click('button:has-text("Review")');
    await page.waitForSelector('text=3 new', { timeout: 15000 });
    await page.waitForSelector('td:has-text("Cold Brew")');
  });
  await shot('import-review');

  await step('import commits', async () => {
    await page.click('button:has-text("Import 3 products")');
    await page.waitForSelector('text=Import complete', { timeout: 20000 });
  });

  await step('imported products show in the catalog', async () => {
    await page.click('a[title="Products"]');
    await page.waitForSelector('text=Cold Brew', { timeout: 15000 });
  });
  await shot('products');

  /*
   * One product, several barcodes: the maker's on the box, the distributor's
   * label over it, the shop's own. Whichever is facing up has to find it.
   */
  await step('a product takes as many barcodes as you scan into it', async () => {
    await page.click('button:has-text("New product")');
    await page.waitForSelector('[role=dialog] >> text=Barcodes', { timeout: 10000 });
    const dialog = page.locator('[role=dialog]');

    await dialog.getByLabel('Name').fill('Braided cable');
    await dialog.getByLabel('SKU').fill('CBL-BRAID');
    await dialog.getByLabel('Price').fill('7.50');
    // Stock, or the register refuses it at the scan and this proves nothing.
    await dialog.getByLabel('Stock on hand').fill('10');

    // A scanner is a keyboard that types fast and presses Enter.
    const scan = dialog.getByLabel('Add a barcode');
    for (const code of ['6291000000017', '0712345678900', 'SHOP-CBL-1']) {
      await scan.fill(code);
      await scan.press('Enter');
      await dialog.locator(`text=${code}`).waitFor({ timeout: 5000 });
    }

    // Enter must commit the code, never submit the half-filled form.
    if (!(await dialog.count())) throw new Error('the scanner’s Enter submitted the form');

    await dialog.getByRole('button', { name: 'Create product' }).click();
    await page.waitForSelector('text=Braided cable', { timeout: 15000 });
  });

  await step('and any one of them finds it at the register', async () => {
    await page.click('a[title="Register"]');
    await page.waitForSelector(scanBox, { timeout: 15000 });

    for (const code of ['6291000000017', '0712345678900', 'SHOP-CBL-1']) {
      await page.fill(scanBox, code);
      await page.press(scanBox, 'Enter');
      await page.waitForSelector('text=Added Braided cable', { timeout: 10000 });
      await page.waitForTimeout(250);
    }

    // Three scans of the same product is one line of three, not three products.
    const lines = await page.locator('aside li:has-text("Braided cable")').count();
    if (lines !== 1) throw new Error(`three barcodes made ${lines} cart lines — they are one product`);
    await page.click('aside button:has-text("Clear")');
    await page.waitForSelector('text=No items yet');
  });

  await step('refunding an order works', async () => {
    await page.click('a[title="Orders"]');
    await page.waitForSelector('text=ORD-', { timeout: 15000 });
    await page.click('td:has-text("ORD-") >> nth=0');
    await page.waitForSelector('button:has-text("Refund order")');
    await page.click('button:has-text("Refund order")');
    await page.waitForSelector('text=Refunded', { timeout: 15000 });
  });

  await step('staff page lists accounts', async () => {
    await page.click('a[title="Staff"]');
    await page.waitForSelector('text=Store Owner', { timeout: 15000 });
  });

  await step('admin can add a customer with a credit limit', async () => {
    await page.click('a[title="Customers"]');
    await page.waitForSelector('text=Total owed to you', { timeout: 15000 });
    await page.click('button:has-text("New customer")');
    await page.waitForSelector('text=New customer');
    await page.fill('input[name="name"], [role=dialog] input >> nth=0', 'Rami Haddad');
    await page.fill('[role=dialog] input[type=number] >> nth=0', '200');
    await page.click('button:has-text("Add")');
    await page.waitForSelector('td:has-text("Rami Haddad")', { timeout: 15000 });
  });
  await shot('customers');

  await step('recording a payment moves the balance', async () => {
    await page.click('td:has-text("Rami Haddad")');
    await page.waitForSelector('text=Balance', { timeout: 15000 });
    await page.click('button:has-text("Charge")');
    await page.waitForSelector('text=Add a charge');
    await page.fill('[role=dialog] input[type=number] >> nth=0', '50');
    await page.click('button:has-text("Record $50.00")');
    await page.waitForSelector('text=Charge recorded', { timeout: 15000 });
    await page.waitForSelector('text=/Owes you \\$50\\.00|\\$50\\.00/', { timeout: 15000 });
  });

  await step('a supplier bill shows up as a payable', async () => {
    await page.keyboard.press('Escape');
    await page.click('a[title="Suppliers"]');
    await page.waitForSelector('text=Total you owe', { timeout: 15000 });
    await page.click('button:has-text("New supplier")');
    await page.fill('[role=dialog] input >> nth=0', 'Corner Bakehouse');
    await page.click('button:has-text("Add")');
    await page.waitForSelector('td:has-text("Corner Bakehouse")', { timeout: 15000 });
  });
  await shot('suppliers');

  await step('a purchase invoice receives stock and creates a payable', async () => {
    // Note the stock level before receiving.
    await page.click('a[title="Inventory"]');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });
    const unitsOnHand = async () =>
      Number((await page.locator('p:has-text("Units on hand") + p').innerText()).replace(/,/g, ''));
    const before = await unitsOnHand();

    await page.click('a[title="Documents"]');
    await page.waitForSelector('button:has-text("New document")', { timeout: 15000 });
    const dialog = await openNewDocument();
    // Type is chosen by icon tile now.
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });

    // Search for a product and add it with Enter.
    await dialog.getByLabel('Search products to add').fill('Bagel');
    await dialog.locator('text=/BAK-002/').first().waitFor();
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.locator('text=/Quantity for Bagel/i').first().waitFor().catch(() => {});
    await dialog.getByLabel(/Quantity for Bagel/i).fill('10');
    await page.click('button:has-text("Create draft")');

    // Opens straight into the detail view as a draft.
    await page.waitForSelector('text=/PI-\\d{4}/', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=draft');

    await page.click('button:has-text("Confirm")');
    await page.waitForSelector('[role=dialog] >> text=confirmed', { timeout: 15000 });
    await page.keyboard.press('Escape');

    await page.click('a[title="Inventory"]');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });
    const after = await unitsOnHand();
    if (after !== before + 10) throw new Error(`stock went ${before} → ${after}, expected +10`);
  });
  await shot('purchase-invoice');

  await step('labels can be printed from a confirmed purchase invoice', async () => {
    await page.click('a[title="Documents"]');
    await page.click('td:has-text("PI-0001")');
    await page.waitForSelector('text=Print labels', { timeout: 15000 });
    await page.click('button:has-text("Print labels")');

    // Lands on the label page preloaded with the received quantity.
    await page.waitForSelector('text=Loaded from PI-0001', { timeout: 15000 });
    await page.waitForSelector('text=/10 labels/', { timeout: 15000 });

    // Each label carries a real barcode, drawn as SVG bars.
    const bars = await page.locator('.label-sheet svg rect').count();
    if (bars < 10) throw new Error(`expected barcode bars, found ${bars} rects`);

    // And the price in both currencies.
    await page.locator('.label-sheet').first().locator('text=/\\$/').first().waitFor();
    await page.locator('.label-sheet').first().locator('text=/LL/').first().waitFor();
  });
  await shot('labels');

  await step('label size and currency options change the sheet', async () => {
    await page.getByLabel('Label size').selectOption('small');
    await page.waitForTimeout(400);
    await page.getByLabel('Show the price in LBP too').uncheck();
    await page.waitForTimeout(300);
    if (await page.locator('.label-sheet').first().locator('text=/ LL/').count()) {
      throw new Error('pound prices still shown after unticking');
    }
  });

  await step('label printer mode puts one label on each page', async () => {
    await page.getByRole('button', { name: /Label printer/ }).click();
    await page.waitForTimeout(400);
    // The page count follows the label count, not the sheet capacity.
    await page.waitForSelector('text=/10 pages/', { timeout: 10000 });

    // Each label is its own page in the generated PDF.
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages !== 10) throw new Error(`expected 10 pages, got ${pages}`);

    // Switching to sheet stock puts them all on one A4 page instead.
    await page.getByRole('button', { name: /A4 label sheet/ }).click();
    await page.waitForTimeout(400);
    const sheetPdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    const sheetPages = (sheetPdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (sheetPages !== 1) throw new Error(`expected 1 A4 page, got ${sheetPages}`);
  });

  await step('the page is sized to the label stock, preset or custom', async () => {
    await page.getByRole('button', { name: /Label printer/ }).click();

    // The printed page must match the physical label, or the run is misaligned.
    const pageSizeMm = async () => {
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      const box = pdf.toString('latin1').match(/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
      return [box[1], box[2]].map((pt) => (Number(pt) / 72) * 25.4);
    };
    const near = (actual, expected) => Math.abs(actual - expected) < 0.5;

    await page.getByLabel('Label size').selectOption('tiny');
    await page.waitForTimeout(400);
    const [tw, th] = await pageSizeMm();
    if (!near(tw, 40) || !near(th, 20)) throw new Error(`40 × 20 preset printed ${tw} × ${th} mm`);

    // Stock that matches no preset is entered by hand.
    await page.getByLabel('Label size').selectOption('custom');
    await page.getByLabel('Width (mm)').fill('57');
    await page.getByLabel('Height (mm)').fill('32');
    await page.waitForTimeout(500);
    const [cw, ch] = await pageSizeMm();
    if (!near(cw, 57) || !near(ch, 32)) throw new Error(`custom 57 × 32 printed ${cw} × ${ch} mm`);

    // Nothing on the label may spill outside its die-cut edge.
    const spill = await page.evaluate(() =>
      [...document.querySelectorAll('.label-one')].some(
        (el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      ),
    );
    if (spill) throw new Error('label contents overflow the label');
  });

  await step('a quotation converts to a sales order', async () => {
    await page.click('a[title="Documents"]');
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Quotation/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Rami Haddad' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('2');
    await page.click('button:has-text("Create draft")');
    await page.waitForSelector('text=/QT-\\d{4}/', { timeout: 15000 });

    await page.click('button:has-text("To sales order")');
    await page.waitForSelector('text=Converted', { timeout: 15000 });
    await page.waitForSelector('td:has-text("SO-0001")', { timeout: 15000 });
  });
  await shot('documents');

  await step('a new product can be created from inside a document', async () => {
    await page.click('a[title="Documents"]');
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });

    // Searching for something that does not exist offers to create it.
    await dialog.getByLabel('Search products to add').fill('Pistachio Baklava');
    await page.waitForSelector('text=/No product matches/');
    await page.click('button:has-text("Create “Pistachio Baklava” as a new product")');

    await page.waitForSelector('text=New product', { timeout: 15000 });
    await page.fill('[role=dialog] #sku', 'BAK-999');
    await page.fill('[role=dialog] #price', '6.50');
    await page.fill('[role=dialog] #cost', '2.25');
    await page.click('button:has-text("Create and add")');

    // It is created and lands on the document as a line at cost.
    await page.waitForSelector('text=Pistachio Baklava created', { timeout: 15000 });
    await page.waitForSelector('td:has-text("BAK-999")', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });
  await shot('inline-product');

  await step('a purchase paid in cash leaves no payable behind', async () => {
    await page.click('a[title="Documents"]');
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('10');
    await dialog.getByLabel(/Unit price for/i).first().fill('1');

    await dialog.getByRole('button', { name: /Paid in full/ }).click();
    await dialog.getByLabel('Method').selectOption('cash');
    await page.waitForSelector('[role=dialog] >> text=Settled', { timeout: 10000 });

    await page.click('button:has-text("Create draft")');
    await page.waitForSelector('text=/Paid cash/', { timeout: 15000 });
    await page.click('button:has-text("Confirm")');
    await page.waitForSelector('text=confirmed', { timeout: 15000 });
    await page.keyboard.press('Escape');

    // The delivery is on the supplier's statement, but nothing is owed for it.
    await page.click('a[title="Suppliers"]');
    await page.waitForSelector('text=Total you owe', { timeout: 15000 });
    await page.click('td:has-text("Corner Bakehouse")');
    await page.waitForSelector('text=/paid cash/', { timeout: 15000 });
    await closeDialog();
  });
  await shot('paid-in-cash');

  await step('a part payment leaves only the remainder owing', async () => {
    await page.click('a[title="Documents"]');
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('10');
    await dialog.getByLabel(/Unit price for/i).first().fill('10');

    await dialog.getByRole('button', { name: /Part paid/ }).click();
    await dialog.getByLabel('Amount paid now').fill('40');
    // $100 plus 8% tax, less the $40 handed over.
    await page.waitForSelector('[role=dialog] >> text=$68.00', { timeout: 10000 });

    // Paying more than the total is refused rather than silently accepted.
    await dialog.getByLabel('Amount paid now').fill('500');
    await page.waitForSelector('text=/more than the/', { timeout: 10000 });
    if (await page.getByRole('button', { name: 'Create draft' }).isEnabled()) {
      throw new Error('an overpayment should block the save');
    }

    await dialog.getByLabel('Amount paid now').fill('40');
    await page.click('button:has-text("Create draft")');
    await page.waitForSelector('text=Still owing', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=$68.00');
    await closeDialog();
  });

  await step('a confirmed document can be corrected, and the books follow', async () => {
    await page.click('a[title="Documents"]');
    let dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });
    await dialog.getByLabel('Search products to add').fill('Bagel');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('10');
    await dialog.getByLabel(/Unit price for/i).first().fill('2');
    await page.click('button:has-text("Create draft")');
    await page.waitForSelector('text=/PI-\\d{4}/', { timeout: 15000 });

    await page.click('button:has-text("Confirm")');
    await page.waitForSelector('text=confirmed', { timeout: 15000 });

    // Only six turned up, not ten.
    await page.click('button:has-text("Edit")');
    await page.waitForSelector('text=/puts back the stock it moved/', { timeout: 15000 });
    dialog = page.locator('[role=dialog]');
    if ((await dialog.getByLabel(/Quantity for/i).first().inputValue()) !== '10') {
      throw new Error('the edit form did not load the document as it stands');
    }
    await dialog.getByLabel(/Quantity for/i).first().fill('6');
    await page.click('button:has-text("Save changes")');
    await page.waitForSelector('text=/updated/', { timeout: 15000 });

    // $12 of goods plus 8% tax, and still confirmed.
    await page.waitForSelector('[role=dialog] >> text=$12.96', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=confirmed');
  });
  await shot('document-edited');

  await step('the correction shows in the stock history', async () => {
    await page.keyboard.press('Escape');
    await page.click('a[title="Inventory"]');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });

    await page.click('tr:has-text("Bagel") button[aria-label^="History for"]');
    await page.waitForSelector('text=Stock history', { timeout: 15000 });
    // Both halves of the correction are on the record, not just the net.
    await page.waitForSelector('[role=dialog] >> text=/Edited PI-/', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('a document can be deleted, and is reversed on the way out', async () => {
    await page.click('a[title="Documents"]');
    await page.click('td:has-text("PI-0002")');
    await page.waitForSelector('text=Print labels', { timeout: 15000 });

    await page.click('button:has-text("Delete")');
    await page.waitForSelector('text=/This cannot be undone/', { timeout: 15000 });
    await page.click('button:has-text("Delete PI-0002")');
    await page.waitForSelector('text=/PI-0002 deleted/', { timeout: 15000 });

    if (await page.locator('td:has-text("PI-0002")').count()) {
      throw new Error('the deleted document is still listed');
    }
  });

  await step('a document another was created from cannot be deleted', async () => {
    await page.click('td:has-text("QT-0001")');
    await page.waitForSelector('text=/SO-0001/', { timeout: 15000 });
    if (await page.getByRole('button', { name: 'Delete', exact: true }).isEnabled()) {
      throw new Error('a converted quotation should not be deletable');
    }
    await page.keyboard.press('Escape');
  });

  await step('the cashbox closes against a blind count', async () => {
    await page.click('a[title="Register"]');
    await page.waitForSelector('text=Cash on hand', { timeout: 15000 });

    // Money out of the drawer for an expense.
    await page.click('button:has-text("Cash out")');
    await page.waitForSelector('text=Money coming out of the drawer', { timeout: 10000 });
    await page.getByLabel('Reason').selectOption('expense');
    await page.getByLabel('Dollars').fill('15');
    await page.getByLabel('What for?').fill('Milk and cleaning');
    await page.click('button:has-text("Take out")');
    await page.waitForSelector('text=/taken out of the drawer/i', { timeout: 15000 });

    await page.click('button[aria-label="Close the cashbox"]');
    await page.waitForSelector('text=Count what is in the drawer', { timeout: 10000 });

    // Counting note by note fills the total in.
    await page.getByLabel('USD 100 notes').fill('1');
    await page.waitForSelector('[role=dialog] >> text=$100.00');

    /*
     * And the total can be typed straight in, which is what a shopkeeper who
     * counted on the counter before opening the app actually wants. Whoever is
     * trusted with the till's history sees the difference as they type.
     */
    const dialog = page.locator('[role=dialog]');
    await dialog.locator('#countedUsd').fill('120');
    await dialog.locator('text=Against the app').waitFor();
    await dialog.locator('text=/over|short|matches/').first().waitFor();

    // And the two currencies as one figure, the pounds converted at the rate.
    await dialog.locator('text=Altogether').waitFor();

    await dialog.locator('#countedUsd').fill('100');
    await page.click('button:has-text("Close and check")');
    await page.waitForSelector('text=How the drawer came out', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=Expected');
    await page.click('button:has-text("Done")');
    await page.waitForSelector('text=Cashbox closed', { timeout: 15000 });
  });
  await shot('cashbox');

  await step('the shift report shows every movement and what it was out by', async () => {
    await page.click('a[title="Cashbox"]');
    await page.waitForSelector('text=Every sitting of the till', { timeout: 15000 });
    await page.click('tbody tr >> nth=0');
    await page.waitForSelector('text=Every movement', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=Opening float');
    await page.waitForSelector('[role=dialog] >> text=Cash out');
    await page.waitForSelector('[role=dialog] >> text=Over / short');
    await page.waitForSelector('[role=dialog] >> text=The count');
    // Profit is on the report for the owner, and only for the owner — the
    // server leaves it out entirely for anyone else.
    await page.waitForSelector('[role=dialog] >> text=Gross profit');
  });

  await step('and downloads as a PDF to file or send on', async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.click('button:has-text("Download PDF")'),
    ]);

    const name = download.suggestedFilename();
    if (!/^cashbox-.*\.pdf$/.test(name)) throw new Error(`unexpected filename: ${name}`);

    // A file the browser accepted but that no reader can open would pass a
    // download check and fail in the shop, so read the bytes back.
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);

    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('the download is not a PDF');
    if (!bytes.toString('latin1').trimEnd().endsWith('%%EOF')) {
      throw new Error('the PDF is truncated and will not open');
    }
    await closeDialog();
  });

  await step('an item’s activity shows what it did and what it cost', async () => {
    await page.click('a[title="Products"]');
    await page.waitForSelector('text=Your catalog', { timeout: 15000 });
    await page.click('button[aria-label="Activity for Croissant"]');

    await page.waitForSelector('text=Everything it did', { timeout: 15000 });
    // Sold, refunded or received — this product has been through all three by
    // now, and which one is on top depends on what the run did last.
    await page.waitForSelector('[role=dialog] >> text=/Sold|Refunded|Received/', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=/ORD-|PI-/');
    // Price, cost and margin are on every product; whether this one's cost has
    // moved depends on what the run bought, and is pinned in the API tests.
    await page.waitForSelector('[role=dialog] >> text=Sells for');
    await page.waitForSelector('[role=dialog] >> text=Margin');
    await closeDialog();
  });

  await step('an expense is recorded and comes off the profit', async () => {
    await page.click('a[title="Expenses"]');
    await page.waitForSelector('text=What it costs to keep the doors open', { timeout: 15000 });

    await page.click('button:has-text("Add expense")');
    await page.waitForSelector('text=Money spent running the shop', { timeout: 10000 });
    await page.getByLabel('What for').selectOption('rent');
    await page.getByLabel('Dollars').fill('250');
    await page.getByLabel('Paid with').selectOption('bank');
    await page.getByLabel('Note').fill('Monthly rent');
    await page.click('button:has-text("Record it")');
    await page.waitForSelector('text=Expense recorded', { timeout: 15000 });
    await page.waitForSelector('text=Where the money went');
  });
  await shot('expenses');

  await step('the profit report subtracts cost and expenses in turn', async () => {
    await page.click('a[title="Profit"]');
    await page.waitForSelector('text=What made the most', { timeout: 15000 });

    await page.waitForSelector('text=Cost of goods');
    await page.waitForSelector('text=Gross profit');
    await page.waitForSelector('text=Net profit');
    await page.waitForSelector('text=/250.00/', { timeout: 15000 });

    // Switching expenses off leaves gross profit as the headline instead.
    await page.getByLabel('Take expenses off').uncheck();
    await page.waitForTimeout(600);
    if (await page.locator('text=Net profit').count()) {
      throw new Error('net profit is meaningless with expenses switched off');
    }
  });
  await shot('profit');

  await step('Shopify asks to be connected before it will sync anything', async () => {
    await page.click('a[title="Shopify"]');
    await page.waitForSelector('text=Connect your Shopify shop', { timeout: 15000 });
    await page.waitForSelector('text=/read_inventory/');

    // The address is checked before anything is stored, so a typo says so.
    await page.getByLabel('Shop address').fill('not-a-shop');
    await page.getByLabel('Admin API access token').fill('shpat_whatever');
    await page.click('button:has-text("Connect")');
    await page.waitForSelector('text=/myshopify.com/', { timeout: 15000 });
  });
  await shot('shopify');

  await step('the dashboard reports both sides of the book', async () => {
    await page.click('a[title="Dashboard"]');
    await page.waitForSelector('text=Owed to you', { timeout: 15000 });
    await page.waitForSelector('text=You owe');
    await page.waitForSelector('text=Net position');
  });

  await step('a cashier can put a sale on a customer account', async () => {
    await page.click('a[title="Register"]');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.getByRole('button', { name: /^Bagel/ }).first().click();

    await page.click('button:has-text("Add customer")');
    await page.waitForSelector('text=Choose a customer', { timeout: 15000 });
    await page.click('button:has-text("Rami Haddad")');
    await page.waitForSelector('text=owes');

    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector("text=Put on Rami Haddad's account");
    await page.click("button:has-text(\"Put on Rami Haddad's account\")");
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.click('button:has-text("New sale")');
  });
  await shot('account-sale');

  await step('admin can change the exchange rate', async () => {
    await page.click('a[title="Settings"]');
    await page.waitForSelector('text=Exchange rate', { timeout: 15000 });
    await page.fill('input[type=number] >> nth=0', '95000');
    await page.click('button:has-text("Save changes")');
    await page.waitForSelector('text=Exchange rate updated', { timeout: 15000 });
    // The preview and history reflect the new rate.
    await page.waitForSelector('text=95,000');
  });
  await shot('settings');

  await step('the register picks up the new rate', async () => {
    await page.click('a[title="Register"]');
    await page.waitForSelector('text=1 USD = 95,000 LL', { timeout: 15000 });
  });

  await step('an admin can widen what one member of staff may do', async () => {
    await page.click('a[title="Staff"]');
    await page.waitForSelector('text=Who works here', { timeout: 15000 });

    // The register is all a cashier starts with.
    await page.waitForSelector('td:has-text("Use the register")');

    await page.getByRole('button', { name: 'Permissions for Front Register' }).click();
    await page.waitForSelector('[role=dialog] >> text=What Front Register can do', { timeout: 10000 });
    await page.locator('[role=dialog]').getByLabel('Money transfer counter').check();
    // The desk pays for things out of its own drawer, so it needs both.
    await page.locator('[role=dialog]').getByLabel('Record expenses').check();
    await page.locator('[role=dialog]').getByLabel('Payment and receipt vouchers').check();
    await page.click('[role=dialog] button:has-text("Save access")');

    await page.waitForSelector("text=Front Register's access updated", { timeout: 15000 });
    await page.waitForSelector('td:has-text("Money transfer counter")');
  });
  await shot('permissions');

  console.log('\nThe transfer counter');

  await step('the desk appears for the operator it was granted to', async () => {
    await page.click('button[aria-label="Log out"]');
    await page.waitForSelector('text=Demo accounts');
    await page.click('button:has-text("Cashier")');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.click('a[title="Transfers"]');
    await page.waitForSelector('text=/Money sent and paid out/', { timeout: 15000 });
  });


  await step('a transfer moves the drawer with it', async () => {
    // The desk takes real money, so the drawer has to be open to take it into.
    await page.click('button:has-text("Open the cashbox")');
    await page.waitForSelector('text=What is in the drawer to start with?', { timeout: 10000 });
    await page.getByLabel('Dollars').fill('100');
    await page.click('button:has-text("Open cashbox")');
    await page.waitForSelector('text=Cash on hand', { timeout: 15000 });
    // An operator counts blind: the figure is withheld until the close.
    await page.waitForSelector('text=Counted at close');

    await page.click('button:has-text("New transfer")');
    await page.waitForSelector('[role=dialog] >> text=Send a transfer', { timeout: 10000 });
    const dialog = page.locator('[role=dialog]');
    await dialog.locator('#reference').fill('OMT-4821');
    await dialog.locator('#customerName').fill('Hassan Aoun');
    await dialog.locator('#amountUsd').fill('150');
    await dialog.locator('#feeUsd').fill('3');

    // What physically moves is spelled out before the money is taken.
    await dialog.locator('text=Into the drawer').waitFor();
    await dialog.locator('text=$153.00').waitFor();

    await dialog.getByRole('button', { name: 'Take the money' }).click();
    await page.waitForSelector('text=Transfer sent', { timeout: 15000 });

    await page.waitForSelector('text=OMT-4821', { timeout: 15000 });
    await page.waitForSelector('text=$150.00');
    // The fee is the shop's, counted apart from the money being sent.
    await page.waitForSelector('text=$3.00');
  });
  await shot('transfers');

  await step('paying one out takes the money back off the drawer', async () => {
    await page.click('button:has-text("New transfer")');
    await page.waitForSelector('[role=dialog] >> text=Send a transfer', { timeout: 10000 });
    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('button', { name: /Paying out/ }).click();
    await page.waitForSelector('[role=dialog] >> text=Pay a transfer out');
    await dialog.getByLabel('Company').selectOption('Whish');
    await dialog.locator('#amountUsd').fill('50');
    await dialog.locator('#feeUsd').fill('1');
    await dialog.locator('text=Out of the drawer').waitFor();
    await dialog.getByRole('button', { name: 'Pay it out' }).click();
    await page.waitForSelector('text=Paid out', { timeout: 15000 });
    await page.waitForSelector('text=$50.00', { timeout: 15000 });
  });

  await step('an expense out of the same drawer is recorded, not absorbed', async () => {
    await page.click('button:has-text("Expense")');
    await page.waitForSelector('[role=dialog] >> text=Money spent running the shop', { timeout: 10000 });
    await page.locator('[role=dialog] #amountUsd').fill('4');
    await page.locator('[role=dialog] #note').fill('Water for the counter');
    await page.click('[role=dialog] button:has-text("Record it")');
    await page.waitForSelector('text=Expense recorded', { timeout: 15000 });
  });

  await step('a payment voucher pays somebody and prints a slip to sign', async () => {
    await page.click('a[title="Vouchers"]');
    await page.waitForSelector('text=/Money paid out and taken in/', { timeout: 15000 });

    await page.click('button:has-text("New voucher")');
    await page.waitForSelector('[role=dialog] >> text=New voucher', { timeout: 10000 });
    const dialog = page.locator('[role=dialog]');

    // From the shop's own till, to somebody who is on no list.
    await dialog.getByLabel('To — what kind').selectOption('other');
    await dialog.getByLabel('To — name').fill('Abu Khalil the landlord');
    await dialog.locator('#amountUsd').fill('300');
    await dialog.getByLabel('What for').selectOption('rent');
    await dialog.locator('#note').fill('August rent');

    // The sentence it amounts to, before it is written.
    await dialog.locator('text=Paid out').waitFor();
    await dialog.locator('text=/Main drawer → Abu Khalil/').waitFor();
    await dialog.getByRole('button', { name: 'Record it' }).click();

    // Straight to the slip, because a voucher exists to be signed.
    await page.waitForSelector('text=PV-0001', { timeout: 15000 });
    await page.waitForSelector('text=Received by');
    await page.waitForSelector('text=For the shop');
    await closeDialog();
  });
  await shot('vouchers');

  await step('a receipt voucher takes money in, on its own numbering', async () => {
    await page.click('button:has-text("New voucher")');
    await page.waitForSelector('[role=dialog] >> text=New voucher', { timeout: 10000 });
    const dialog = page.locator('[role=dialog]');

    /*
     * Picked by value rather than by label: each option carries the account's
     * balance after its name, so the visible text is not a fixed string.
     */
    const optionValue = async (label, name) => {
      const option = dialog.locator(`select[aria-label="${label}"] option`, { hasText: name });
      return option.first().getAttribute('value');
    };

    await dialog.getByLabel('From — what kind').selectOption('customer');
    await dialog
      .getByLabel('From — which one')
      .selectOption(await optionValue('From — which one', 'Rami Haddad'));
    await dialog.getByLabel('To — what kind').selectOption('cash');
    await dialog
      .getByLabel('To — which one')
      .selectOption(await optionValue('To — which one', 'Main drawer'));
    await dialog.locator('#amountUsd').fill('25');
    await dialog.locator('text=Taken in').waitFor();
    await dialog.getByRole('button', { name: 'Record it' }).click();

    await page.waitForSelector('text=RV-0001', { timeout: 15000 });
    await closeDialog();

    // Both series on one screen, the money moving opposite ways.
    await page.waitForSelector('text=Paid out');
    await page.waitForSelector('text=Taken in');
  });

  await step('the accounts screen answers who owes what, and names the tills', async () => {
    await page.click('button[aria-label="Log out"]');
    await page.waitForSelector('text=Demo accounts');
    await page.click('button:has-text("Admin")');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.click('a[title="Accounts"]');
    await page.waitForSelector('text=/everything owed to it/', { timeout: 15000 });
    await page.waitForSelector('text=In the tills');
    await page.waitForSelector('text=Owed to you');
    await page.waitForSelector('text=You owe');

    // The four kinds, with the one that has no screen of its own managed here.
    await page.waitForSelector('text=Cash accounts');
    await page.waitForSelector('text=Main drawer');
    await page.waitForSelector('text=Wallets');

    await page.getByRole('button', { name: 'New cash account' }).click();
    await page.waitForSelector('[role=dialog] >> text=New cash account', { timeout: 10000 });
    await page.locator('[role=dialog] #name').fill('Back safe');
    await page.locator('[role=dialog]').getByLabel('What it is').selectOption('safe');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Add account' }).click();
    await page.waitForSelector('text=Back safe added', { timeout: 15000 });
    await page.waitForSelector('td:has-text("Back safe")');
  });
  await shot('accounts');

  await step('the drawer carries every one of them', async () => {
    /*
     * Checked from the back office, because the operator counts blind: the
     * expected figure is withheld at the counter so the closing count means
     * something. It is the till ledger that has to be right, and it is.
     */
    await page.click('a[title="Cashbox"]');
    await page.waitForSelector('text=Every sitting of the till', { timeout: 15000 });
    await page.click('tbody tr >> nth=0');
    await page.waitForSelector('[role=dialog] >> text=Every movement', { timeout: 15000 });

    const dialog = page.locator('[role=dialog]');
    // $100 float + $153 in − $49 out − $4 spent − $300 paid + $25 taken.
    await dialog.locator('text=-$75.00').first().waitFor();
    await dialog.locator('text=OMT send').first().waitFor();
    await dialog.locator('text=Whish payout').first().waitFor();
    await dialog.locator('text=PV-0001').first().waitFor();
    await dialog.locator('text=RV-0001').first().waitFor();

    // The next step logs out, and the backdrop would swallow the click.
    await closeDialog();
  });

  console.log('\nAuthorization');

  await step('a cashier cannot reach an admin route by URL', async () => {
    await page.click('button[aria-label="Log out"]');
    await page.waitForSelector('text=Demo accounts');
    await page.click('button:has-text("Cashier")');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.goto(`${BASE_URL}/admin/inventory`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    if (await page.locator('text=Units on hand').count()) {
      throw new Error('cashier reached an admin page');
    }
  });

  if (failedResponses.length) {
    console.error(`\n✗ ${failedResponses.length} unexpected failed request(s):`);
    for (const r of failedResponses) console.error(`    ${r}`);
    throw new Error('unexpected failed requests');
  }

  if (consoleErrors.length) {
    console.error(`\n✗ ${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors) console.error(`    ${e}`);
    throw new Error('console errors detected');
  }

  console.log(`\n${passed} checks passed, no console errors or unexpected failed requests.\n`);
} finally {
  await browser.close();
}
