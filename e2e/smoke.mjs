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
// And deleting a category that still holds products is refused on purpose —
// the 409 carries the count, which is what the confirmation is built from.
// And a support ticket that is not good is offered on purpose: the 401 is the
// thing being checked, because a spent or guessed link must not be a way in.
const ALLOWED_FAILURES = [
  /\/api\/products\/lookup/,
  /\/api\/shopify\/connect/,
  /\/api\/products\/categories\/\d+$/,
  /\/api\/support\/redeem/,
];

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

/**
 * Shut the dialogs and make sure they stay shut.
 *
 * Saving a document closes the form and opens the saved document in its place,
 * so for a moment there is one modal going and another arriving. Close during
 * that moment — which is a matter of milliseconds, and so happens on a loaded
 * CI runner and never on a developer's machine — and the second one is left
 * standing with its backdrop across the whole screen.
 *
 * Nothing about that looks broken. The backdrop is invisible, the menu beneath
 * it is plainly there, and the next click on it is simply swallowed, surfacing
 * thirty seconds later as a timeout on a step that had nothing to do with it.
 *
 * So: close every layer rather than the first, and having seen the last one go,
 * wait and look again before walking away.
 */
async function closeDialog() {
  const overlay = () => page.locator('[role=presentation]');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await overlay().count()) {
      const close = page.locator('[role=dialog]').last().getByRole('button', { name: 'Close' });
      if (await close.count()) await close.first().click().catch(() => {});
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(400);
    if (!(await overlay().count())) return;
  }

  await overlay().first().waitFor({ state: 'detached', timeout: 10000 });
}

async function shot(name) {
  if (!SHOT_DIR) return;
  shotIndex += 1;
  await page.screenshot({ path: `${SHOT_DIR}/${String(shotIndex).padStart(2, '0')}-${name}.png` });
}

const scanBox = 'input[aria-label="Scan barcode or search products"]';

/**
 * The way to the menu, whichever one is on screen.
 *
 * There are two links to it and only ever one of them is showing: the rail's,
 * on a wide screen with the rail out, and the top bar's everywhere else. A
 * plain text match finds both and clicks the hidden one.
 */
async function openMenu() {
  await page.locator('a[href="/menu"]:visible').first().click();
  await page.waitForSelector('a[href="/orders"]:visible', { timeout: 15000 });
}

/**
 * Go to a screen by name, from wherever we happen to be.
 *
 * The rail is not on every screen any more — the register keeps the whole
 * window — so a click straight at a rail link is a click at something that may
 * not be there. This uses whichever route is showing: the rail if it is out,
 * the page of tiles if it is not.
 */
async function goTo(title) {
  const link = `a[title="${title}"]:visible`;
  if (!(await page.locator(link).count())) await openMenu();
  await page.locator(link).first().click();
}




/*
 * Signing in, the way a real shop has to.
 *
 * A fresh copy ships with `admin/admin123`, and the app insists on a real
 * password the first time each of those accounts is used — so the suite carries
 * the current password for each and changes it on the way past the gate, rather
 * than pretending the shipped ones keep working. Every later sign-in types the
 * real one, because the one-tap demo buttons vanish once they stop being true.
 */
/** Sign out from wherever the button happens to be — rail, or top bar. */
async function signOut() {
  await page.locator('button[aria-label="Log out"]:visible').first().click();
  await page.waitForSelector('input[name=username]', { timeout: 15000 });
}

const PASSWORDS = { admin: 'admin123', cashier: 'cashier123' };
const REAL = { admin: 'owner-real-password', cashier: 'till-real-password' };

async function signIn(username) {
  await page.waitForSelector('input[name=username]', { timeout: 15000 });
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', PASSWORDS[username]);
  await page.click('button[type=submit]');

  /*
   * First time for this account, the app stops here and asks for a real one.
   *
   * Waited for by the form going away rather than by any wording on the page
   * after it — this same helper is used with the app in Arabic, where none of
   * the English would match and the wait would burn its whole timeout.
   */
  const gate = page.locator('input[name=currentPassword]');
  await Promise.race([
    gate.waitFor({ timeout: 15000 }).catch(() => {}),
    page.locator('input[name=username]').waitFor({ state: 'detached', timeout: 15000 }),
  ]);

  if (await gate.count()) {
    await page.fill('input[name=currentPassword]', PASSWORDS[username]);
    await page.fill('input[name=newPassword]', REAL[username]);
    await page.fill('input[name=newPasswordAgain]', REAL[username]);
    await page.click('button[type=submit]');
    await gate.waitFor({ state: 'detached', timeout: 15000 });
    PASSWORDS[username] = REAL[username];
  }
}

try {
  console.log('\nRegister (cashier)');

  await step('login page renders', async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Front Desk POS');
  });
  await shot('login');

  await step('sign in as cashier', async () => {
    await signIn('cashier');
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
    await page.waitForSelector('button[aria-label$="the drawer detail"]', { timeout: 15000 });
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

  await step('the receipt can be sent to the customer on WhatsApp', async () => {
    const wa = page.locator('[role=dialog] a[href^="https://wa.me/"]');
    await wa.waitFor({ timeout: 10000 });
    const message = decodeURIComponent(
      new URL(await wa.getAttribute('href')).searchParams.get('text'),
    );
    // What a receipt is for: which shop, which sale, and what it came to.
    for (const expected of ['ORD-', 'Total:', 'LL']) {
      if (!message.includes(expected)) throw new Error(`the receipt message is missing ${expected}`);
    }
  });

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
    await page.waitForSelector('button[aria-label$="the drawer detail"]', { timeout: 15000 });
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

  /*
   * A phone left in to be fixed. It is counter work and it ends with paper —
   * the customer brings the ticket back to prove which phone is theirs.
   */
  await step('a repair is taken in at the register and prints a ticket', async () => {
    // F6 rather than the button: it is the shortcut a busy counter uses, and
    // the button is tested by the fact the dialog opens either way.
    await page.keyboard.press('F6');
    await page.waitForSelector('[role=dialog] >> text=Write it down while they are here', {
      timeout: 10000,
    });

    await page.fill('input[name=customerName]', 'Rami Haddad');
    await page.fill('input[name=customerPhone]', '03 123 456');
    await page.fill('input[name=device]', 'iPhone 12 Pro, black');
    await page.fill('textarea[name=fault]', 'Screen cracked, touch dead at the top');
    await page.fill('input[name=passcode]', '4417');
    await page.fill('input[name=quoted]', '85');
    await page.click('button:has-text("Take it in")');

    // Straight to the slip, because the customer is still standing there.
    await page.waitForSelector('text=/REP-\\d+ taken in/', { timeout: 15000 });
    const dialog = page.locator('[role=dialog]');
    await dialog.locator('text=Rami Haddad').waitFor();
    await dialog.locator('text=iPhone 12 Pro, black').waitFor();
    await dialog.locator('text=$85.00').first().waitFor();
    await dialog.locator('text=Please bring this ticket').waitFor();

    // The passcode is a credential. It is stored, but it does not go in a
    // customer's pocket.
    if (await dialog.locator('text=4417').count()) {
      throw new Error('the passcode was printed on the ticket');
    }

    /*
     * And the same ticket as a WhatsApp message, which is what the customer
     * will still have in a week when the paper slip has gone through the wash.
     * The link is checked rather than followed — pressing it would hand the
     * browser over to whatever WhatsApp is installed.
     */
    const wa = dialog.locator('a[href^="https://wa.me/"]');
    await wa.waitFor({ timeout: 10000 });
    const href = await wa.getAttribute('href');
    const message = decodeURIComponent(new URL(href).searchParams.get('text'));

    if (!href.startsWith('https://wa.me/9613123456?')) {
      throw new Error(`the message is addressed to the wrong number: ${href}`);
    }
    for (const expected of ['REP-', 'iPhone 12 Pro', 'Screen cracked', '$85.00']) {
      if (!message.includes(expected)) throw new Error(`the message is missing ${expected}`);
    }
    // The passcode is not on the paper and must not be in the message either.
    if (message.includes('4417')) throw new Error('the passcode went out over WhatsApp');

    await page.click('button:has-text("Done")');
    await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 10000 });
  });

  await step('the sale appears in My sales', async () => {
    // Through the menu, because the register keeps the whole window now and the
    // rail is not on it. Two presses, both of them large.
    await openMenu();
    await page.click('a[href="/orders"]');
    await page.waitForSelector('text=ORD-', { timeout: 10000 });
  });

  await step('cashiers see no admin navigation', async () => {
    // Checked on the menu rather than the rail: that is where a cashier's whole
    // list of doors is now, so it is where an extra one would show up.
    await openMenu();
    if (await page.locator('a[href="/admin/products"]').count()) {
      throw new Error('cashier sees admin nav');
    }
    if (await page.locator('a[title="Dashboard"]').count()) throw new Error('cashier sees admin nav');
  });

  console.log('\nBack office (admin)');

  await step('sign in as admin', async () => {
    await signOut();
    await signIn('admin');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
  });

  await step('dashboard renders every panel', async () => {
    await goTo('Dashboard');
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
    await goTo('Inventory');
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
    await goTo('Products');
    await page.waitForSelector('text=New product', { timeout: 15000 });
    await page.click('button:has-text("New product")');
    await page.waitForSelector('[role=dialog] >> text=Track each one by IMEI');

    const dialog = page.locator('[role=dialog]');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Galaxy A15');
    await dialog.getByRole('textbox', { name: 'SKU', exact: true }).fill('PH-A15');
    await dialog.getByRole('spinbutton', { name: 'Price', exact: true }).fill('189');
    await dialog.getByRole('spinbutton', { name: 'Cost', exact: true }).fill('150');
    // Named: "Sold as a SIM" sits beside it now, and a bare checkbox is two.
    await dialog.getByRole('checkbox', { name: /Track each one by IMEI/ }).check();
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
    await goTo('Register');
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
    await goTo('Trade-ins');
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

    /*
     * The seller's ID, which is what makes the purchase documented — a used
     * handset with no record of who sold it is the one the shop cannot account
     * for later. Set through the file input rather than the camera, which is
     * what a desktop does with the same control.
     */
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'id.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
        'base64',
      ),
    });
    await dialog.locator('img[alt="The seller’s ID"]').waitFor({ timeout: 10000 });

    // What it costs the shop, worked out before the money leaves the drawer.
    await page.waitForSelector('text=/Costs the shop/');
    await dialog.getByRole('button', { name: 'Buy it in' }).click();

    await page.waitForSelector('text=357700556644331', { timeout: 15000 });
    await page.waitForSelector('text=On the shelf');
    await page.waitForSelector('text=ID on file', { timeout: 15000 });
  });

  await step('the seller’s ID can be opened, and deleted', async () => {
    await page.click('button:has-text("ID on file")');
    await page.waitForSelector('[role=dialog] >> text=Seller’s ID', { timeout: 10000 });

    const shown = page.locator('[role=dialog] img[alt="The seller’s ID"]');
    await shown.waitFor({ timeout: 15000 });
    // Actually decoded by the browser, not a broken image with a src on it.
    if (!(await shown.evaluate((el) => el.naturalWidth > 0))) {
      throw new Error('the ID did not load as an image');
    }

    await page.click('button:has-text("Delete the ID")');
    await page.waitForSelector('text=/The ID was deleted/', { timeout: 15000 });
    // The purchase itself survives losing its photograph.
    await page.waitForSelector('text=357700556644331', { timeout: 15000 });
    await page.waitForSelector('text=no ID', { timeout: 15000 });
  });

  await step('the starter card catalogue loads and a wallet is topped up', async () => {
    await goTo('Cards');
    await page.waitForSelector('text=/sold from credit/', { timeout: 15000 });

    await page.click('button:has-text("Load the Lebanese starter set")');
    await page.waitForSelector('text=/Added \\d+ cards/', { timeout: 15000 });
    await page.waitForSelector('text=ALFA 7.58 · 1 month', { timeout: 15000 });
    await page.waitForSelector('text=Whole Recharge');
    await page.waitForSelector('text=Gift Cards');
    // Validity is seeded too, and seeded unlinked — the shop says which card
    // really delivers its 30 days, so the screen has to admit it does not know.
    await page.waitForSelector('text=Validity');
    await page.waitForSelector('text=Not linked yet');

    /*
     * The recharge ladder the carriers actually print, padded the way they
     * print it, carrying the credit inside rather than a price. Round $5 and
     * $10 cards are not sold in Lebanon and are not offered here.
     */
    await page.waitForSelector('text=Alfa $03.79');
    await page.waitForSelector('text=Touch $77.28');
    await page.waitForSelector('text=carries $7.58 of credit');
    if (await page.locator('text=Alfa whole recharge $5').count()) {
      throw new Error('a denomination no carrier sells is still on offer');
    }

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
    await goTo('Cards');
    await page.waitForSelector('text=Mobile recharge', { timeout: 15000 });
    // What the card costs the shop, so the wallet moves by a real figure.
    await page.getByRole('button', { name: 'Edit ALFA 10 · 1 month' }).click();
    await page.locator('[role=dialog] #cost').fill('2.75');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Card updated', { timeout: 15000 });

    await goTo('Register');
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
    await goTo('Cards');
    await page.waitForSelector('text=$489.00', { timeout: 15000 });
  });

  await step('a validity card is linked, and selling one moves all three balances', async () => {
    await goTo('Cards');
    await page.waitForSelector('text=Not linked yet', { timeout: 15000 });

    // Say what an Alfa month really is: a whole card scratched, and $6 of it
    // sent back to the shop's own line.
    await page
      .locator('tr', { hasText: 'Alfa 30 days' })
      .getByRole('button', { name: 'Not linked yet' })
      .click();
    await page.waitForSelector('[role=dialog] >> text=What selling one of these does', { timeout: 10000 });

    /*
     * Opened with nothing filled in, it says so. A card picked with the credit
     * left at nothing sells the days and moves no money at all — which reads as
     * configured on every screen unless somebody says otherwise.
     */
    await page.waitForSelector('[role=dialog] >> text=No credit will reach a carrier balance');

    /*
     * Picking a card that carries credit fills the figure in. Typing it from
     * nothing is what got left at zero, and zero is the silent failure.
     */
    const carrying = await page
      .locator('[role=dialog] #linkedCard option')
      .evaluateAll((opts) => opts.find((o) => o.textContent.includes('Alfa $07.58'))?.value);
    if (!carrying) throw new Error('the $7.58 recharge card is not offered as a delivering card');
    await page.locator('[role=dialog] #linkedCard').selectOption(carrying);
    await page.waitForTimeout(300);
    const prefilled = await page.locator('[role=dialog] #creditRecovered').inputValue();
    if (prefilled !== '7.58') {
      throw new Error(`picking a $7.58 card left the credit at "${prefilled}"`);
    }

    // The cost was set to $2.75 by the previous step, and the option says so.
    await page.locator('[role=dialog] #linkedCard').selectOption({ label: 'ALFA 10 · 1 month · costs $2.75' });
    // Trimmed to what the shop really keeps off the card.
    await page.locator('[role=dialog] #creditRecovered').fill('6');
    await page.locator('[role=dialog] #creditWallet').selectOption({ label: 'Alfa' });
    await page.waitForSelector('[role=dialog] >> text=No credit will reach a carrier balance', {
      state: 'detached',
      timeout: 5000,
    });
    await page.locator('[role=dialog]').getByRole('button', { name: 'Save the link' }).click();
    await page.waitForSelector('text=/linked$/', { timeout: 15000 });
    await page.waitForSelector('text=$6.00 back to Alfa', { timeout: 15000 });

    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.getByRole('button', { name: 'Validity', exact: true }).click();
    await page.getByRole('button', { name: /Alfa 30 days/ }).first().click();
    await page.waitForSelector('aside >> text=Alfa 30 days', { timeout: 10000 });

    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector('[role=dialog] >> text=Take payment', { timeout: 15000 });
    await page.click('[role=dialog] button:has-text("Card")');
    await page.click('[role=dialog] button:has-text("Confirm $")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.click('button:has-text("New sale")');

    /*
     * Nobody typed either of these. The recharge wallet paid $2.75 for the card
     * that was scratched ($489.00 → $486.25), and $6 of credit landed on Alfa.
     */
    await goTo('Cards');
    await page.waitForSelector('text=$486.25', { timeout: 15000 });
    await goTo('Accounts');
    await page.waitForSelector('text=$6.00', { timeout: 15000 });
  });

  await step('a held account is found and its password revealed to an admin', async () => {
    await goTo('Logins');
    await page.waitForSelector('text=Search for a customer', { timeout: 15000 });

    // Whatever the customer remembers: here, the number they called from.
    await page.fill('input[aria-label="Find a held account"]', '03 456');
    await page.waitForSelector('text=rami@icloud.com', { timeout: 10000 });

    await page.getByRole('button', { name: 'Show password' }).first().click();
    await page.waitForSelector('text=hunter2', { timeout: 10000 });
  });

  await step('import wizard accepts the sample catalog', async () => {
    await goTo('Import');
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
    await goTo('Products');
    await page.waitForSelector('text=Cold Brew', { timeout: 15000 });
  });
  await shot('products');

  /*
   * A supplier sends Excel, not CSV, and saving it out of Excel as CSV is what
   * turns a 13-digit barcode into 1.23457E+12. The fixture carries the things
   * that actually go wrong: a title above the header, a gap mid-row, a second
   * sheet that is not the price list.
   */
  await step('an Excel file imports, sheet and all', async () => {
    await goTo('Import');
    await page.waitForSelector('text=Drop a CSV file here', { timeout: 15000 });
    await page.locator('input[type=file]').setInputFiles('server/test/fixtures/supplier-catalogue.xlsx');
    await page.waitForSelector('text=Source format', { timeout: 20000 });

    // Two sheets, so the shop is asked which — and the price list is not the
    // first tab.
    await page.getByLabel('Sheet').selectOption('Price list');
    await page.waitForSelector('text=/Item Name|Product name/', { timeout: 15000 });

    await page.click('button:has-text("Review")');
    await page.waitForSelector('td:has-text("Braided USB-C cable")', { timeout: 15000 });
    // The accented name survived the trip, and so did the row with a gap in it.
    await page.waitForSelector('td:has-text("Café screen protector")');

    await page.click('button:has-text("Import 3 products")');
    await page.waitForSelector('text=Import complete', { timeout: 20000 });
  });

  await step('the long barcode came through the spreadsheet intact', async () => {
    await goTo('Products');
    await page.waitForSelector('text=Braided USB-C cable', { timeout: 15000 });

    const found = await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token') || sessionStorage.getItem('pos_token');
      const res = await fetch('/api/products', { headers: { Authorization: `Bearer ${token}` } });
      const { products } = await res.json();
      return products.find((p) => p.sku === 'CBL-01');
    });

    // Exported to CSV by Excel this arrives as 6.29104E+12 and is ruined.
    if (found.barcode !== '6291041500213') {
      throw new Error(`barcode came through as ${found.barcode}`);
    }
    if (found.price !== 3.5) throw new Error(`price came through as ${found.price}`);
  });

  /*
   * Categories could be made but never unmade, so a shop a year in has three
   * spellings of "Accessories" and no way to tidy them.
   */
  await step('a category can be renamed, and deleting one keeps its products', async () => {
    await page.click('button:has-text("Categories")');
    await page.waitForSelector('[role=dialog] >> text=How the catalogue is sorted', { timeout: 15000 });
    const dialog = page.locator('[role=dialog]');

    await dialog.getByLabel('Add a category').fill('Chargrs');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await dialog.locator('text=Chargrs').waitFor({ timeout: 15000 });

    await dialog.getByRole('button', { name: 'Rename Chargrs' }).click();
    await page.keyboard.type('Chargers');
    await page.keyboard.press('Enter');
    await dialog.locator('text=Chargers').waitFor({ timeout: 15000 });

    // One the import created, which still holds products — so it asks first.
    await dialog.getByRole('button', { name: 'Delete Accessories' }).click();
    await page.waitForSelector('text=/Delete .Accessories/', { timeout: 15000 });
    await page.click('button:has-text("Delete anyway")');
    await page.waitForSelector('text=/no category now/', { timeout: 15000 });

    await page.click('button:has-text("Done")');
    // The products it held are still in the catalogue, still selling.
    await page.waitForSelector('text=Braided USB-C cable', { timeout: 15000 });
  });

  /*
   * A SIM is bought from a supplier and sold by the number on the card, and
   * the line is registered to a person — so the buyer's ID goes with it.
   */
  await step('SIMs are booked in by number and sold with the buyer’s ID', async () => {
    await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token');
      await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: 'Alfa prepaid SIM',
          sku: 'SIM-ALFA-E2E',
          price: 5,
          cost: 3,
          tracks_units: true,
          is_sim: true,
        }),
      });
    });

    await page.goto(`${BASE_URL}/admin/sims`, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Book in SIMs")');
    await page.waitForSelector('[role=dialog] >> text=One number per line', { timeout: 10000 });

    const book = page.locator('[role=dialog]');
    await book.getByLabel('What each one cost').fill('3');
    await book.locator('#simNumbers').fill('03 111 222\n76 333 444');
    await book.getByRole('button', { name: /Book in/ }).click();
    await page.waitForSelector('text=/2 SIMs booked in/', { timeout: 15000 });
    await page.waitForSelector('text=9613111222', { timeout: 15000 });
  });
  await shot('sims');

  await step('a SIM is sold at the register on F7, ID and all', async () => {
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.keyboard.press('F7');
    await page.waitForSelector('[role=dialog] >> text=Find it by the number on the card', {
      timeout: 10000,
    });

    const sell = page.locator('[role=dialog]');
    // Typed the way it is written on the card, not the way it is stored.
    await sell.getByLabel('Phone number').fill('03 111 222');
    await sell.getByRole('button', { name: 'Find' }).click();
    await sell.locator('text=Alfa prepaid SIM').waitFor({ timeout: 10000 });

    await sell.getByLabel("Buyer's name").fill('Ali Hassan');
    await sell.locator('input[type=file]').setInputFiles({
      name: 'id.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
        'base64',
      ),
    });
    await sell.locator('img[alt="The seller\u2019s ID"]').waitFor({ timeout: 10000 });
    await sell.getByRole('button', { name: 'Add to the sale' }).click();
    await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 10000 });
    await page.waitForSelector('text=9613111222', { timeout: 10000 });
  });

  /*
   * The arithmetic the shop's money depends on: the carrier takes 3, 2 or 1 per
   * message, and every message costs 0.15 off the balance. $10 is four sends
   * and $10.60, not $10.
   */
  await step('credit is split into messages and priced with its fees', async () => {
    await page.keyboard.press('F8');
    await page.waitForSelector('[role=dialog] >> text=Send to a customer', { timeout: 10000 });

    const credit = page.locator('[role=dialog]');
    await credit.getByLabel("Customer's number").fill('03 123 456');

    /*
     * Typed a digit at a time, the way a cashier types it — and the way that
     * used to sell $10 of credit for the price of $1.
     *
     * "10" quotes "1" on the way past. A price seeded from that first keystroke
     * stuck, with the pound figure beside it still reading 1,100,000 and the
     * margin still positive, so nothing on the screen objected. The price has
     * to be the same however the amount arrived, which is what this asserts —
     * no rate hardcoded, because the point is that the two agree.
     */
    await credit.getByLabel('How much credit').click();
    await page.keyboard.type('1', { delay: 250 });
    await page.waitForTimeout(700);
    const forOne = Number(await credit.getByLabel('Charge the customer').inputValue());

    await page.keyboard.type('0', { delay: 250 });
    await credit.locator('text=Send 4 messages').waitFor({ timeout: 10000 });
    await page.waitForTimeout(700);
    const forTen = Number(await credit.getByLabel('Charge the customer').inputValue());

    if (!(forOne > 0)) throw new Error('a dollar of credit was not priced at all');
    // Ten times the credit is ten times the price, give or take the rounding
    // on each. Left stale, the second reading is still the first one.
    if (Math.abs(forTen - forOne * 10) > 0.2) {
      throw new Error(`$1 priced at ${forOne} but $10 priced at ${forTen}`);
    }

    await credit.locator('text=Send 4 messages').waitFor({ timeout: 10000 });
    const shown = await credit.innerText();
    /*
     * The three figures the shop's money turns on: what the balance loses
     * (fees included), the counter price in pounds, and what it really cost.
     */
    for (const expected of ['$10.60', '4 × $0.15', '110,000 a dollar']) {
      if (!shown.includes(expected)) throw new Error(`the credit panel is missing ${expected}`);
    }
    /*
     * And whose money the fees are, said in words. The customer is charged for
     * the credit they asked for; the messages are the shop's cost of getting it
     * to them and come off the balance. Two figures a few lines apart get read
     * the wrong way round, and the wrong way round is sixty cents a time.
     */
    if (!shown.includes('comes off Alfa, not off them')) {
      throw new Error('the panel does not say who pays the message fees');
    }

    await credit.getByRole('button', { name: /Add to the sale/ }).click();
    await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 10000 });
    await page.waitForSelector('text=/Alfa credit/', { timeout: 10000 });
  });
  await shot('credit');

  await step('paying for both leaves the carrier and the shelf right', async () => {
    await page.click('aside button:has-text("Charge $")');
    await page.click('[role=dialog] button:has-text("Card")');
    await page.click('[role=dialog] button:has-text("Confirm $")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.click('button:has-text("New sale")');

    const state = await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token');
      const h = { Authorization: `Bearer ${token}` };
      const carriers = await (await fetch('/api/credit/carriers', { headers: h })).json();
      const sims = await (await fetch('/api/sims?status=sold', { headers: h })).json();
      return {
        alfa: carriers.carriers.find((c) => c.name === 'Alfa').balance,
        sold: sims.sims.find((s) => s.msisdn === '9613111222'),
      };
    });

    /*
     * The only credit Alfa ever received in this run is the $6 the validity
     * sale put there by itself, and the only thing taken off is this top-up:
     * the $10 sent plus four message fees.
     */
    if (state.alfa !== -4.6) throw new Error(`Alfa balance is ${state.alfa}, expected -4.6`);
    if (!state.sold) throw new Error('the SIM did not leave the shelf');
    if (!state.sold.has_id_photo) throw new Error('the buyer’s ID was not kept');

    // Back where the steps below expect to be standing.
    await goTo('Products');
    await page.waitForSelector('button:has-text("New product")', { timeout: 15000 });
  });

  await step('the back-office groups fold away', async () => {
    // Stock holds the page we are on, so it stays open however it is set —
    // otherwise arriving somewhere hides it from the menu.
    await page.click('aside button:has-text("Setup")');
    await page.waitForSelector('aside a[title="Settings"]', { state: 'detached', timeout: 10000 });

    await page.click('aside button:has-text("Setup")');
    await page.waitForSelector('aside a[title="Settings"]', { timeout: 10000 });
  });

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
    await goTo('Register');
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

  await step('one item off a sale comes back, and the rest of it stands', async () => {
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    // Three of one thing, so there is something to return part of.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    const tile = page.getByRole('button', { name: /Chocolate Bar/ }).first();
    for (const _ of [1, 2, 3]) {
      await tile.click();
      await page.waitForTimeout(120);
    }
    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector('[role=dialog] >> text=Take payment', { timeout: 15000 });
    await page.click('[role=dialog] button:has-text("Card")');
    await page.click('[role=dialog] button:has-text("Confirm $")');
    await page.waitForSelector('text=Payment complete', { timeout: 15000 });
    await page.click('button:has-text("New sale")');

    /*
     * Found from the register rather than the back office: the sale somebody
     * wants to correct is nearly always the last one, and the customer is still
     * at the counter.
     */
    await page.click('aside button:has-text("Sales")');
    await page.waitForSelector("[role=dialog] >> text=This register's sales", { timeout: 10000 });
    await page.locator('[role=dialog] tbody tr').first().click();
    await page.waitForSelector('[role=dialog] >> text=Void the whole sale', { timeout: 10000 });

    await page.locator('[role=dialog]').last().getByRole('button', { name: 'Return' }).first().click();
    await page.waitForSelector('[role=dialog] >> text=How many are coming back', { timeout: 10000 });
    await page.locator('#returnQuantity').fill('1');
    await page.getByRole('button', { name: 'Take it back' }).click();
    await page.waitForSelector('text=/back to the customer/', { timeout: 15000 });

    /*
     * One of three: the line says so, the sale is still a sale, and what went
     * back is the line's share of the total — tax included — rather than its
     * price on the shelf.
     */
    await page.waitForSelector('[role=dialog] >> text=1 returned', { timeout: 10000 });
    const state = await page.evaluate(async () => {
      const h = { Authorization: `Bearer ${localStorage.getItem('pos_token')}` };
      const list = await (await fetch('/api/orders?scope=sitting', { headers: h })).json();
      const detail = await (await fetch(`/api/orders/${list.orders[0].id}`, { headers: h })).json();
      return { status: detail.order.status, returned: detail.items[0].returned_qty };
    });
    if (state.status !== 'completed') throw new Error('one item back should not void the sale');
    if (state.returned !== 1) throw new Error(`the line says ${state.returned} came back, not 1`);

    await closeDialog();
  });

  await step('refunding an order works', async () => {
    await goTo('Orders');
    await page.waitForSelector('text=ORD-', { timeout: 15000 });
    await page.click('td:has-text("ORD-") >> nth=0');
    await page.waitForSelector('button:has-text("Void the whole sale")');
    await page.click('button:has-text("Void the whole sale")');
    await page.waitForSelector('text=Refunded', { timeout: 15000 });
  });

  await step('a cost can be typed in pounds, and is kept in dollars', async () => {
    await goTo('Products');
    await page.click('button:has-text("New product")');
    await page.waitForSelector('[role=dialog]', { timeout: 10000 });

    // What a dealer actually quotes, rather than the division done in somebody's
    // head at the counter.
    await page.locator('[role=dialog]').getByRole('button', { name: 'LL' }).nth(1).click();
    await page.locator('[role=dialog] #cost').fill('890000');
    await page.waitForSelector('[role=dialog] >> text=Saved as $10.00', { timeout: 10000 });
    await closeDialog();
  });

  await step('the text can be made bigger, and stays that way', async () => {
    await goTo('Settings');
    await page.waitForSelector('text=Text size', { timeout: 15000 });
    await page.getByRole('button', { name: 'Large' }).click();

    const grown = await page.evaluate(() => document.documentElement.style.fontSize);
    if (grown !== '120%') throw new Error(`large left the root font at ${grown}`);

    // Remembered on the device, so a till set up once stays set up.
    await page.reload();
    await page.waitForSelector('text=Text size', { timeout: 15000 });
    const afterReload = await page.evaluate(() => document.documentElement.style.fontSize);
    if (afterReload !== '120%') throw new Error(`a reload forgot the size, leaving ${afterReload}`);

    await page.getByRole('button', { name: 'Default' }).click();
  });

  await step('staff page lists accounts', async () => {
    await goTo('Staff');
    await page.waitForSelector('text=Store Owner', { timeout: 15000 });
  });

  await step('admin can add a customer with a credit limit', async () => {
    await goTo('Customers');
    await page.waitForSelector('text=Total owed to you', { timeout: 15000 });
    await page.click('button:has-text("New customer")');
    await page.waitForSelector('text=New customer');
    await page.fill('input[name="name"], [role=dialog] input >> nth=0', 'Rami Haddad');
    // A number on file, so a document addressed to them can be sent later.
    await page.locator('[role=dialog]').getByLabel('Phone').fill('03 123 456');
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

  await step('a phone paid off over months is scheduled, and the ledger stays boss', async () => {
    // The step before this one leaves a dialog open.
    await closeDialog();

    /*
     * A customer of this step's own, carrying the phone on their account.
     *
     * Their own, because a plan moves what somebody owes, and the customer the
     * later steps use is on a $200 limit — putting a phone on that account here
     * would leave them over it, and the account sale further down would be
     * refused for a reason that had nothing to do with it.
     *
     * Charged first, which is the order it happens at the counter and the whole
     * point of the design: a plan schedules a debt that already exists.
     */
    await page.evaluate(async () => {
      const h = {
        Authorization: `Bearer ${localStorage.getItem('pos_token')}`,
        'Content-Type': 'application/json',
      };
      const made = await (
        await fetch('/api/customers', {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ name: 'Nadia Khoury', phone: '03 987 654', credit_limit: 1000 }),
        })
      ).json();
      await fetch(`/api/customers/${made.party.id}/charges`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ amount: 400, note: 'iPhone 13' }),
      });
    });

    await goTo('Instalments');
    await page.waitForSelector('text=Out on plans', { timeout: 15000 });

    await page.click('button:has-text("New plan")');
    await page.waitForSelector('[role=dialog] >> text=Paying off what is already owed', { timeout: 10000 });

    // The picker opens a second dialog on top of this one.
    await page.locator('[role=dialog]').getByRole('button', { name: 'Add customer' }).click();
    await page.waitForSelector('[role=dialog] >> text=Choose a customer', { timeout: 10000 });
    await page.locator('input[placeholder*="Search by name"]').fill('Nadia');
    await page.waitForTimeout(500);
    await page.locator('[role=dialog]').last().locator('button:has-text("Nadia")').first().click();

    const plan = page.locator('[role=dialog]').last();
    await plan.locator('#total').fill('400');
    await plan.locator('#count').selectOption('4');
    await plan.locator('#note').fill('iPhone 13');
    // Said back before it is set up, so nobody schedules a figure they did not mean.
    await page.waitForSelector('[role=dialog] >> text=/About \\$100\\.00/', { timeout: 5000 });
    await plan.getByRole('button', { name: 'Set it up' }).click();
    await page.waitForSelector('text=/4 payments set up/', { timeout: 15000 });

    const owedBefore = await page.evaluate(async () => {
      const h = { Authorization: `Bearer ${localStorage.getItem('pos_token')}` };
      const r = await (await fetch('/api/installments', { headers: h })).json();
      const p = r.plans.find((x) => x.note === 'iPhone 13');
      const c = await (await fetch(`/api/customers/${p.customer_id}`, { headers: h })).json();
      return { outstanding: p.outstandingUsd, owes: c.party.balance };
    });
    if (owedBefore.outstanding !== 400) throw new Error('the plan should be for the whole 400');

    // A payment settles the earliest month and comes off what they owe.
    await page.locator('.grid > div', { hasText: 'iPhone 13' }).first()
      .getByRole('button', { name: 'Take a payment' }).click();
    await page.waitForSelector('[role=dialog] >> text=How much', { timeout: 10000 });
    await page.locator('[role=dialog]').last().getByRole('button', { name: 'Take it' }).click();
    await page.waitForSelector('text=/left$/', { timeout: 15000 });

    const after = await page.evaluate(async () => {
      const h = { Authorization: `Bearer ${localStorage.getItem('pos_token')}` };
      const r = await (await fetch('/api/installments', { headers: h })).json();
      const p = r.plans.find((x) => x.note === 'iPhone 13');
      const c = await (await fetch(`/api/customers/${p.customer_id}`, { headers: h })).json();
      return { outstanding: p.outstandingUsd, first: p.dues[0].paid_usd, owes: c.party.balance };
    });
    if (after.first !== 100) throw new Error(`the first month took ${after.first}, not 100`);
    if (after.outstanding !== 300) throw new Error(`the plan says ${after.outstanding} left, not 300`);
    /*
     * The plan is a schedule over a debt, never a second set of books — so the
     * customer's balance had to move by the same hundred.
     */
    if (Math.round((owedBefore.owes - after.owes) * 100) / 100 !== 100) {
      throw new Error('the ledger and the plan disagree about the payment');
    }
  });

  await step('a backup can be taken, and says what must travel with it', async () => {
    await goTo('Settings');
    await page.waitForSelector('text=Backups', { timeout: 15000 });

    await page.getByRole('button', { name: 'Back up now' }).click();
    await page.waitForSelector('text=/Backup taken/', { timeout: 20000 });

    /*
     * The warning is the feature. A backup carried off without server/.env has
     * every stored customer password unreadable, and there is no fixing that
     * afterwards — so it must be on the screen somebody copies the file from.
     */
    await page.waitForSelector('text=server/.env', { timeout: 5000 });
    await page.waitForSelector('text=/unreadable for good/', { timeout: 5000 });

    // And the copy is real: it appears in the list with a size on it.
    await page.waitForSelector('button:has-text("Download")', { timeout: 10000 });
  });

  await step('a supplier bill shows up as a payable', async () => {
    await page.keyboard.press('Escape');
    await goTo('Suppliers');
    await page.waitForSelector('text=Total you owe', { timeout: 15000 });
    await page.click('button:has-text("New supplier")');
    await page.fill('[role=dialog] input >> nth=0', 'Corner Bakehouse');
    await page.click('button:has-text("Add")');
    await page.waitForSelector('td:has-text("Corner Bakehouse")', { timeout: 15000 });
  });
  await shot('suppliers');

  await step('a purchase invoice receives stock and creates a payable', async () => {
    // Note the stock level before receiving.
    await goTo('Inventory');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });
    const unitsOnHand = async () =>
      Number((await page.locator('p:has-text("Units on hand") + p').innerText()).replace(/,/g, ''));
    const before = await unitsOnHand();

    await goTo('Documents');
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

    await goTo('Inventory');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });
    const after = await unitsOnHand();
    if (after !== before + 10) throw new Error(`stock went ${before} → ${after}, expected +10`);
  });
  await shot('purchase-invoice');

  await step('labels can be printed from a confirmed purchase invoice', async () => {
    await goTo('Documents');
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
    await goTo('Documents');
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

  await step('a customer document can be sent on WhatsApp', async () => {
    await goTo('Documents');
    await page.click('td:has-text("SO-0001")');
    const wa = page.locator('a[href^="https://wa.me/"]');
    await wa.waitFor({ timeout: 15000 });

    const href = await wa.getAttribute('href');
    const message = decodeURIComponent(new URL(href).searchParams.get('text'));
    // Rami Haddad's number, as taken down earlier: 03 123 456.
    if (!href.startsWith('https://wa.me/9613123456?')) {
      throw new Error(`addressed to the wrong number: ${href}`);
    }
    for (const expected of ['SO-0001', 'Rami Haddad', 'Croissant', 'Total:']) {
      if (!message.includes(expected)) throw new Error(`the document message is missing ${expected}`);
    }
    await page.keyboard.press('Escape');
  });

  await step('a new product can be created from inside a document', async () => {
    await goTo('Documents');
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
    await goTo('Documents');
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
    await goTo('Suppliers');
    await page.waitForSelector('text=Total you owe', { timeout: 15000 });
    await page.click('td:has-text("Corner Bakehouse")');
    await page.waitForSelector('text=/paid cash/', { timeout: 15000 });
    await closeDialog();
  });
  await shot('paid-in-cash');

  await step('a part payment leaves only the remainder owing', async () => {
    await goTo('Documents');
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
    await goTo('Documents');
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
    await goTo('Inventory');
    await page.waitForSelector('text=Units on hand', { timeout: 15000 });

    await page.click('tr:has-text("Bagel") button[aria-label^="History for"]');
    await page.waitForSelector('text=Stock history', { timeout: 15000 });
    // Both halves of the correction are on the record, not just the net.
    await page.waitForSelector('[role=dialog] >> text=/Edited PI-/', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('a document can be deleted, and is reversed on the way out', async () => {
    await goTo('Documents');
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
    await goTo('Register');
    /*
     * The drawer's figures are always on the strip; its buttons are folded away
     * so the cart keeps the column. Unfold it to reach them — and once open it
     * is remembered, so this is the only step that has to.
     */
    await page.click('button[aria-label="Show the drawer detail"]');
    await page.waitForSelector('button:has-text("Cash out")', { timeout: 15000 });

    // Money out of the drawer for an expense.
    await page.click('button:has-text("Cash out")');
    await page.waitForSelector('text=Money coming out of the drawer', { timeout: 10000 });
    await page.getByLabel('Reason').selectOption('expense');
    await page.getByLabel('Dollars').fill('15');
    await page.getByLabel('What for?').fill('Milk and cleaning');
    await page.click('button:has-text("Take out")');
    await page.waitForSelector('text=/taken out of the drawer/i', { timeout: 15000 });

    /*
     * Taking out more than is there is allowed — the money has gone either way,
     * and refusing it only stops the shop writing that down. It is said out
     * loud instead, and the panel keeps saying so until somebody looks.
     */
    await page.click('button:has-text("Cash out")');
    await page.waitForSelector('text=Money coming out of the drawer', { timeout: 10000 });
    await page.getByLabel('Reason').selectOption('expense');
    await page.getByLabel('Dollars').fill('9999');
    await page.getByLabel('What for?').fill('More than is in there');
    await page.click('button:has-text("Take out")');
    await page.waitForSelector('text=/more than the drawer holds/i', { timeout: 15000 });
    await page.waitForSelector('text=/More has gone out than came in/', { timeout: 15000 });

    // Put it back, so the count below is against a drawer that makes sense.
    await page.click('button:has-text("Cash in")');
    await page.waitForSelector('text=Money going into the drawer', { timeout: 10000 });
    await page.getByLabel('Reason').selectOption('correction');
    await page.getByLabel('Dollars').fill('9999');
    await page.getByLabel('What for?').fill('Putting back the over-payout');
    await page.click('button:has-text("Put in")');
    await page.waitForSelector('text=/added to the drawer/i', { timeout: 15000 });

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
    await goTo('Cashbox');
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
    await goTo('Products');
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
    await goTo('Expenses');
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
    await goTo('Profit');
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
    await goTo('Shopify');
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
    await goTo('Dashboard');
    await page.waitForSelector('text=Owed to you', { timeout: 15000 });
    await page.waitForSelector('text=You owe');
    await page.waitForSelector('text=Net position');
  });

  await step('a cashier can put a sale on a customer account', async () => {
    await goTo('Register');
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
    await goTo('Settings');
    await page.waitForSelector('text=Exchange rate', { timeout: 15000 });
    await page.fill('input[type=number] >> nth=0', '95000');
    await page.click('button:has-text("Save changes")');
    await page.waitForSelector('text=Exchange rate updated', { timeout: 15000 });
    // The preview and history reflect the new rate.
    await page.waitForSelector('text=95,000');
  });
  await shot('settings');

  await step('the register picks up the new rate', async () => {
    await goTo('Register');
    await page.waitForSelector('text=1 USD = 95,000 LL', { timeout: 15000 });
  });

  await step('an admin can widen what one member of staff may do', async () => {
    await goTo('Staff');
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
    await signOut();
    await signIn('cashier');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await goTo('Transfers');
    await page.waitForSelector('text=/Money sent and paid out/', { timeout: 15000 });
  });


  await step('a transfer moves the drawer with it', async () => {
    // The desk takes real money, so the drawer has to be open to take it into.
    await page.click('button:has-text("Open the cashbox")');
    await page.waitForSelector('text=What is in the drawer to start with?', { timeout: 10000 });
    await page.getByLabel('Dollars').fill('100');
    await page.click('button:has-text("Open cashbox")');
    await page.waitForSelector('button[aria-label$="the drawer detail"]', { timeout: 15000 });
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
    await goTo('Vouchers');
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
    await signOut();
    await signIn('admin');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await goTo('Accounts');
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
    await goTo('Cashbox');
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

  /*
   * A second shop: one catalogue, two shelves. The check that matters is that
   * the product is never duplicated to make the move work.
   */
  await step('a second branch is opened, with a drawer of its own', async () => {
    await goTo('Branches');
    await page.waitForSelector('button:has-text("Open a branch")', { timeout: 15000 });
    await page.click('button:has-text("Open a branch")');
    await page.waitForSelector('[role=dialog] >> text=its own shelf and drawer', { timeout: 10000 });

    await page.fill('input[name=name]', 'Saida');
    await page.fill('input[name=code]', 'SAI');
    await page.click('button:has-text("Open the branch")');
    await page.waitForSelector('text=it has a drawer of its own', { timeout: 15000 });
  });

  await step('stock sent to it leaves this shelf straight away', async () => {
    await goTo('Move stock');
    await page.waitForSelector('button:has-text("Send stock")', { timeout: 15000 });
    await page.click('button:has-text("Send stock")');
    await page.waitForSelector('[role=dialog] >> text=To which branch', { timeout: 10000 });

    /* The cable from the barcode step: ten in stock and nothing in this run
       has sold any, so the figures below are predictable. */
    await page.fill('input[aria-label="Find a product to send"]', 'Braided');
    await page.waitForTimeout(400);
    await page.locator('[role=dialog] li button:has-text("Braided cable")').first().click();
    await page.fill('input[aria-label="How many Braided cable"]', '4');
    await page.click('button:has-text("Send it")');
    await page.waitForSelector('text=/TR-\\d+ sent/', { timeout: 15000 });
    await page.waitForSelector('text=on the way', { timeout: 10000 });
  });

  await step('and lands on the other shelf when it is received there', async () => {
    // Switching branch changes what every figure in the app means, so it is a
    // control on the rail rather than a setting buried in a page.
    await page.locator('button[aria-label*="Branch:"]:visible').first().click();
    await page.waitForTimeout(300);
    await page.locator('div.absolute button:has-text("Saida")').first().click();
    await page.waitForSelector('text=On the way to Saida', { timeout: 15000 });

    await page.click('button:has-text("Receive")');
    await page.waitForSelector('[role=dialog] >> text=Count what is actually in the box', { timeout: 10000 });
    await page.click('button:has-text("Receive it")');
    await page.waitForSelector('text=/TR-\\d+ received/', { timeout: 15000 });
  });

  await step('the same product, on the second branch’s register — not a copy of it', async () => {
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.waitForTimeout(600);

    const tiles = page.locator('section button:has-text("Braided cable")');
    const count = await tiles.count();
    if (count !== 1) throw new Error(`a transfer duplicated the product — ${count} tiles`);
    if (!(await tiles.first().innerText()).includes('4 left')) {
      throw new Error('the transferred stock is not on this branch’s shelf');
    }

    // Back where the rest of the run expects to be.
    await page.locator('button[aria-label*="Branch:"]:visible').first().click();
    await page.waitForTimeout(300);
    await page.locator('div.absolute button').first().click();
    await page.waitForTimeout(800);
  });
  await shot('branches');

  await step('a cashier cannot reach an admin route by URL', async () => {
    await signOut();
    await signIn('cashier');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.goto(`${BASE_URL}/admin/inventory`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    if (await page.locator('text=Units on hand').count()) {
      throw new Error('cashier reached an admin page');
    }
  });

  console.log('\nOn a small screen, and on a square counter monitor');

  /*
   * The counter monitor is the machine this app is actually used on, and it is
   * usually square and small. Two hundred pixels of menu down the side of one
   * is a column of products the cashier cannot see.
   */
  await step('the register keeps the whole window, with a way back to the menu', async () => {
    // As the owner: a cashier has no Dashboard, so "the rail is not here" would
    // pass on an empty rail and prove nothing.
    await signOut();
    await signIn('admin');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    if (await page.locator('nav a:has-text("Dashboard"):visible').count()) {
      throw new Error('the rail is still taking space on the register');
    }
    // And it is not simply gone: the way to everything else is on screen.
    await page.waitForSelector('a[href="/menu"]:visible', { timeout: 10000 });
  });

  await step('and it comes back for whoever wants it, and stays back', async () => {
    await page.click('button[aria-label="Show the menu"]');
    await page.waitForSelector('nav a:has-text("Dashboard")', { timeout: 10000 });

    // Remembered, or it is a setting that has to be set once per sale.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('nav a:has-text("Dashboard")', { timeout: 10000 });

    await page.click('button[aria-label="Hide the menu"]');
    await page.waitForSelector('a[href="/menu"]:visible', { timeout: 10000 });
  });

  await step('every screen is one press away, at a size a finger can hit', async () => {
    await openMenu();
    await page.waitForSelector('main a[title="Trade-ins"]', { timeout: 15000 });

    // A tile on the page, not the rail's link with the same name — this is the
    // menu built for a touch screen, and its size is the point of it.
    const tile = await page.locator('main a[title="Products"]').first().boundingBox();
    if (!tile || tile.height < 80) {
      throw new Error(`the menu tiles are ${tile ? tile.height : 0}px tall, which is not a target`);
    }
    await page.locator('main a[title="Products"]').first().click();
    await page.waitForSelector('text=Braided USB-C cable', { timeout: 15000 });
  });
  await shot('menu-page');

  await step('on a phone the till still sells, and nothing runs off the side', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    // The one thing that must never happen on a phone: the page wider than the
    // screen, so every tap lands somewhere slightly wrong.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 2) throw new Error(`the page is ${overflow}px wider than the phone`);

    // The shelf and the cart are both reachable, one under the other.
    await page.click(scanBox);
    await page.fill(scanBox, 'Espresso');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Espresso")');
    await page.waitForSelector('aside >> text=Espresso', { timeout: 10000 });
  });
  await shot('register-phone');

  await step('and the menu on a phone is the page, not a rail', async () => {
    if (await page.locator('nav a:has-text("Dashboard"):visible').count()) {
      throw new Error('the rail is on screen on a phone');
    }
    await openMenu();
    await page.waitForSelector('main a[title="Trade-ins"]', { timeout: 15000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 2) throw new Error(`the menu is ${overflow}px wider than the phone`);
  });
  await shot('menu-phone');

  await step('back to a desk, and the shop is a shop again', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
    await page.waitForSelector('nav a:has-text("Dashboard")', { timeout: 15000 });
  });

  console.log('\nA visit from the vendor');

  /*
   * The one flow no unit test can reach: a link out of the vendor's console,
   * opened in a browser, landing signed into somebody else's shop — and the bar
   * that has to be on their screen while it lasts.
   *
   * The ticket is written straight into the book of shops, which is exactly
   * what the console does. Going through the console itself would mean running
   * a second server here to test the client half of the first.
   */
  await step('a support link signs the vendor into the shop', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mintTicket } = await import('../server/src/lib/supportTickets.js');

    const control = new DatabaseSync(process.env.E2E_CONTROL_DB);
    const { token } = mintTicket(control, {
      slug: 'e2e',
      operator: 'walid',
      reason: 'They asked me to look at a price',
    });
    control.close();

    await signOut();
    await page.goto(`${BASE_URL}/support?t=${token}`, { waitUntil: 'networkidle' });

    // Landed inside the shop, not on the sign-in screen.
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
  });

  await step('the shop is told who is in it, and why', async () => {
    await page.waitForSelector('text=You are in this shop as support', { timeout: 40000 });
    await page.waitForSelector('text=They asked me to look at a price', { timeout: 10000 });
  });
  await shot('support-visit');

  await step('and the shop keeps its own record of the visit', async () => {
    await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Support visits', { timeout: 15000 });
    await page.waitForSelector('text=They asked me to look at a price', { timeout: 10000 });

    // Opening the visit lists what was actually done, rather than only that
    // somebody was here.
    await page.click('text=They asked me to look at a price');
    await page.waitForTimeout(300);
  });
  await shot('support-log');

  await step('a ticket that is not good says so instead of letting anybody in', async () => {
    // A link out of a browser history must not be a way back in, and neither
    // must a guess. Both land here, and the page has to say so rather than
    // bouncing to a sign-in screen that looks like an ordinary session ending.
    await signOut();
    await page.goto(`${BASE_URL}/support?t=${'a'.repeat(64)}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=That link did not work', { timeout: 15000 });

    // Back to an ordinary signed-in shop for whatever runs next.
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    await signIn('cashier');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
  });

  console.log('\nIn Arabic');

  /*
   * The switch is on the sign-in screen because somebody who needs Arabic
   * cannot read the English screen asking them to choose — so that is where
   * this starts, before any credentials are typed.
   */
  await step('the language is chosen before signing in, and turns the page round', async () => {
    await signOut();

    await page.click('button:has-text("العربية")');
    await page.waitForFunction(() => document.documentElement.dir === 'rtl', { timeout: 5000 });
    if ((await page.evaluate(() => document.documentElement.lang)) !== 'ar') {
      throw new Error('the document is right-to-left but not marked as Arabic');
    }
    await page.waitForSelector('text=تسجيل الدخول');
  });
  await shot('login-arabic');

  await step('the register and its menu come up in Arabic', async () => {
    await signIn('cashier');
    await page.waitForSelector('text=الفاتورة الحالية', { timeout: 15000 });

    /*
     * The rail is away on the register now, so the menu is checked where it
     * actually shows. Going to it also proves the way out of the register
     * exists in Arabic, which is the thing a cashier would be stuck without.
     */
    await page.goto(`${BASE_URL}/orders`, { waitUntil: 'networkidle' });
    await page.waitForSelector('aside >> text=البيع', { timeout: 10000 });
    await page.waitForSelector('aside >> text=الحوالات', { timeout: 10000 });

    // Laid out the other way round: the rail is on the right of the window.
    const rail = await page.locator('aside').first().boundingBox();
    const width = page.viewportSize().width;
    if (!rail || rail.x < width / 2) {
      throw new Error('Arabic did not move the menu to the right-hand side');
    }
  });
  await shot('register-arabic');

  await step('and English comes back, with nothing stuck right-to-left', async () => {
    await page.click('button[aria-label="تسجيل الخروج"]');
    await page.waitForSelector('text=العربية');
    await page.click('button:has-text("English")');
    await page.waitForFunction(() => document.documentElement.dir === 'ltr', { timeout: 5000 });
    await page.waitForSelector('input[name=username]');
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
