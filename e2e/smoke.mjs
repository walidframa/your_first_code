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
const ALLOWED_FAILURES = [/\/api\/products\/lookup/];

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
    await page.click('button:has-text("Charge $")');
    await page.waitForSelector('text=Take payment');
  });
  await shot('payment');

  await step('register shows the pound equivalent of the total', async () => {
    await page.waitForSelector('text=In pounds');
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

  await step('cashier can switch the change currency', async () => {
    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('button', { name: 'US dollars' }).last().click();
    await page.waitForSelector('text=/Confirm · change \\$/');
    await dialog.getByRole('button', { name: 'Lebanese pounds' }).last().click();
    await page.waitForSelector('text=/Confirm · change [\\d,]+ LL/');
  });

  await step('confirming payment shows the receipt', async () => {
    await page.click('button:has-text("Confirm · change")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.waitForSelector('text=/Give [\\d,]+ LL change/');
    await page.waitForSelector('text=Paid in pounds');
  });
  await shot('receipt');

  await step('closing the receipt clears the cart', async () => {
    await page.click('button:has-text("New sale")');
    await page.waitForSelector('text=No items yet');
  });

  await step('F2 does nothing with an empty cart', async () => {
    await page.keyboard.press('F2');
    await page.waitForTimeout(300);
    if (await page.locator('text=Take payment').count()) {
      throw new Error('F2 opened payment with an empty cart');
    }
  });

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
    await page.click('button:has-text("New document")');
    await page.waitForSelector('text=New document');

    const dialog = page.locator('[role=dialog]');
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
    await page.getByLabel('Show the price in pounds too').uncheck();
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

  await step('a quotation converts to a sales order', async () => {
    await page.click('a[title="Documents"]');
    await page.click('button:has-text("New document")');
    const dialog = page.locator('[role=dialog]');
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
    await page.click('button:has-text("New document")');
    const dialog = page.locator('[role=dialog]');
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

    await page.click('button:has-text("Charge $")');
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
