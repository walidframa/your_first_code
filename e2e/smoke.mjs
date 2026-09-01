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
  // And a feature the shop has not bought answers 403 on purpose: that refusal
  // is the thing being checked, because the owner passes every permission and
  // must still be turned away.
  /\/api\/transfers/,
  /*
   * Deliberately wrong current password, so the panel can be seen refusing it
   * in place. The 401 is the assertion, not an accident.
   *
   * Only this one. The 401s that used to follow it — products and categories
   * caught in flight while the password rotated — are the bug that was found by
   * this listener complaining about them, and they must never be allowed here.
   */
  /\/api\/auth\/password/,
  /*
   * Cancelling the slip an invoice wrote for itself, which is refused on
   * purpose — the invoice still says it was paid, so undoing the receipt here
   * would hand the money back twice. The 400 is what is being checked.
   */
  /\/api\/vouchers\/\d+\/cancel/,
  /*
   * Running a month that has already been run, which is refused on purpose —
   * somebody will press it twice, and the second press must not pay anybody
   * twice. The 400 is what is being checked.
   */
  /\/api\/employees\/\d+\/salary/,
  /*
   * A 404 this test serves itself, to stand a screen in front of a server that
   * has never heard of it. That is the shape of a half-finished deploy — new
   * files on disk, old process still running — and what it must not do is sit
   * on a loading skeleton for ever.
   */
  /\/api\/expenses\/capital/,
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
/*
 * A failure that healed itself is not a failure.
 *
 * Changing a password invalidates tokens issued before it, so a request already
 * in flight comes back 401 and is sent again with the new one. The first
 * attempt is on the wire and this listener sees it — but the app recovered, the
 * screen was right, and nobody at a counter could tell. What must never be
 * forgiven is a 401 that stayed a 401, which is the bug this whole listener
 * caught in the first place.
 *
 * So a later success for the same method and URL cancels the earlier failure,
 * and anything left at the end genuinely failed.
 */
page.on('response', (res) => {
  const key = `${res.request().method()} ${res.url()}`;
  if (res.status() >= 400) {
    if (!ALLOWED_FAILURES.some((re) => re.test(res.url()))) {
      failedResponses.push(`${res.status()} ${key}`);
    }
    return;
  }
  if (res.status() < 300) {
    const healed = failedResponses.findIndex((f) => f.endsWith(` ${key}`));
    if (healed !== -1) failedResponses.splice(healed, 1);
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
 * Go to the screen where a document is raised, and wait for it to be there.
 *
 * It was a dialog and is a page now — its own address, so it survives a reload
 * and the browser's back button means what it says. The wait is for the type
 * tiles rather than the heading: the heading renders before the products and
 * contacts it needs have arrived, and a click on a tile in that gap does
 * nothing at all.
 */
async function openNewDocument() {
  await page.click('button:has-text("New document")');
  await page.waitForURL(/\/admin\/documents\/new/, { timeout: 15000 });
  await page.getByRole('button', { name: /Quotation/ }).first().waitFor();
  /* The form, not the whole page: every step below looks for its fields
     inside whatever this returns. */
  return page.locator('form').first();
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
/**
 * The screen that lists every kind of document.
 *
 * The rail no longer has one "Documents" link — it has a group opening onto
 * the four kinds, each its own filtered screen. This is the unfiltered one,
 * still there because the Sales list sends anybody hunting a single invoice to
 * it, and reached by address because it is no longer a row anybody can click.
 */
/**
 * Put a category's chip on the register.
 *
 * Categories are off the counter screen until a shop asks for one — an
 * imported catalogue brings its supplier's filing with it, and the chip row
 * became a wall of words to read past on the way to the products. Two of this
 * suite's categories are made partway through the run by the starter card
 * catalogue, too late for the shop set-up in run.mjs to reach them, so the
 * steps that filter by them ask here.
 *
 * Through the API rather than the categories dialog: these calls sit in the
 * middle of register flows, and walking to another screen to tick a box would
 * throw away whatever is in the cart. What the box itself does is covered by
 * the server's tests. Call it before navigating to the register — arriving
 * mounts the screen fresh, so nothing needs reloading.
 */
async function putCategoryOnRegister(name) {
  await page.evaluate(async (wanted) => {
    const auth = {
      Authorization: `Bearer ${localStorage.getItem('pos_token')}`,
      'Content-Type': 'application/json',
    };
    const { categories } = await (await fetch('/api/products/categories', { headers: auth })).json();
    const category = categories.find((c) => c.name === wanted);
    if (!category) throw new Error(`there is no category called ${wanted} to put on the register`);
    await fetch(`/api/products/categories/${category.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ name: category.name, onRegister: true }),
    });
  }, name);
}

async function goToDocuments() {
  await page.goto(`${BASE_URL}/admin/documents`, { waitUntil: 'networkidle' });
  await page.waitForSelector('button:has-text("New document")', { timeout: 20000 });
}

async function openMenu() {
  await page.locator('a[href="/menu"]:visible').first().click();
  await page.waitForSelector('a[href="/orders"]:visible', { timeout: 15000 });
}

/**
 * Answer the question that now stands in front of anything destructive.
 *
 * Two dialogs are open while it is up — the screen that asked and the
 * confirmation itself — so it is found by the words on it rather than by being
 * a dialog, which both of them are.
 */
async function confirmDialog(title, action) {
  const box = page.locator('[role=dialog]', { hasText: title }).last();
  await box.waitFor({ timeout: 15000 });
  await box.getByRole('button', { name: action, exact: true }).click();
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
  /*
   * The rail is an accordion: the group holding a screen may be folded, and
   * arriving somewhere opens that screen's group and folds the one you were
   * just looking at. So a link counted a moment ago can be gone by the time it
   * is clicked — which is a race in this helper, not in the app.
   *
   * Try the rail, and fall back to the menu page, which lists every screen
   * whatever the rail happens to be showing.
   */
  if (await page.locator(link).count()) {
    try {
      await page.locator(link).first().click({ timeout: 4000 });
      return;
    } catch {
      // It folded away under us; go the long way round.
    }
  }
  await openMenu();
  await page.locator(link).first().click({ timeout: 15000 });
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

    // On the register the closed state is one amber chip in the header: it says
    // what is wrong, what it costs, and is itself the way to fix it.
    await page.click('button:has-text("Cashbox closed")');
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

  /*
   * Haggling, which is how a phone is actually sold here.
   *
   * Checked all the way to what the order line stores, not just to what the
   * cart shows: the whole point of pricing the line rather than discounting
   * the basket is that the books record the margin on the phone as the margin
   * on the phone, and that only holds if the agreed figure survives the sale.
   */
  await step('a price can be argued down on one line, and it is what gets sold', async () => {
    await page.click('button:has-text("Croissant")');
    await page.waitForTimeout(300);

    const line = page.locator('aside li', { hasText: 'Croissant' }).first();
    await line.getByRole('button', { name: /each/ }).click();
    await page.waitForSelector('[role=dialog] >> text=Price for this sale', { timeout: 10000 });

    await page.fill('[role=dialog] #linePrice', '2');
    await page.waitForTimeout(200);
    // It says what it means in the terms it was argued in.
    await page.waitForSelector('[role=dialog] >> text=/off each/', { timeout: 5000 });
    await page.click('[role=dialog] button:has-text("Use this price")');
    await page.waitForTimeout(400);

    const shown = await line.innerText();
    if (!shown.includes('$2.00')) throw new Error(`the cart still says ${shown}`);
    if (!shown.includes('was $3.00')) throw new Error('the shelf price is not kept beside it');

    // And back again, because a price agreed by mistake is agreed at a counter.
    await line.getByRole('button', { name: /each/ }).click();
    await page.waitForSelector('[role=dialog] >> text=Price for this sale', { timeout: 10000 });
    await page.click('[role=dialog] button:has-text("Back to")');
    await page.waitForTimeout(400);
    if (!(await line.innerText()).includes('$3.00')) throw new Error('it did not go back');
  });

  await step('only the categories the shop asked for are on the register', async () => {
    /*
     * A shop that imports a supplier's catalogue inherits its filing — dozens
     * of families, most meaningless at the counter — so the chip row was a wall
     * of words to read past on the way to the products. Bakery was put on the
     * counter screen when this run's shop was set up; Snacks deliberately was
     * not, and the products in it are still on the grid and still sellable.
     */
    await page.waitForSelector('[data-filter-chip]:has-text("Bakery")', { timeout: 15000 });
    if (await page.locator('[data-filter-chip]:has-text("Snacks")').count()) {
      throw new Error('a category nobody asked for is on the register');
    }
    if ((await page.locator('section button:has-text("Potato Chips")').count()) === 0) {
      throw new Error('a product was hidden along with its category — only the chip should go');
    }
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

    /*
     * Typed rather than tapped.
     *
     * The keypad on screen is for a touch monitor; a shop on a desktop with a
     * numeric keypad under its hand was having to point at the screen for every
     * digit, which is slower than the till it replaced. Backspace clears it
     * again, so the whole entry is the keyboard's.
     */
    await page.keyboard.press('7');
    await page.waitForSelector('[role=dialog] >> text=$7.00', { timeout: 5000 });
    await page.keyboard.press('Backspace');

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
    await page.click('a[href="/orders"]:visible');
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
    await dialog.getByRole('button', { name: /^(Create product|Save changes)$/ }).click();
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
    await confirmDialog('Delete this ID?', 'Delete the ID');
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

    await putCategoryOnRegister('Recharge');

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

    await putCategoryOnRegister('Validity');
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
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.locator('text=Chargrs').waitFor({ timeout: 15000 });

    await dialog.getByRole('button', { name: 'Rename Chargrs' }).click();
    await page.keyboard.type('Chargers');
    await page.keyboard.press('Enter');
    await dialog.locator('text=Chargers').waitFor({ timeout: 15000 });

    /*
     * The list a phone shop would have typed by hand, in one press. Twice,
     * because the second press must be a quiet no-op rather than a second
     * "Chargers" beside the one just renamed — which would split the shop's
     * cables across two shelves that look identical in every list.
     */
    await dialog.getByRole('button', { name: 'Add the usual ones for a phone shop' }).click();
    await dialog.locator('text=Power banks').waitFor({ timeout: 15000 });
    await dialog.getByRole('button', { name: 'Add the usual ones for a phone shop' }).click();
    await page.waitForSelector('text=You already have all of them', { timeout: 15000 });
    if ((await dialog.locator('li', { hasText: 'Chargers' }).count()) !== 1) {
      throw new Error('a second Chargers shelf was added beside the one already there');
    }

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

  await step('the rail opens one group at a time', async () => {
    /*
     * An accordion, so the menu always fits the screen. With every group open
     * at once the rail was twice the height of a laptop window and the last of
     * it was below the fold — which is the thing a menu must never be.
     */
    // Folded rather than unmounted, so the rows can animate shut — hidden, not
    // gone. `visibility` is what does it, which also keeps a closed group's
    // links out of the tab order.
    // We are on Products, so Stock is the group holding the page and is open.
    await page.waitForSelector('aside a[title="Inventory"]', { timeout: 10000 });

    // Opening another closes it, rather than adding to a growing list.
    await page.click('aside button:has-text("Setup")');
    await page.waitForSelector('aside a[title="Settings"]', { timeout: 10000 });
    await page.waitForSelector('aside a[title="Inventory"]', { state: 'hidden', timeout: 10000 });

    // And pressing the open one closes it, leaving none open.
    await page.click('aside button:has-text("Setup")');
    await page.waitForSelector('aside a[title="Settings"]', { state: 'hidden', timeout: 10000 });

    // The register is never folded away: it is what the app is for.
    await page.waitForSelector('aside a[title="Register"]', { timeout: 10000 });

    /*
     * Arriving at a screen opens the group holding it, or the page you are
     * looking at would be missing from the menu — which with one group open is
     * the usual case rather than the odd one.
     */
    await page.click('aside a[title="Register"]');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await goTo('Products');
    await page.waitForSelector('aside a[title="Inventory"]', { timeout: 10000 });
  });

  await step('a shelf can be named from inside the product going onto it', async () => {
    /*
     * A shop typing in its first delivery of something it has never stocked
     * meets the product and the shelf at once. Sending it to another screen to
     * make the shelf meant abandoning the half-typed product and starting over.
     */
    await page.click('button:has-text("New product")');
    const dialog = page.locator('[role=dialog]');
    await dialog.getByLabel('Name').first().waitFor({ timeout: 10000 });

    /*
     * By id, not by label: once the box for the new name is open there are two
     * fields whose label contains "Category", and the ambiguity is the test's
     * problem rather than the shop's.
     */
    const category = dialog.locator('#category_id');
    await category.selectOption('__new__');
    // A name no earlier step has taken — "Chargers" already exists by now, and
    // a shelf that exists is refused, which is the app being right.
    await dialog.getByLabel('New category').fill('Wall brackets');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();

    /*
     * Waited for by what it did rather than by the toast that says so: a toast
     * is gone in four seconds and is not the thing being tested. Polled rather
     * than waited on as an element, because an <option> inside a closed select
     * is never "visible" and a wait for one can only ever time out.
     */
    let chosen = '';
    for (let i = 0; i < 40 && (chosen === '' || chosen === '__new__'); i += 1) {
      await page.waitForTimeout(250);
      chosen = await category.inputValue();
    }
    if (chosen === '' || chosen === '__new__') {
      throw new Error(`the new category was not selected (value ${chosen})`);
    }

    // And it is in the list, not merely selected.
    const names = await category.locator('option').allTextContents();
    if (!names.some((n) => n.includes('Wall brackets'))) {
      throw new Error(`the new shelf is not in the list: ${names.join(', ')}`);
    }

    // And it saves onto the product like any other.
    await dialog.getByLabel('Name').first().fill('Wall charger 20W');
    await dialog.getByLabel('SKU').fill('CHG-20W');
    await dialog.getByLabel('Price', { exact: true }).fill('8.00');
    await dialog.getByRole('button', { name: /^(Create product|Save changes)$/ }).click();

    /*
     * Searched for rather than scrolled to. The catalogue only renders the rows
     * in the window now — a shop's list runs to thousands and putting all of
     * them in the page is what made it crawl — so a product filed under W is
     * not in the document until something brings it into view. Which is what
     * the search box is for, and what a shopkeeper would do.
     */
    await page.getByPlaceholder(/Search by name/i).fill('Wall charger 20W');
    await page.waitForSelector('td:has-text("Wall charger 20W")', { timeout: 15000 });
    await page.getByPlaceholder(/Search by name/i).fill('');
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
    await dialog.getByLabel('Price', { exact: true }).fill('7.50');
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
    // Named "Sales" now that invoices are listed beside register sales.
    await goTo('Sales');
    await page.waitForSelector('text=ORD-', { timeout: 15000 });
    await page.click('td:has-text("ORD-") >> nth=0');
    await page.waitForSelector('button:has-text("Void the whole sale")');
    await page.click('button:has-text("Void the whole sale")');

    /*
     * Nothing that moves money happens on one press any more. On a counter
     * tablet the button somebody meant is a centimetre from the one they hit,
     * and a refund issued by a sleeve is a real way to lose a day's takings.
     */
    const asked = page.locator('[role=dialog]', { hasText: /Void ORD-/ }).last();
    await asked.waitFor({ timeout: 15000 });

    // Backing out leaves the sale exactly as it was.
    await asked.getByRole('button', { name: 'Keep it', exact: true }).click();
    await page.waitForTimeout(300);
    if (await page.locator('[role=dialog]', { hasText: /Void ORD-/ }).count()) {
      throw new Error('the confirmation would not go away');
    }

    await page.click('button:has-text("Void the whole sale")');
    await confirmDialog(/Void ORD-/, 'Void the sale');
    await page.waitForSelector('text=Refunded', { timeout: 15000 });
  });

  /*
   * Reported from a live shop: "the invoices are not added to the sales tab".
   *
   * They were not — this screen read the orders table and nothing else, so a
   * shop that invoices its trade customers looked at a day's sales and saw
   * only the part that crossed the till.
   */
  /*
   * Reading a barcode with the camera.
   *
   * The decoder is the browser's own and the camera is a real device, so
   * neither is what this checks — both are stubbed. What is checked is the
   * wiring: that the button only appears where decoding is possible, and that
   * a code read by the camera takes exactly the same path as one typed in or
   * fired by the USB gun on the counter.
   */
  await step('a barcode read by the camera joins the sale like any other', async () => {
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    // Offered wherever there is a camera to open — the decoding is no longer
    // the browser's to refuse; see the step after this one.
    await page.waitForSelector('[aria-label="Scan a barcode with the camera"]', { timeout: 10000 });

    /*
     * A browser that can, and a camera that yields one known code. The product
     * is made first so the code belongs to something real.
     */
    const code = '5901234123457';
    await page.evaluate(async (barcode) => {
      const h = {
        Authorization: `Bearer ${localStorage.getItem('pos_token')}`,
        'Content-Type': 'application/json',
      };
      await fetch('/api/products', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          name: 'Scanned Widget',
          sku: 'SCN-1',
          barcode,
          price: 12,
          cost: 4,
          stock: 9,
        }),
      });
    }, code);

    await page.addInitScript((barcode) => {
      globalThis.BarcodeDetector = class {
        static getSupportedFormats() {
          return Promise.resolve(['ean_13']);
        }
        detect() {
          return Promise.resolve([{ rawValue: barcode, format: 'ean_13' }]);
        }
      };
      /*
       * A stand-in for the camera. It has to actually paint: the scanner will
       * not hand an empty video to the decoder — a frame that has not arrived
       * yet decodes to nothing and would burn battery on a real phone — so a
       * canvas that never draws produces a video that is never ready.
       */
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      setInterval(() => {
        ctx.fillStyle = ctx.fillStyle === '#000000' ? '#ffffff' : '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }, 50);
      navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(20);
    }, code);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.click('[aria-label="Scan a barcode with the camera"]');
    await page.waitForSelector('[role=dialog] >> text=Scan a barcode', { timeout: 10000 });

    // Straight onto the sale, exactly as a typed code would have gone.
    await page.waitForSelector('aside >> text=Scanned Widget', { timeout: 15000 });
    await page.click('button:has-text("Clear")');
    await page.waitForTimeout(300);
  });

  /*
   * The same thing on a browser with no decoder of its own.
   *
   * Which is Safari, which is the phone in the owner's pocket — the one device
   * always with them while they walk the shelves, and until now the only one
   * that could not scan. Nothing is stubbed here except the camera: the frame
   * really carries a printed EAN-13, and the app really reads it.
   */
  await step('and a browser that cannot decode has the app do it instead', async () => {
    await page.addInitScript((bars) => {
      // No `BarcodeDetector`, the way Safari has none.
      Object.defineProperty(globalThis, 'BarcodeDetector', { value: undefined, configurable: true });

      // A camera pointed at a real barcode: the bars below are what this app's
      // own label printer would put on the shelf edge.
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 240;
      const context = canvas.getContext('2d');
      const module = 4;
      const quiet = 60;
      const paint = () => {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#101010';
        for (let i = 0; i < bars.length; i += 1) {
          if (bars[i] === '1') context.fillRect(quiet + i * module, 50, module, 150);
        }
      };
      paint();
      setInterval(paint, 100);
      navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(10);
    }, '10100010110100111011001100100110111101001110101010110011011011001000010101110010011101000100101');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.click('[aria-label="Scan a barcode with the camera"]');
    await page.waitForSelector('[role=dialog] >> text=Scan a barcode', { timeout: 10000 });

    // Read off the picture by the app itself, and onto the sale.
    await page.waitForSelector('aside >> text=Scanned Widget', { timeout: 20000 });
    await page.click('button:has-text("Clear")');
    await page.waitForTimeout(300);
  });

  /*
   * What a sale is worth making, before it is agreed. The whole reason a
   * counter haggles is to find out how far down it can go, and working that
   * out on paper while a customer waits is how a shop sells at a loss and
   * finds out at the end of the month.
   */
  await step('the cart says what the sale in front of you makes', async () => {
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    // Nothing on the sale, nothing to say about it.
    const badge = page.locator('[aria-label="What this sale makes"]');
    if (await badge.count()) throw new Error('an empty cart is claiming a margin');

    /*
     * Something with a known cost, so the figure can be checked rather than
     * merely seen. Sells for $30, cost $10 — the margin is two thirds, and any
     * other answer means the arithmetic is wrong.
     */
    await page.evaluate(async () => {
      const h = {
        Authorization: `Bearer ${localStorage.getItem('pos_token')}`,
        'Content-Type': 'application/json',
      };
      await fetch('/api/products', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'Margin Widget', sku: 'MGN-1', price: 30, cost: 10, stock: 5 }),
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.fill('input[placeholder*="Scan"]', 'Margin Widget');
    await page.waitForTimeout(600);
    await page.locator('button', { hasText: 'Margin Widget' }).first().click();
    await page.waitForTimeout(400);

    await badge.waitFor({ timeout: 10000 });
    const shown = await badge.innerText();
    if (!shown.includes('$20.00') || !shown.includes('67%')) {
      throw new Error(`a $30 sale costing $10 should make $20.00 · 67%, not: ${shown}`);
    }

    await page.click('button:has-text("Clear")');
    await page.waitForTimeout(400);
    if (await badge.count()) throw new Error('the margin outlived the sale it was about');
  });

  /*
   * The commonest transaction the app could not write down: some of it in
   * notes, the rest on an app. A cashier used to pick whichever piece was
   * biggest and the other went unrecorded.
   *
   * The account piece needs a customer, who does not exist this early in the
   * run — it is covered by the server suite instead, credit limit and all.
   */
  await step('a sale can be paid for with more than one thing', async () => {
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.locator('button', { hasText: 'Croissant' }).first().click();
    await page.waitForTimeout(300);

    // The cart's own button, as everywhere else in this suite — a bare
    // "Charge" also matches things that are not it.
    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector('[role=dialog] >> text=Take payment', { timeout: 15000 });
    await page.click('[role=dialog] button:has-text("Split it")');
    await page.waitForSelector('[role=dialog] >> text=Another payment', { timeout: 10000 });

    const dialog = page.locator('[role=dialog]').last();

    // A dollar in notes, and the rest through Whish.
    await dialog.getByLabel('Dollars').first().fill('1');
    await dialog.getByRole('button', { name: 'Another payment' }).click();
    await dialog.locator('select[aria-label="How piece 2 was paid"]').selectOption('card');
    await dialog.locator('select[aria-label="Which app for piece 2"]').selectOption('Whish');

    // Whatever is left, which the sheet has already worked out and put in the
    // second row for exactly this reason.
    await page.waitForSelector('[role=dialog] >> text=Settled', { timeout: 10000 });
    await dialog.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForSelector('text=Payment complete', { timeout: 20000 });

    // And the slip names both pieces rather than calling the lot cash.
    const slip = await page.locator('[role=dialog]').last().innerText();
    if (!/Whish/.test(slip)) {
      throw new Error(`the receipt does not say the money came through Whish:\n${slip.slice(0, 400)}`);
    }
    await page.keyboard.press('Escape');
  });

  /*
   * Part now, the rest on the slate — which is how half the sales in this shop
   * actually end.
   *
   * The credit half was offered only to a sale that already had a customer on
   * it, so a cashier who had not thought to name one had to leave the payment
   * sheet, find the customer and start the split again. Whose account it goes
   * on is asked where the question arises.
   */
  await step('and part of it can go on an account named right there', async () => {
    // A customer with room on their limit, made through the API: this step is
    // about the payment sheet, not about the customers screen.
    await page.evaluate(async () => {
      const headers = {
        Authorization: `Bearer ${localStorage.getItem('pos_token')}`,
        'Content-Type': 'application/json',
      };
      await fetch('/api/customers', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Nadia Khoury', phone: '03111222', credit_limit: 500 }),
      });
    });

    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.locator('button', { hasText: 'Croissant' }).first().click();
    await page.waitForTimeout(300);

    // Nobody named on the sale, which is the case that used to have no answer.
    await page.click('aside button:has-text("Charge $")');
    await page.waitForSelector('[role=dialog] >> text=Take payment', { timeout: 15000 });
    await page.click('[role=dialog] button:has-text("Split it")');
    await page.waitForSelector('[role=dialog] >> text=Another payment', { timeout: 10000 });

    const dialog = page.locator('[role=dialog]').last();
    // By id rather than by label: both rows have a "Dollars" and this step is
    // about which pile the money lands in.
    await dialog.locator('#usd-1').fill('1');
    await dialog.getByRole('button', { name: 'Another payment' }).click();
    await dialog.locator('select[aria-label="How piece 2 was paid"]').selectOption('account');

    // It will not go through until somebody owns the debt.
    await dialog.getByRole('button', { name: 'Name the account first' }).waitFor({ timeout: 10000 });

    await dialog.locator('text=/on whose account/').waitFor({ timeout: 10000 });
    await dialog.getByRole('button', { name: /customer/i }).first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Nadia Khoury")').first().click();

    await page.waitForSelector('[role=dialog] >> text=/goes on Nadia Khoury/', { timeout: 10000 });

    // What the sheet says will go on the account — the sale's total less the
    // dollar in notes, whatever tax this run has left switched on.
    const onAccount = Number(await dialog.locator('#usd-2').inputValue());
    await dialog.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForSelector('text=Payment complete', { timeout: 20000 });
    await page.keyboard.press('Escape');

    // The cash went in the drawer and the rest is on her account, not lost.
    await goTo('Customers');
    await page.waitForSelector('text=/Balances, credit limits/', { timeout: 15000 });
    const row = page.locator('tr', { hasText: 'Nadia Khoury' }).first();
    await row.waitFor({ timeout: 15000 });
    const owed = `$${onAccount.toFixed(2)}`;
    await row
      .locator(`text=${owed}`)
      .first()
      .waitFor({ timeout: 15000 })
      .catch(async () => {
        throw new Error(`she should owe ${owed}: ${await row.innerText()}`);
      });
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
    /*
     * Exact, and inside the page rather than the rail. A loose "Balance" also
     * matches "Trial balance" in the navigation, so this waited on a link that
     * was already there and then clicked Charge before the customer's panel had
     * opened — a wait that passes without waiting for anything.
     */
    await page.waitForSelector('main >> text="Balance"', { timeout: 15000 });
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

    await goToDocuments();
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

  await step('a second delivery at a different price averages out the cost', async () => {
    /*
     * The question a shopkeeper actually asks: I bought these at one price and
     * then at another — what did they cost me? `products.cost` is whatever was
     * last typed, and cannot answer it.
     */
    await goToDocuments();
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });
    await dialog.getByLabel('Search products to add').fill('Bagel');
    await dialog.locator('text=/BAK-002/').first().waitFor();
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for Bagel/i).fill('10');
    // Dearer than the first delivery, which is what the next step is about.
    await dialog.getByLabel(/Unit price for Bagel/i).fill('4');

    // Said before it is booked in, while the supplier's paper is still in hand.
    await dialog.locator('text=/costs more than last time/').first().waitFor({ timeout: 10000 });

    await page.click('button:has-text("Create draft")');
    await page.waitForSelector('text=/PI-\\d{4}/', { timeout: 15000 });
    await page.click('button:has-text("Confirm")');
    await page.waitForSelector('[role=dialog] >> text=confirmed', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('the catalogue can show what the shelf actually cost', async () => {
    await goTo('Products');
    await page.waitForSelector('button:has-text("New product")', { timeout: 15000 });

    // Not on by default — the counter does not need it — so it is turned on.
    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByLabel('Average cost').check();
    await page.keyboard.press('Escape');

    await page.waitForSelector('th:has-text("Average cost")', { timeout: 10000 });
    await page.getByPlaceholder(/Search by name, SKU or barcode/).fill('Bagel');
    await page.waitForTimeout(300);

    // Ten at the seeded cost and ten at $4: the average sits between them, and
    // is neither of the two numbers on the invoices.
    const row = page.locator('tbody tr', { hasText: 'Bagel' }).first();
    const cells = await row.locator('td').allInnerTexts();
    if (!cells.some((c) => /\$/.test(c))) throw new Error('no money in the row at all');

    // And a column turned off goes away and stays away over a reload.
    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByLabel('Category').uncheck();
    await page.keyboard.press('Escape');
    if (await page.locator('th:has-text("Category")').count()) {
      throw new Error('the category column outstayed its unticking');
    }

    await page.reload();
    await page.waitForSelector('th:has-text("Average cost")', { timeout: 15000 });
    if (await page.locator('th:has-text("Category")').count()) {
      throw new Error('the choice was forgotten on reload');
    }

    // Put it back, so the steps after this see the ordinary table.
    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('button', { name: /Show them all again/ }).click();
    await page.keyboard.press('Escape');
    await page.waitForSelector('th:has-text("Category")', { timeout: 10000 });
  });

  await step('the dashboard shows what is asked of it, and nothing else', async () => {
    /*
     * A dashboard is one screen answering a dozen questions and no two shops
     * ask the same dozen — so the panels are chosen, and the choice is kept on
     * the device like the catalogue's columns.
     */
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Busiest hours', { timeout: 20000 });

    // Money asleep on the shelf: the question no other screen answers — a shop
    // can see what is running out and not what it is stuck with.
    await page.waitForSelector('text=Sitting still', { timeout: 10000 });
    await page.waitForSelector('text=/sitting still in the top/', { timeout: 10000 });

    // Turned off, it goes; and stays gone over a reload.
    await page.getByRole('button', { name: 'Panels' }).click();
    await page.getByLabel('Busiest hours').uncheck();
    await page.keyboard.press('Escape');
    if (await page.locator('text=Busiest hours').count()) {
      throw new Error('the panel outstayed its unticking');
    }

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=Sitting still', { timeout: 20000 });
    if (await page.locator('text=Busiest hours').count()) {
      throw new Error('the choice was forgotten on reload');
    }

    // The figures along the top are not the reader's to hide: a dashboard with
    // no takings on it is not a dashboard.
    await page.getByRole('button', { name: 'Panels' }).click();
    await page.getByRole('button', { name: /Show them all again/ }).click();
    await page.keyboard.press('Escape');
    await page.waitForSelector('text=Busiest hours', { timeout: 10000 });
  });

  await step('the shop can say what it started with, and watch it grow', async () => {
    /*
     * "I put this much in — am I ahead?" is a question the ledgers do not
     * answer on their own, and it is the one a shopkeeper actually asks.
     */
    await page.goto(`${BASE_URL}/admin/capital`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=What did you start with?', { timeout: 20000 });

    // Offered with what the shelves cost, because adding that up by hand
    // across nine hundred products is how the figure becomes a guess.
    const useStock = page.getByRole('button', { name: /Use what the stock cost/ });
    await useStock.click();
    if (!(await page.locator('#capital_opening').inputValue())) {
      throw new Error('the stock figure did not go into the box');
    }

    await page.getByRole('button', { name: 'Save', exact: true }).click();

    /*
     * The whole screen, and no white one behind it. Saving used to close the
     * form before the reload came back, so the summary rendered against a shop
     * that still had no starting date and read `null.slice(...)` — a blank
     * page, from the one press this screen exists for.
     */
    await page.waitForSelector('text=Capital now', { timeout: 20000 });
    await page.waitForSelector('text=You started with', { timeout: 10000 });

    // The month in hand is shown, and deliberately not counted into the total.
    await page.waitForSelector('text=/is still going/', { timeout: 10000 });
    await page.waitForSelector('text=/No month has finished yet/', { timeout: 10000 });
  });

  await step('a screen the server cannot answer says so, instead of loading for ever', async () => {
    /*
     * The bug this exists for: `await api.get(...)` with nothing around it. A
     * refused request rejected a promise nobody held, the state stayed null,
     * and the skeleton stayed on the glass — for ever, saying "loading" about
     * something that had already finished going wrong. On a shop counter that
     * is indistinguishable from a slow connection, and there is nothing to do
     * about it but wait for something that is never coming.
     *
     * A 404 in particular, because that is the one with a nameable cause: this
     * app's screens and its routes ship together, so a screen asking for a
     * route the server does not have means the two halves are from different
     * builds — a deploy that replaced the files without restarting the app.
     */
    await page.route('**/api/expenses/capital*', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.goto(`${BASE_URL}/admin/capital`, { waitUntil: 'networkidle' });

    await page.waitForSelector('text=Could not load the capital figures', { timeout: 20000 });
    await page.waitForSelector('text=/newer than the server/', { timeout: 10000 });

    // And the skeleton is gone, not sitting underneath the message.
    if (await page.locator('.skeleton').count()) {
      throw new Error('the loading skeleton is still on screen behind the failure');
    }

    /*
     * Trying again is offered, and works — a server that has just been
     * restarted should not need the page reloaded to be believed.
     */
    await page.unroute('**/api/expenses/capital*');
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.waitForSelector('text=Capital now', { timeout: 20000 });
  });

  await step('each kind of paperwork is its own screen, already filtered', async () => {
    /*
     * Writing a purchase invoice used to be a screen, then a tile to narrow
     * four hundred rows, then a dialog with a type to pick — three choices deep
     * for a job the shop does every week. Each kind is a row in the rail now.
     */
    await page.goto(`${BASE_URL}/admin/documents/purchase-invoices`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Purchase invoices', { timeout: 15000 });

    // Only its own kind, and the button already knows what it is making.
    await page.waitForSelector('td:has-text("PI-0001")', { timeout: 15000 });
    if (await page.locator('td:has-text("SI-")').count()) {
      throw new Error('a sales invoice is listed on the purchase invoice screen');
    }
    await page.waitForSelector('button:has-text("New purchase invoice")', { timeout: 10000 });

    // The date range and the search are the ones every history screen carries.
    await page.waitForSelector('input[aria-label^="Search"]', { timeout: 10000 });

    // And another kind is another screen, not another tile on this one.
    await page.goto(`${BASE_URL}/admin/documents/quotations`, { waitUntil: 'networkidle' });
    await page.waitForSelector('button:has-text("New quotation")', { timeout: 15000 });
    if (await page.locator('td:has-text("PI-0001")').count()) {
      throw new Error('a purchase invoice is listed on the quotations screen');
    }
  });

  await step('labels can be printed from a confirmed purchase invoice', async () => {
    await goToDocuments();
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
    await page.getByRole('checkbox', { name: 'Price in pounds' }).uncheck();
    await page.waitForTimeout(300);
    if (await page.locator('.label-sheet').first().locator('text=/ LL/').count()) {
      throw new Error('pound prices still shown after unticking');
    }
  });

  await step("the shop's own name goes on top of the label", async () => {
    // The reason a shop wants it: a label on a shelf in somebody else's shop is
    // just a price, and one with the name on it is theirs.
    await page.getByRole('checkbox', { name: 'Shop name' }).check();
    await page.waitForTimeout(400);
    const heads = await page.locator('.label-sheet .label-shop').count();
    if (heads < 10) throw new Error(`expected the name on every label, found ${heads}`);
    await page.locator('.label-sheet .label-shop').first().waitFor();
  });

  await step('a label that no longer fits says so before it is printed', async () => {
    // Everything at double on a 38 × 21 label runs off the bottom. The shop is
    // allowed to ask for it; what it must not do is print half a barcode with
    // nothing said.
    for (const part of ['Product name', 'Price in dollars', 'Barcode']) {
      await page.getByRole('slider', { name: `Size of ${part.toLowerCase()}` }).fill('2');
    }
    await page.waitForTimeout(400);
    await page.waitForSelector('text=/will be cut off/', { timeout: 10000 });

    // Back down, and the warning goes with it.
    for (const part of ['Product name', 'Price in dollars', 'Barcode']) {
      await page.getByRole('slider', { name: `Size of ${part.toLowerCase()}` }).fill('1');
    }
    await page.waitForTimeout(400);
    if (await page.locator('text=/will be cut off/').count()) {
      throw new Error('the clipping warning outstayed the design that caused it');
    }

    // Put the pounds back so the steps after this see the ordinary label.
    await page.getByRole('checkbox', { name: 'Price in pounds' }).check();
    await page.getByRole('checkbox', { name: 'Shop name' }).uncheck();
    await page.waitForTimeout(300);
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

  await step('a new product goes straight to its labels, counted', async () => {
    /*
     * The usual reason a product is created at all: a box arrived, and the
     * things in it need labels before they reach the shelf. The count comes
     * from the stock that was just typed in, and is editable here — what came
     * in the box and what goes on the shelf are not always the same number.
     */
    await goTo('Products');
    await page.waitForSelector('button:has-text("New product")', { timeout: 15000 });
    await page.click('button:has-text("New product")');

    const dialog = page.locator('[role=dialog]');
    await dialog.getByLabel('Name').fill('Car charger 30W');
    await dialog.getByLabel('SKU').fill('CHG-30W');
    await dialog.getByLabel('Price', { exact: true }).fill('9.00');
    await dialog.getByLabel('Stock on hand').fill('6');
    await dialog.getByRole('button', { name: /Save & label/ }).click();

    // On the label screen, with six of them waiting.
    await page.waitForSelector('text=Loaded from Car charger 30W', { timeout: 15000 });
    await page.waitForSelector('text=/6 labels/', { timeout: 15000 });

    // And the count is the shop's to change, not the invoice's last word.
    await page.getByLabel('Label count for Car charger 30W').fill('4');
    await page.waitForSelector('text=/4 labels/', { timeout: 10000 });
  });

  await step('a quotation converts to a sales order', async () => {
    await goToDocuments();
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
    await goToDocuments();
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
    await goToDocuments();
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

  await step('a new supplier can be created from inside a document', async () => {
    await goToDocuments();
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();

    // Exact, because "New supplier" and "New document" both live on this
    // screen and a substring match has taken a step down that road before.
    await dialog.getByRole('button', { name: 'New supplier', exact: true }).click();
    await page.waitForSelector('[role=dialog] >> text=They will be put on this document', {
      timeout: 15000,
    });
    await page.fill('[role=dialog] #name', 'Bekaa Handset Traders');
    await page.fill('[role=dialog] #phone', '03 445 566');
    await page.click('button:has-text("Add and use")');

    await page.waitForSelector('text=Bekaa Handset Traders added', { timeout: 15000 });

    /*
     * The point of the whole feature: the new supplier is *on the document*,
     * not merely in the database. Adding one and leaving the picker empty
     * would be the same trip to another screen, only better hidden.
     */
    const chosen = await page
      .locator('#doc-party option:checked')
      .textContent()
      .catch(() => '');
    if (!String(chosen).includes('Bekaa Handset Traders')) {
      throw new Error(`the new supplier was not put on the document — the picker says "${chosen}"`);
    }
    await page.keyboard.press('Escape');
  });
  await shot('inline-party');

  await step('a purchase paid in cash leaves no payable behind', async () => {
    await goToDocuments();
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('10');
    await dialog.getByLabel(/Unit price for/i).first().fill('1');

    await dialog.getByRole('button', { name: /Paid in full/ }).click();
    await dialog.getByLabel('Method').selectOption('cash');
    // The form is a screen now, so its own figures are not in a dialog.
    await dialog.locator('text=Settled').first().waitFor({ timeout: 10000 });

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
    await goToDocuments();
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Purchase invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Corner Bakehouse' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('10');
    await dialog.getByLabel(/Unit price for/i).first().fill('10');

    await dialog.getByRole('button', { name: /Part paid/ }).click();
    await dialog.getByLabel('Amount paid now').fill('40');
    // $100 plus 8% tax, less the $40 handed over — still on the form.
    await dialog.locator('text=$68.00').first().waitFor({ timeout: 10000 });

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
    await goToDocuments();
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
    await goToDocuments();
    await page.click('td:has-text("PI-0002")');
    await page.waitForSelector('text=Print labels', { timeout: 15000 });

    await page.click('button:has-text("Delete")');
    await page.waitForSelector('text=/This cannot be undone/', { timeout: 15000 });
    await page.click('button:has-text("Delete PI-0002")');
    await page.waitForSelector('text=/PI-0002 deleted/', { timeout: 15000 });

    /*
     * Waited for rather than asserted on the spot: the toast fires when the
     * server answers and the list reloads a moment after it, so a bare count
     * here was a race the suite lost about one run in ten.
     */
    await page
      .locator('td:has-text("PI-0002")')
      .first()
      .waitFor({ state: 'detached', timeout: 15000 })
      .catch(() => {
        throw new Error('the deleted document is still listed');
      });
  });

  await step('a document another was created from cannot be deleted', async () => {
    await page.click('td:has-text("QT-0001")');
    await page.waitForSelector('text=/SO-0001/', { timeout: 15000 });
    if (await page.getByRole('button', { name: 'Delete', exact: true }).isEnabled()) {
      throw new Error('a converted quotation should not be deletable');
    }
    await page.keyboard.press('Escape');
  });

  /*
   * A sale that happens on paper rather than at the counter — a customer who
   * wants an invoice, paid there and then in cash. It is the case the next two
   * steps are about: it has to reach the sales list, and its money has to reach
   * the voucher book.
   */
  await step('a sales invoice paid in cash is confirmed', async () => {
    await goToDocuments();
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Sales invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Rami Haddad' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');
    await dialog.getByLabel(/Quantity for/i).first().fill('2');

    await dialog.getByRole('button', { name: /Paid in full/ }).click();
    await dialog.getByLabel('Method').selectOption('cash');
    // The form is a screen now, so its own figures are not in a dialog.
    await dialog.locator('text=Settled').first().waitFor({ timeout: 10000 });

    await page.click('button:has-text("Create draft")');
    await page.waitForSelector('text=/SI-\\d{4}/', { timeout: 15000 });
    await page.click('button:has-text("Confirm")');
    await page.waitForSelector('text=confirmed', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('the next invoice says what this customer paid last time', async () => {
    /*
     * A shop here does not have one price for a thing — it has the price it
     * quoted this man in March, and going back on it is how a regular stops
     * being one. Shown rather than applied: prices do go up, and quietly
     * re-pricing a line to a figure from the spring would be worse than not
     * knowing.
     */
    await goToDocuments();
    const dialog = await openNewDocument();
    await dialog.getByRole('button', { name: /Sales invoice/ }).click();
    await dialog.locator('#doc-party').selectOption({ label: 'Rami Haddad' });
    await dialog.getByLabel('Search products to add').fill('Croissant');
    await dialog.getByLabel('Search products to add').press('Enter');

    // What he was charged on the invoice above, offered beside the price box.
    const lastPaid = dialog.locator('button[aria-label^="Last time"]').first();
    await lastPaid.waitFor({ timeout: 10000 });

    // Knocked down, then put back to his price with one tap.
    const price = dialog.getByLabel(/Unit price for/i).first();
    await price.fill('99');
    await lastPaid.click();
    if ((await price.inputValue()) === '99') throw new Error('his old price did not go back on');

    await page.keyboard.press('Escape');
  });

  /*
   * Placed after the documents section on purpose: it needs a confirmed sales
   * invoice to exist, and nothing before this point has made one.
   */
  await step('a confirmed invoice is listed among the sales, and is findable by number', async () => {
    await goTo('Sales');

    /*
     * Anchored on this screen's own search box before anything is read.
     *
     * Every history now carries the same bar, and several of them carry a
     * table and an "All" — so a check that starts reading the moment a table
     * exists can be reading the screen it just left.
     */
    const box = page.locator('input[aria-label="Search sales"]');
    try {
      await box.waitFor({ timeout: 20000 });
    } catch {
      const shown = await page.locator('main').innerText();
      throw new Error(`the Sales screen did not arrive. The page says:\n${shown.slice(0, 400)}`);
    }

    // The default view first: this month, which is where a shop looks without
    // pressing anything.
    const table = page.locator('table').first();
    await table.waitFor({ timeout: 20000 });
    try {
      await page.waitForFunction(
        () => document.querySelector('table')?.innerText.includes('ORD-'),
        null,
        { timeout: 15000 },
      );
    } catch {
      throw new Error(
        `the register sales have gone from their own screen. The list holds:\n${(await table.innerText()).slice(0, 400)}`,
      );
    }

    // Widened to everything, so an invoice confirmed earlier in this run is in
    // range whichever day the suite happens to run on.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(700);

    const listed = await table.innerText();
    if (!/SI-\d+/.test(listed)) {
      throw new Error(`no sales invoice among the sales. The list holds:\n${listed.slice(0, 400)}`);
    }

    // And the search box finds one by its number, which is what somebody
    // holding a printed invoice actually has.
    const number = listed.match(/SI-\d+/)[0];
    await page.fill('input[aria-label="Search sales"]', number);
    await page.waitForTimeout(500);
    const filtered = await table.innerText();
    if (!filtered.includes(number)) throw new Error('searching by invoice number lost it');
    if (filtered.includes('ORD-')) throw new Error('the search did not narrow anything');

    await page.fill('input[aria-label="Search sales"]', '');
    await page.waitForTimeout(300);
  });

  /*
   * A customer comes back a week later wanting the paper for a warranty claim.
   *
   * And the paper is whichever paper they asked for: the size used to be set in
   * two places at once — a stylesheet and the dialog — and which of them won
   * came down to where in the document their rules ended up, so a receipt set
   * to A4 came out on the roll. One thing owns it now, and this reads it back.
   */
  await step('any sale can be printed again, on the paper that was chosen', async () => {
    await goTo('Sales');
    await page.waitForSelector('input[aria-label="Search sales"]', { timeout: 20000 });
    await page.locator('tr', { hasText: /ORD-/ }).first().click();

    await page.getByRole('button', { name: /Print the receipt again/ }).click();
    await page.waitForSelector('[role=dialog] >> text=Receipt', { timeout: 15000 });

    const pageRule = async () =>
      page.evaluate(() => document.getElementById('pos-page-size')?.textContent || '');

    // The receipt opens over the sale it came from, so both are dialogs — this
    // one is the one with the paper toggle on it.
    const sheet = page.locator('[role=dialog]', { hasText: '80mm roll' }).last();

    await page.getByRole('button', { name: 'A4 sheet', exact: true }).click();
    await page.waitForTimeout(200);
    if (!/size:\s*A4/.test(await pageRule())) {
      throw new Error(`asked for A4 and the page is set to: ${await pageRule()}`);
    }

    /*
     * And the sheet is a different document, not the roll stretched wider: a
     * table with headings over its columns, and the customer named on it.
     */
    if (!(await sheet.locator('th', { hasText: 'Unit price' }).count())) {
      throw new Error('the A4 sheet has no table headings — it is still the till roll');
    }
    // Case-insensitive: the heading is upper-cased in CSS, and innerText
    // returns what is rendered rather than what is written.
    if (!/sold to/i.test(await sheet.innerText())) {
      throw new Error('the A4 sheet does not say who it was sold to');
    }

    await page.getByRole('button', { name: '80mm roll', exact: true }).click();
    await page.waitForTimeout(200);
    if (!/72mm/.test(await pageRule())) {
      throw new Error(`asked for the roll and the page is set to: ${await pageRule()}`);
    }

    // And back to the narrow column, with no table on it.
    if (await sheet.locator('th', { hasText: 'Unit price' }).count()) {
      throw new Error('the till roll grew a table');
    }

    // And nothing else in the app is also setting it, which was the bug.
    const rules = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((sheet) => {
          try {
            return [...sheet.cssRules];
          } catch {
            return [];
          }
        })
        .filter((r) => r.constructor.name === 'CSSPageRule').length,
    );
    if (rules > 1) throw new Error(`${rules} page rules are live; exactly one may be`);

    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.keyboard.press('Escape');
  });

  await step('the money taken on that invoice is in the voucher book', async () => {
    await goTo('Vouchers');

    /*
     * This screen's own box first, as on the Sales screen and for the same
     * reason: the list it was just looking at also holds the invoice's number,
     * so a read taken before the route swaps finds it on the wrong table.
     */
    await page.waitForSelector('input[aria-label="Find a voucher"]', { timeout: 20000 });
    await page.waitForSelector('table', { timeout: 20000 });

    // The slip is written when the invoice is confirmed, so it is already
    // there — but the list is fetched, and a fetch takes as long as it takes.
    const row = page.locator('tr', { hasText: /SI-\d+/ }).first();
    try {
      await row.waitFor({ timeout: 15000 });
    } catch {
      const listed = await page.locator('table').first().innerText();
      throw new Error(`the invoice's receipt is not among the vouchers. The book holds:\n${listed.slice(0, 400)}`);
    }

    /*
     * And it cannot be voided on its own. The invoice still says it was paid,
     * so undoing the receipt here would hand the money back twice — the
     * correction has to be made on the invoice.
     */
    const number = (await row.innerText()).match(/(PV|RV|TV)-\d+/)[0];
    await page.getByRole('button', { name: `Cancel ${number}` }).click();

    // Asked first, like everything else that moves money.
    await confirmDialog(`Cancel ${number}?`, 'Cancel it and put the money back');

    await page.waitForSelector('text=/cancel that invoice instead/', { timeout: 15000 });
  });

  await step('the cashbox closes against a blind count', async () => {
    await goTo('Register');
    /*
     * The drawer's figures are always on the strip in the header; its buttons
     * hang below as a menu. A menu closes when you touch anything else, so each
     * of the three trips to it opens it again — which is what a person does.
     */
    const openMoney = async () => {
      if (await page.locator('button:has-text("Cash out"):visible').count()) return;
      await page.click('button[aria-label="Show the drawer detail"]');
      await page.waitForSelector('button:has-text("Cash out")', { timeout: 15000 });
    };
    await openMoney();

    // Money out of the drawer for an expense.
    await openMoney();
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
    await openMoney();
    await page.click('button:has-text("Cash out")');
    await page.waitForSelector('text=Money coming out of the drawer', { timeout: 10000 });
    await page.getByLabel('Reason').selectOption('expense');
    await page.getByLabel('Dollars').fill('9999');
    await page.getByLabel('What for?').fill('More than is in there');
    await page.click('button:has-text("Take out")');
    await page.waitForSelector('text=/more than the drawer holds/i', { timeout: 15000 });
    /*
     * The drawer has gone below zero, and the header says so in words rather
     * than only in red. The sentence explaining it is in the menu, which is
     * where somebody who reads "Drawer short" goes next.
     */
    await page.waitForSelector('text=Drawer short', { timeout: 15000 });
    await openMoney();
    await page.waitForSelector('text=/More has gone out than came in/', { timeout: 15000 });

    // Put it back, so the count below is against a drawer that makes sense.
    await openMoney();
    await page.click('button:has-text("Cash in")');
    await page.waitForSelector('text=Money going into the drawer', { timeout: 10000 });
    await page.getByLabel('Reason').selectOption('correction');
    await page.getByLabel('Dollars').fill('9999');
    await page.getByLabel('What for?').fill('Putting back the over-payout');
    await page.click('button:has-text("Put in")');
    await page.waitForSelector('text=/added to the drawer/i', { timeout: 15000 });

    await openMoney();
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

    /*
     * And the paper behind a line. "When did eighteen of these arrive" is
     * always followed by "on what, and can I have a copy" — so a row that came
     * from a sale opens that sale's receipt, print button and all.
     */
    await page.locator('[role=dialog] tr', { hasText: /ORD-/ }).first().click();
    await page.waitForSelector('[role=dialog] >> text=/80mm roll/', { timeout: 15000 });
    const reprint = page.locator('[role=dialog]').last();
    if (!/ORD-/.test(await reprint.innerText())) {
      throw new Error('the row opened something that is not the sale it names');
    }
    await reprint.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForTimeout(300);
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

  await step('a walk-in becomes a customer without leaving the sale', async () => {
    /*
     * Somebody is standing at the counter asking for it on the slate. Sending
     * the cashier to the back office to create them means abandoning the sale
     * and ringing the whole thing up again.
     */
    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.getByRole('button', { name: /^Bagel/ }).first().click();

    await page.click('button:has-text("Add customer")');
    await page.waitForSelector('text=Choose a customer', { timeout: 15000 });
    await page.getByRole('button', { name: /New customer/ }).click();

    const form = page.locator('[role=dialog]').last();
    await form.getByLabel('Name').fill('Hussein the plumber');
    await form.getByLabel('Phone').fill('03 777 888');
    await form.getByRole('button', { name: /Add and use/ }).click();

    // Straight onto the sale in progress — creating them was never the point.
    await page.waitForSelector('text=Hussein the plumber', { timeout: 15000 });

    // And they are a customer from now on, not just a name on this sale.
    await goTo('Customers');
    await page.waitForSelector('td:has-text("Hussein the plumber")', { timeout: 15000 });
  });

  await step('admin can change the exchange rate', async () => {
    await goTo('Settings');
    await page.waitForSelector('text=Exchange rate', { timeout: 15000 });

    // Scoped to its own card: the settings page has more than one form with a
    // Save on it now, and the tax one is disabled until it is touched.
    const rateCard = page.locator('form', {
      has: page.getByLabel('Lebanese pounds per 1 US dollar'),
    });
    await rateCard.getByLabel('Lebanese pounds per 1 US dollar').fill('95000');
    await rateCard.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForSelector('text=Exchange rate updated', { timeout: 15000 });
    // The preview and history reflect the new rate.
    await page.waitForSelector('text=95,000');
  });
  await shot('settings');

  /*
   * Tax was an environment variable pinned at eight per cent, so every shop
   * sold a copy charged it whether or not it should. Turning it off is the
   * thing most shops here will do first, so it is worth doing in a browser.
   */
  await step('tax can be turned off, and the register stops charging it', async () => {
    const taxCard = page.locator('form', { has: page.getByRole('checkbox', { name: /Charge tax/ }) });
    await taxCard.getByRole('checkbox', { name: /Charge tax/ }).uncheck();
    await taxCard.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForSelector('text=Tax turned off', { timeout: 15000 });

    await goTo('Register');
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.getByRole('button', { name: /^Espresso/ }).first().click();
    await page.waitForSelector('aside >> text=Espresso', { timeout: 10000 });
    // No tax line at all, rather than a line reading zero.
    if (await page.locator('aside >> text=/^Tax/').count()) {
      throw new Error('the register still shows a tax line with tax switched off');
    }
    await page.click('aside button:has-text("Clear")');
  });

  await step('and back on again, at the shop’s own rate', async () => {
    await goTo('Settings');
    const taxCard = page.locator('form', { has: page.getByRole('checkbox', { name: /Charge tax/ }) });
    await taxCard.getByRole('checkbox', { name: /Charge tax/ }).check();
    await taxCard.getByLabel('Rate').fill('8');
    await taxCard.getByRole('button', { name: 'Save changes' }).click();
    await page.waitForSelector('text=/set to 8%/', { timeout: 15000 });
  });

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
    // The chip on the header is the handle now — the column it used to live in
    // was a third of a laptop screen saying one figure.
    await page.click('button:has-text("Cashbox closed")');
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

  /*
   * The other half of a transfer: the drawer knows the cash moved, and this is
   * what the agency thinks. The whole point of it is the comparison an operator
   * makes at the end of a day against the agency's own app.
   */
  await step('the agency carries the balance the transfers left it', async () => {
    // Opened by the transfer above, without anybody having to create it first.
    const agencies = page.locator('table', { hasText: 'Standing' }).first();
    await agencies.waitFor({ timeout: 15000 });

    const row = agencies.locator('tr', { hasText: 'OMT' }).first();
    await row.waitFor({ timeout: 15000 });

    const text = await row.innerText();
    // $150 sent is theirs; the $3 fee is the shop's and is not on it.
    if (!text.includes('$150.00')) {
      throw new Error(`the agency's balance is not what the counter took: ${text}`);
    }
    if (!/you owe them/i.test(text)) {
      throw new Error(`money taken for an agency is money owed to them: ${text}`);
    }
  });

  /*
   * Pounds are owed as pounds.
   *
   * The balance used to be one converted figure, which is the right answer to
   * "what is this account worth" and no use at all to the operator counting
   * money into the rider's hand at seven o'clock. Both piles, side by side.
   */
  await step('and pounds stay pounds on the agency\u2019s account', async () => {
    await page.click('button:has-text("New transfer")');
    await page.waitForSelector('[role=dialog] >> text=Send a transfer', { timeout: 10000 });
    const dialog = page.locator('[role=dialog]');
    await dialog.locator('#customerName').fill('Nadia Khoury');
    await dialog.locator('#amountLbp').fill('890000');
    await dialog.getByRole('button', { name: 'Take the money' }).click();
    await page.waitForSelector('text=Transfer sent', { timeout: 15000 });

    /*
     * Waited for, not read once. The toast fires when the server answers and
     * the agency list reloads a moment later, so reading the row on the toast
     * is reading the row as it was before the transfer — which is what CI saw
     * and this machine did not.
     */
    const row = page.locator('tr', { hasText: 'OMT' }).first();
    await row.waitFor({ timeout: 15000 });
    await row
      .locator('text=/890,000/')
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {
        throw new Error('the pounds were converted away instead of being owed');
      });

    // And the dollars are still their own figure beside them.
    const text = await row.innerText();
    if (!text.includes('$150.00')) {
      throw new Error(`the dollars stopped being their own figure: ${text}`);
    }
  });

  /*
   * And the same screen against a server that has not caught up.
   *
   * A shop deploys by pulling the code and restarting; if the API is missed,
   * the new client talks to the old server, which answers without the two
   * piles. That used to render an empty cell where the balance goes — a
   * transfer desk that has quietly stopped saying what is owed, which is worse
   * than showing the old figure. It shows the old figure.
   */
  await step('and a server that has not caught up still shows a balance', async () => {
    await page.route('**/api/transfers/companies*', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.companies = (body.companies || []).map((c) => {
        const { balanceUsd, balanceLbp, ...rest } = c;
        void balanceUsd;
        void balanceLbp;
        return rest;
      });
      await route.fulfill({ response: res, json: body });
    });

    await page.reload({ waitUntil: 'networkidle' });
    const row = page.locator('tr', { hasText: 'OMT' }).first();
    await row.waitFor({ timeout: 15000 });
    await row
      .locator('text=/\\$\\d/')
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {
        throw new Error('the balance went blank when the split was missing');
      });

    await page.unroute('**/api/transfers/companies*');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('tr:has-text("OMT") >> text=/890,000/', { timeout: 15000 });
  });

  /*
   * Running the desk and saying where the count starts are different jobs.
   *
   * The opening balance is the figure every later balance is measured from, so
   * moving it moves what the shop appears to owe without anything having
   * happened at the counter — which is exactly what somebody who is short
   * would reach for. This whole section is signed in as the operator.
   */
  await step('the operator is not offered the opening balance', async () => {
    const row = page.locator('tr', { hasText: 'OMT' }).first();
    if (await row.getByRole('button', { name: 'Opening' }).count()) {
      throw new Error('the desk can rewrite the figure its own count is measured against');
    }
  });

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

  // The slip the settlement writes, checked against the drawer further down.
  let settleSlip;

  /*
   * The end of the day at the counter.
   *
   * The whole reason the balance is kept: the rider comes round and either the
   * shop hands over what it is holding or the agency makes it good. Done from
   * the desk, by the operator, on the screen showing the balance that says it
   * is due — not on a general-purpose voucher form they may not even have.
   */
  await step('the operator settles the day up with the agency', async () => {
    /*
     * The agency's row, not a transfer's. This screen carries two tables and
     * both mention Whish, so the row is found by the thing only the agency's
     * has on it — the button this step is about to press.
     */
    const row = page
      .locator('tr', { hasText: 'Whish' })
      .filter({ has: page.getByRole('button', { name: 'Settle up' }) })
      .first();
    await row.waitFor({ timeout: 15000 });
    // $50 was paid out on their behalf and nothing held against it.
    if (!/we collect this from them/i.test(await row.innerText())) {
      throw new Error(`the row does not say which way the money goes: ${await row.innerText()}`);
    }

    await row.getByRole('button', { name: 'Settle up' }).click();
    const dialog = page.locator('[role=dialog]');
    await dialog.locator('text=Settle with Whish').waitFor({ timeout: 15000 });

    // Filled in from the balance, and pointed the way the balance points.
    if ((await dialog.locator('#settleUsd').inputValue()) !== '50.00') {
      throw new Error('the amount owing was not carried into the form');
    }
    await dialog.locator('text=they owe us').waitFor();

    await dialog.getByRole('button', { name: 'Take it in' }).click();

    // Straight to the slip, because a settlement is a piece of paper too.
    const slip = page.locator('[role=dialog]', { hasText: /RV-\d{4}/ }).first();
    await slip.waitFor({ timeout: 15000 });
    settleSlip = (await slip.innerText()).match(/RV-\d{4}/)[0];
    // The payee, which the slip printed blank until the day it was noticed.
    await slip.locator('text=Received from').waitFor();
    await slip.locator('text=Settling with a transfer agency').waitFor();
    await closeDialog();

    await page.waitForSelector('tr:has-text("Whish") >> text=nothing to settle', { timeout: 15000 });
  });

  await step('an expense out of the same drawer is recorded, not absorbed', async () => {
    /*
     * Exactly "Expense", not anything containing it.
     *
     * The tab strip names each open page on a button of its own, so once this
     * run has been to the Expenses screen there is a button reading "Expenses"
     * — and a substring match finds that first and merely switches tabs. The
     * dialog then never opens, from a click that looked like it worked.
     */
    await page.getByRole('button', { name: 'Expense', exact: true }).click();
    await page.waitForSelector('[role=dialog] >> text=Money spent running the shop', { timeout: 10000 });
    await page.locator('[role=dialog] #amountUsd').fill('4');
    await page.locator('[role=dialog] #note').fill('Water for the counter');
    await page.click('[role=dialog] button:has-text("Record it")');
    await page.waitForSelector('text=Expense recorded', { timeout: 15000 });
  });

  // Carried from where the slips are written to where the drawer is checked.
  let paymentSlip;
  let receiptSlip;

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

    /*
     * Straight to the slip, because a voucher exists to be signed.
     *
     * The number is read rather than assumed: invoices settled at the counter
     * write their own slips into the same two series, so which one this is
     * depends on what the shop has already done today. Read out of the slip
     * itself, too — the list behind it holds every other voucher in the shop,
     * and its first row is a different number.
     */
    const slip = page.locator('[role=dialog]', { hasText: /PV-\d{4}/ }).first();
    await slip.waitFor({ timeout: 15000 });
    paymentSlip = (await slip.innerText()).match(/PV-\d{4}/)[0];
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

    const slip = page.locator('[role=dialog]', { hasText: /RV-\d{4}/ }).first();
    await slip.waitFor({ timeout: 15000 });
    receiptSlip = (await slip.innerText()).match(/RV-\d{4}/)[0];
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

  await step('and the owner can, on top of what the counter has done', async () => {
    await goTo('Transfers');
    const row = page.locator('tr', { hasText: 'OMT' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.getByRole('button', { name: 'Opening' }).click();
    await page.waitForSelector('[role=dialog] >> text=opening balance', { timeout: 15000 });

    await page.locator('[role=dialog] #openingUsd').fill('500');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Set it' }).click();
    await page.waitForSelector('text=/opening balance set/', { timeout: 15000 });

    // Carried in on top of the counter's own work, not instead of it.
    await page.waitForSelector('tr:has-text("OMT") >> text=$650.00', { timeout: 15000 });
  });

  /*
   * Reported from a live shop: putting the tabs away was throwing the owner
   * back to the register every time, which turns "tidy this up" into "and lose
   * what I was doing".
   */
  await step('putting the tabs away leaves you on the page you were on', async () => {
    await goTo('Products');
    await goTo('Sales');
    await page.waitForSelector('input[aria-label="Search sales"]', { timeout: 20000 });

    const strip = page.locator('nav[aria-label="Open pages"]');
    await strip.waitFor({ timeout: 15000 });
    const before = new URL(page.url()).pathname;

    await strip.getByRole('button', { name: 'Close the rest' }).click();
    await page.waitForTimeout(400);

    if (new URL(page.url()).pathname !== before) {
      throw new Error(`closing the tabs moved us from ${before} to ${new URL(page.url()).pathname}`);
    }
    // Still the page it was, not a register that happens to be at /admin/orders.
    await page.waitForSelector('input[aria-label="Search sales"]', { timeout: 15000 });

    // One page open is no strip at all — there is nothing left to switch to.
    if (await page.locator('nav[aria-label="Open pages"]').count()) {
      throw new Error('the strip is still there with one page open');
    }
  });

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
    // $100 float + $153 in − $49 out + $50 settled − $4 spent − $300 paid + $25 taken.
    await dialog.locator('text=-$25.00').first().waitFor();
    await dialog.locator('text=OMT send').first().waitFor();
    await dialog.locator('text=Whish payout').first().waitFor();
    await dialog.locator(`text=${settleSlip}`).first().waitFor();
    await dialog.locator(`text=${paymentSlip}`).first().waitFor();
    await dialog.locator(`text=${receiptSlip}`).first().waitFor();

    // The next step logs out, and the backdrop would swallow the click.
    await closeDialog();
  });

  /*
   * The transfer counter as its own position.
   *
   * Reported from the shop: the desk and the register were sharing one drawer,
   * so the operator's float and the cashier's takings were the same pile and
   * neither could be counted. The desk gets a till of its own, and the two
   * cashboxes stop being one.
   */
  await step('the transfer desk can be given a drawer of its own', async () => {
    await goTo('Transfers');
    await page.waitForSelector('text=/Money sent and paid out/', { timeout: 15000 });

    await page.getByRole('button', { name: 'Its own drawer' }).click();
    await page.waitForSelector('[role=dialog] >> text=The desk’s drawer', { timeout: 10000 });
    // This shop already has more than one till by now, so the dialog opens on
    // choosing between them; the counter wants one of its own.
    await page.locator('[role=dialog]').getByRole('button', { name: 'A new drawer' }).click();
    await page.locator('[role=dialog] #tillName').fill('Transfer desk');
    await page.locator('[role=dialog]').getByRole('button', { name: 'Use it' }).click();
    await page.waitForSelector('text=/The desk has its own drawer/', { timeout: 15000 });

    // The desk names its drawer, and that drawer is shut — the register's is
    // not, which is the whole point of them being two.
    await page.waitForSelector('header >> text=Transfer desk', { timeout: 15000 });
    await page.waitForSelector('header >> text=Cashbox closed', { timeout: 15000 });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    if (await page.locator('button:has-text("Cashbox closed")').count()) {
      throw new Error('opening a drawer for the desk closed the register’s');
    }

    // And handed back, so the rest of this run counts one till as it did.
    await goTo('Transfers');
    await page.getByRole('button', { name: 'Change the drawer' }).click();
    await page.waitForSelector('[role=dialog] >> text=The desk’s drawer', { timeout: 10000 });
    await page.locator('[role=dialog]').getByRole('button', { name: 'Share the register’s' }).click();
    await page.waitForSelector('text=/back on the register/', { timeout: 15000 });
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

  /*
   * Enter adds a line. It does not send the transfer.
   *
   * A form with one line of text in it is submitted by Enter — that is what
   * browsers do — so typing a product name and pressing Enter, which is what
   * anybody does, dispatched the whole transfer with one line on it or none.
   * A scanner is worse: it types the code and presses Enter itself, so
   * scanning the first box of a delivery sent it.
   */
  /*
   * Arrows pick the row, Enter takes it.
   *
   * A list you can only reach with the mouse is a list a counter cannot use
   * with one hand. The document form has had this; the transfer had a list and
   * no way down it.
   */
  await step('on a transfer, the arrows move down the matches', async () => {
    await goTo('Move stock');
    await page.waitForSelector('button:has-text("Send stock")', { timeout: 15000 });
    await page.click('button:has-text("Send stock")');
    await page.waitForSelector('input[aria-label="Find a product to send"]', { timeout: 10000 });

    /* Two words, in the wrong order, with a word between them in the product's
       own name — the shop's complaint, on the screen it was reported from. */
    await page.fill('input[aria-label="Find a product to send"]', 'cable braided');
    await page.waitForTimeout(400);

    const lit = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('ul > li button')]
          .map((b, i) => (b.className.includes('bg-brand-50') ? i : -1))
          .filter((i) => i >= 0),
      );

    const rows = await page.locator('ul > li button').count();
    if (rows === 0) throw new Error('"cable braided" found nothing — the words have to match in any order');
    if ((await lit())[0] !== 0) throw new Error('nothing is highlighted to start with');

    if (rows > 1) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      if ((await lit())[0] !== 1) throw new Error('ArrowDown did not move the highlight');
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(200);
      if ((await lit())[0] !== 0) throw new Error('ArrowUp did not move it back');
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    if (!(await page.locator('[data-qty-for]').count())) {
      throw new Error('Enter did not take the highlighted row');
    }

    await page.click('[role=dialog] button:has-text("Cancel")');
    await page.waitForTimeout(400);
  });

  await step('on a transfer, Enter adds the line and moves to the quantity', async () => {
    await goTo('Move stock');
    await page.waitForSelector('button:has-text("Send stock")', { timeout: 15000 });
    await page.click('button:has-text("Send stock")');
    await page.waitForSelector('[role=dialog] >> text=To which branch', { timeout: 10000 });

    await page.fill('input[aria-label="Find a product to send"]', 'Braided');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    // The transfer must still be sitting there, unsent.
    if (!(await page.locator('[role=dialog]').count())) {
      throw new Error('Enter in the search sent the transfer');
    }

    /* And the cursor is on that line's quantity with the 1 selected, so the
       next thing typed is the number — the loop the purchase invoice uses. */
    const landed = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        label: el.getAttribute('aria-label'),
        allSelected: el.selectionStart === 0 && el.selectionEnd === String(el.value).length,
      };
    });
    if (!/^How many /.test(landed.label || '')) {
      throw new Error(`after Enter the cursor is on "${landed.label}", not a quantity box`);
    }
    if (!landed.allSelected) {
      throw new Error('the quantity is not selected, so typing 12 would give 112');
    }

    await page.keyboard.type('3');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    if (!(await page.locator('[role=dialog]').count())) {
      throw new Error('Enter in the quantity sent the transfer');
    }

    // Left as it was found; the step below sends one for real.
    await page.click('[role=dialog] button:has-text("Cancel")');
    await page.waitForTimeout(400);
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

  /*
   * Switching branches has to move the screen you are already looking at.
   *
   * The steps above all switch and then *navigate*, which remounts the page
   * anyway — so they went on passing while the app was broken. What was
   * actually happening: the switch changed the branch header on every request
   * and nothing else, so the page in front of you kept the figures it had
   * loaded for the shop you just left, and only told the truth once you
   * happened to go somewhere else and come back. A shopkeeper reading the
   * first shop's stock while the rail says they are in the second is the whole
   * failure branches exist to prevent.
   *
   * So this one stays put on a single screen and watches the number change.
   */
  await step('switching branch moves the page you are already on', async () => {
    /** What the Products table says is on this branch's shelf. */
    const onTheShelf = async () => {
      const row = page.locator('tr:has-text("Braided cable")').first();
      await row.waitFor({ timeout: 15000 });
      const found = (await row.innerText()).match(/(?:In stock|Low)\s*·\s*(\d+)/);
      if (!found) throw new Error(`no stock figure in the row: ${(await row.innerText()).trim()}`);
      return Number(found[1]);
    };

    /*
     * `name` omitted means the first in the list, which is the main branch —
     * the list is ordered with it first. Picked by position rather than by
     * name because the main branch is named after the shop once the shop has
     * a name, and by then this run has given it one.
     */
    const switchTo = async (name) => {
      await page.locator('button[aria-label*="Branch:"]:visible').first().click();
      await page.waitForTimeout(300);
      const option = name
        ? page.locator(`div.absolute button:has-text("${name}")`)
        : page.locator('div.absolute button');
      await option.first().click();
      // No navigation on purpose. If the page does not follow by itself, it
      // does not follow at all.
      await page.waitForTimeout(1500);
    };

    await goTo('Products');
    await page.waitForSelector('tr:has-text("Braided cable")', { timeout: 20000 });

    // Ten were booked in, four were sent to Saida.
    const main = await onTheShelf();
    if (main !== 6) throw new Error(`expected 6 left on the main shelf, got ${main}`);

    await switchTo('Saida');
    const saida = await onTheShelf();
    if (saida !== 4) {
      throw new Error(
        `the page did not follow the branch: still showing ${saida} where Saida holds 4`,
      );
    }

    // And back, so it follows in both directions rather than only away.
    await switchTo();
    const back = await onTheShelf();
    if (back !== 6) throw new Error(`coming back showed ${back} rather than 6`);
  });

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

  console.log('\nA feature the shop did not buy');

  /*
   * Modules are what the shop *bought*, as against what anybody in it may do.
   * The difference only shows in a browser: the owner passes every permission
   * there is, so the check worth making is that the screen is gone for them.
   */
  await step('a feature switched off disappears from the menu', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const control = new DatabaseSync(process.env.E2E_CONTROL_DB);
    // Everything except the transfer desk, as the console would write it.
    const { MODULE_KEYS, serialiseModules } = await import('../server/src/lib/modules.js');
    control
      .prepare('UPDATE tenants SET modules = ? WHERE slug = ?')
      .run(serialiseModules(MODULE_KEYS.filter((k) => k !== 'transfers')), 'e2e');
    control.close();

    await signOut();
    await signIn('admin');
    await openMenu();
    await page.waitForSelector('main a[title="Products"]', { timeout: 15000 });

    if (await page.locator('main a[title="Transfers"]').count()) {
      throw new Error('the transfer desk is still on the menu for a shop that has not bought it');
    }
  });

  await step('and the till refuses it even if the address is typed in', async () => {
    // The owner passes every permission, so this is the check that matters.
    const refused = await page.evaluate(async () => {
      const r = await fetch('/api/transfers', {
        headers: { Authorization: `Bearer ${localStorage.getItem('pos_token')}` },
      });
      return r.status;
    });
    if (refused !== 403) throw new Error(`the transfer desk answered ${refused}, not 403`);
  });

  await step('and comes back the moment it is sold to them', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const control = new DatabaseSync(process.env.E2E_CONTROL_DB);
    control.prepare('UPDATE tenants SET modules = NULL WHERE slug = ?').run('e2e');
    control.close();

    // No restart, no redeploy — the shop reads the book on every call.
    await page.reload({ waitUntil: 'networkidle' });
    await openMenu();
    await page.waitForSelector('main a[title="Transfers"]', { timeout: 15000 });
  });

  console.log('\nA phone in part-exchange');

  /*
   * The commonest sale in a phone shop is a swap, and the case worth testing in
   * a browser is the one that used to have no flow at all: the old phone being
   * worth more than the new one, so the shop is the one paying.
   */
  await step('the shop pays the difference when the old phone is worth more', async () => {
    await signOut();
    await signIn('admin');
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    // Anything on the cart will do; what is being tested is the balance.
    await page.click(scanBox);
    await page.fill(scanBox, 'Espresso');
    await page.waitForTimeout(400);
    await page.click('button:has-text("Espresso")');
    await page.waitForSelector('aside >> text=Espresso', { timeout: 15000 });

    // The button changes its mind once there is a cart: this is a swap now.
    await page.click('button[title="Take their old phone off this sale"]');
    await page.waitForSelector('text=What it is worth comes off this sale', { timeout: 15000 });

    const dialog = page.locator('[role=dialog]');
    await dialog.locator('#model').fill('Galaxy A15');
    await dialog.locator('button', { hasText: 'Galaxy A15' }).first().click();
    await dialog.getByRole('textbox', { name: 'IMEI' }).fill('359988776650001');
    await dialog.getByRole('spinbutton', { name: 'What is their phone worth?' }).fill('40');

    // The dialog says which way the money goes before anybody commits to it —
    // a $40 phone against a $3.50 coffee means the shop is the one paying.
    await page.waitForSelector('[role=dialog] >> text=/You pay the customer/', { timeout: 10000 });
    await dialog.getByRole('button', { name: 'Take it off the sale' }).click();

    // A $40 phone against a $3.50 coffee: the shop owes the customer.
    await page.waitForSelector('aside >> text=You pay the customer', { timeout: 15000 });
    await page.waitForSelector('aside >> button:has-text("Pay the customer")', { timeout: 10000 });
  });

  await step('and the sale goes through with the money leaving the drawer', async () => {
    await page.click('aside button:has-text("Pay the customer")');
    // Asked by the app rather than by the browser: a native prompt looks like a
    // scam warning on a shop tablet, and cannot be read in Arabic.
    await confirmDialog(/Hand the customer/, 'Hand it over');
    await page.waitForSelector('text=Payment complete', { timeout: 20000 });
    await page.keyboard.press('Escape');
  });

  console.log('\nA pack, and the customer who wants the blue one');

  /*
   * The reason a shop sells packs at all is that most of what is in one is the
   * same every time and one thing is not. Until the counter could change it,
   * the answers were to refuse the customer or to sell the pack and fix the
   * shelves by hand — which nobody does on a Saturday.
   */
  await step('two cases and a pack made of one of them', async () => {
    await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=New product', { timeout: 15000 });

    for (const [name, sku, price, cost, stock] of [
      ['Black case', 'PK-BLACK', '10', '3', '20'],
      ['Blue case', 'PK-BLUE', '14', '5', '4'],
    ]) {
      await page.click('button:has-text("New product")');
      await page.waitForSelector('[role=dialog] >> text=Track each one by IMEI');
      const dialog = page.locator('[role=dialog]').last();
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      await dialog.getByRole('textbox', { name: 'SKU', exact: true }).fill(sku);
      await dialog.getByRole('spinbutton', { name: 'Price', exact: true }).fill(price);
      await dialog.getByRole('spinbutton', { name: 'Cost', exact: true }).fill(cost);
      await dialog.getByRole('spinbutton', { name: 'Stock on hand', exact: true }).fill(stock);
      await dialog.getByRole('button', { name: /^(Create product|Save changes)$/ }).click();
      await page.waitForSelector(`text=${name}`, { timeout: 15000 });
    }

    // The pack itself: no shelf of its own, made of the black case.
    await page.click('button:has-text("New product")');
    await page.waitForSelector('[role=dialog] >> text=Made of other products');
    const pack = page.locator('[role=dialog]').last();
    await pack.getByRole('textbox', { name: 'Name', exact: true }).fill('Case pack');
    await pack.getByRole('textbox', { name: 'SKU', exact: true }).fill('PK-PACK');
    await pack.getByRole('spinbutton', { name: 'Price', exact: true }).fill('12');
    // Typed, not scrolled — a real catalogue is far too long for a dropdown.
    await pack.getByRole('textbox', { name: 'Search for something to put in it' }).fill('Black');
    await page.waitForSelector('[role=dialog] button:has-text("Black case")', { timeout: 10000 });
    await pack.locator('button:has-text("Black case")').first().click();
    await page.waitForSelector('[role=dialog] >> text=/can be made up/', { timeout: 10000 });

    /*
     * What went in, said in words.
     *
     * The row carried a bare number box handed a width class that its own
     * wrapper overrode, so the box took the whole row and the product's name
     * was squeezed to nothing: a recipe that read "1" and no more.
     */
    await pack.locator('text=Black case').first().waitFor({ timeout: 10000 });
    await pack.locator('text=/PK-BLACK/').first().waitFor({ timeout: 10000 });
    await pack.locator('text=/20 in stock/').first().waitFor({ timeout: 10000 });

    // And how many of it go in one, without typing.
    const many = pack.getByRole('spinbutton', { name: 'How many Black case in one' });
    await pack.getByRole('button', { name: 'One more Black case' }).click();
    if ((await many.inputValue()) !== '2') {
      throw new Error(`the stepper left the quantity at ${await many.inputValue()}`);
    }
    await pack.getByRole('button', { name: 'One fewer Black case' }).click();
    if ((await many.inputValue()) !== '1') {
      throw new Error('the stepper would not come back down');
    }
    await pack.getByRole('button', { name: /^(Create product|Save changes)$/ }).click();
    await page.waitForSelector('text=Case pack', { timeout: 15000 });
  });

  await step('the pack goes on the sale saying what is in it', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });

    await page.click(scanBox);
    await page.fill(scanBox, 'Case pack');
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^Case pack/ }).first().click();

    await page.waitForSelector('aside >> text=Case pack', { timeout: 15000 });
    // What the cashier has to put in the bag, under the line.
    await page.waitForSelector('aside >> text=Black case', { timeout: 10000 });
  });

  await step('and the black case is swapped for the blue one', async () => {
    await page.click('aside button:has-text("Swap something")');
    await page.waitForSelector('[role=dialog] >> text=What goes in Case pack', { timeout: 15000 });

    const editor = page.locator('[role=dialog]').last();
    await editor.getByRole('button', { name: 'Take Black case out' }).click();
    await editor.getByRole('textbox', { name: /Search for something to put in the pack/ }).fill('Blue');
    await page.waitForSelector('[role=dialog] button:has-text("Blue case")', { timeout: 10000 });
    await editor.locator('button:has-text("Blue case")').first().click();
    await editor.getByRole('button', { name: 'Put it in the bag' }).click();

    // The line now says what is really going in it, and says it was changed.
    await page.waitForSelector('aside >> text=Blue case', { timeout: 15000 });
    await page.waitForSelector('aside >> text=Changed — edit again', { timeout: 10000 });
    if (await page.locator('aside >> text=Black case').count()) {
      throw new Error('the line is still promising the black case');
    }
  });
  await shot('pack-swapped');

  await step('selling it takes the blue one off the shelf and leaves the black alone', async () => {
    await page.click('aside button:has-text("Charge $")');
    await page.click('[role=dialog] button:has-text("Card")');
    await page.click('[role=dialog] button:has-text("Confirm $")');
    await page.waitForSelector('text=Payment complete', { timeout: 20000 });
    await page.click('button:has-text("New sale")');

    /*
     * Asked of the catalogue rather than read off the table.
     *
     * This one number is the whole feature — everything else is arranging it on
     * a screen — so it is worth being exact about. Scraping the row would have
     * matched a black case whose *cost* is 3 against a blue case whose stock is
     * 3, and passed for the wrong reason.
     */
    const shelves = await page.evaluate(async () => {
      const token = localStorage.getItem('pos_token') || sessionStorage.getItem('pos_token');
      const res = await fetch('/api/products', { headers: { Authorization: `Bearer ${token}` } });
      const { products } = await res.json();
      const of = (sku) => products.find((p) => p.sku === sku)?.stock;
      return { blue: of('PK-BLUE'), black: of('PK-BLACK') };
    });

    // Four blue became three; twenty black stayed twenty.
    if (shelves.blue !== 3) throw new Error(`the blue case did not come off the shelf: ${shelves.blue}`);
    if (shelves.black !== 20) throw new Error(`the black case moved when it should not have: ${shelves.black}`);
  });

  console.log('\nA repair, its money, and the people who work here');

  /*
   * The shape the shop actually works in: paid at the counter on the way in,
   * worked on for the rest of the week. Until now that could only be recorded
   * by marking the job collected, which said the phone had gone home while it
   * was sitting on the bench — and froze it there, because a collected ticket
   * could not be moved again.
   */
  await step('a phone is taken in on a customer from the list', async () => {
    await page.goto(`${BASE_URL}/admin/repairs`, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Take a device in")');
    await page.waitForSelector('[role=dialog] >> text=Take a device in', { timeout: 15000 });

    const dialog = page.locator('[role=dialog]').last();
    // Typing into the one customer field brings the list up; picking off it is
    // what joins the ticket to an account rather than to a string.
    await dialog.locator('#repair-customer').fill('Rami');
    await page.waitForSelector('[role=dialog] li button:has-text("Rami Haddad")', { timeout: 10000 });
    await dialog.locator('li button:has-text("Rami Haddad")').first().click();
    await page.waitForSelector('[role=dialog] >> text=/On Rami Haddad.*account/', { timeout: 10000 });

    await dialog.getByRole('textbox', { name: 'Device' }).fill('iPhone 11');
    await dialog.locator('#fault').fill('Charging port');
    await dialog.getByRole('spinbutton', { name: 'Quoted' }).fill('45');
    await dialog.getByRole('button', { name: 'Open ticket' }).click();

    // Opens straight onto the ticket it just made.
    await page.waitForSelector('[role=dialog] >> text=Charging port', { timeout: 15000 });
  });

  await step('the money is taken while the phone stays on the bench', async () => {
    const ticket = page.locator('[role=dialog]').last();
    await ticket.getByRole('spinbutton', { name: 'Take money now' }).fill('45');
    await ticket.getByRole('button', { name: 'Take it' }).click();

    await page.waitForSelector('[role=dialog] >> text=Paid so far $45.00', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=nothing left to pay', { timeout: 10000 });
    // Paid, and still exactly where it was.
    await page.waitForSelector('[role=dialog] >> text=Where it is up to', { timeout: 10000 });
  });

  await step('and the job carries on moving afterwards', async () => {
    const ticket = page.locator('[role=dialog]').last();
    await ticket.getByRole('button', { name: 'In repair', exact: true }).click();
    await page.waitForSelector('[role=dialog] >> text=Paid so far $45.00', { timeout: 15000 });
    await ticket.getByRole('button', { name: 'Ready', exact: true }).click();
    await page.waitForSelector('[role=dialog] >> text=Paid so far $45.00', { timeout: 15000 });
  });

  await step('handing it back charges nothing more, and it can still be reopened', async () => {
    const ticket = page.locator('[role=dialog]').last();
    await ticket.getByRole('button', { name: 'Hand it back' }).click();
    await page.waitForSelector('[role=dialog] >> text=Put it back on the bench', { timeout: 15000 });

    // The phone comes back through the door on Friday.
    await ticket.getByRole('button', { name: 'In repair', exact: true }).click();
    await page.waitForSelector('[role=dialog] >> text=Where it is up to', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('the repair shows on the customer’s own account', async () => {
    await page.goto(`${BASE_URL}/admin/customers`, { waitUntil: 'networkidle' });
    await page.click('td:has-text("Rami Haddad")');
    await page.waitForSelector('[role=dialog] >> text=Sales, invoices, quotations and repairs', {
      timeout: 15000,
    });
    await page.waitForSelector('[role=dialog] >> text=REP-', { timeout: 10000 });
  });

  await step('and the account prints as a statement that adds up', async () => {
    await page.click('[role=dialog] button:has-text("Statement")');
    await page.waitForSelector('[role=dialog] >> text=Statement of account', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=Balance brought forward', { timeout: 10000 });
    await page.waitForSelector('[role=dialog] >> text=Totals for the period', { timeout: 10000 });

    /*
     * A4, and exactly one live @page rule. Two of them is how a receipt asked
     * for A4 and came out on the roll, so it is counted rather than trusted.
     */
    const pages = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((sheet) => {
          try {
            return [...sheet.cssRules];
          } catch {
            return [];
          }
        })
        .filter((rule) => rule.constructor.name === 'CSSPageRule')
        .map((rule) => rule.cssText),
    );
    if (pages.length !== 1) throw new Error(`expected one @page rule, found ${pages.length}`);
    // Chromium serialises the size lower-case, so the check is too.
    if (!/a4/i.test(pages[0])) throw new Error(`statement did not claim A4: ${pages[0]}`);
  });
  await shot('customer-statement');

  await step('and closing it puts the paper back on the roll', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const rule = await page.evaluate(() => document.getElementById('pos-page-size')?.textContent || '');
    if (!/72mm/.test(rule)) throw new Error(`paper did not go back to the roll: ${rule}`);
    await page.keyboard.press('Escape');
  });

  /*
   * Wages. An employee is a customer account with a salary attached, which is
   * the whole design — so what is checked here is that the arithmetic comes out
   * of the ledger rather than out of a second set of rules nobody maintains.
   */
  await step('somebody is hired, and gets an account of their own', async () => {
    await page.goto(`${BASE_URL}/admin/employees`, { waitUntil: 'networkidle' });
    await page.click('button:has-text("Add an employee")');
    await page.waitForSelector('[role=dialog] >> text=Add an employee', { timeout: 15000 });

    const dialog = page.locator('[role=dialog]').last();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Karim Saad');
    await dialog.getByRole('textbox', { name: 'Job' }).fill('Technician');
    await dialog.getByRole('spinbutton', { name: 'Monthly salary' }).fill('500');
    await dialog.getByRole('button', { name: 'Add them' }).click();

    await page.waitForSelector('td:has-text("Karim Saad")', { timeout: 15000 });
    await page.waitForSelector('text=settled', { timeout: 10000 });
  });

  await step('a month puts the wage on their account, owed to them', async () => {
    await page.click('tr:has-text("Karim Saad") td:first-child');
    await page.waitForSelector('[role=dialog] >> text=Where they stand', { timeout: 15000 });

    const card = page.locator('[role=dialog]').last();
    await card.getByRole('button', { name: 'Run it' }).click();
    await page.waitForSelector('[role=dialog] >> text=the shop owes them', { timeout: 15000 });
    await page.waitForSelector('[role=dialog] >> text=$500.00', { timeout: 10000 });
  });

  await step('running the same month again is refused rather than paid twice', async () => {
    const card = page.locator('[role=dialog]').last();
    await card.getByRole('button', { name: 'Run it' }).click();
    await page.waitForSelector('text=/has already been run/i', { timeout: 15000 });
    await page.keyboard.press('Escape');
  });

  await step('paying them clears it, with a numbered voucher', async () => {
    await page.click('tr:has-text("Karim Saad") button:has-text("Pay")');
    await page.waitForSelector('[role=dialog] >> text=Pay Karim Saad', { timeout: 15000 });
    // The amount is already what is owed — the common case typed for them.
    await page.waitForSelector('[role=dialog] >> text=$500.00 is owed to them', { timeout: 10000 });
    await page.locator('[role=dialog]').last().getByRole('button', { name: 'Pay it' }).click();

    await page.waitForSelector('text=/PV-\\d+/', { timeout: 15000 });
    await page.waitForSelector('tr:has-text("Karim Saad") >> text=settled', { timeout: 15000 });
  });
  await shot('employees');

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

    /*
     * Nor the tab strip. This run has been round most of the app by now, so
     * there are plenty of open pages for it to list — and the counter is the
     * one screen that must not offer a row of other places to be.
     */
    if (await page.locator('nav[aria-label="Open pages"]:visible').count()) {
      throw new Error('the tab strip is on the register');
    }
  });

  await step('and it comes back for whoever wants it, and stays back', async () => {
    /*
     * Anchored on a group heading rather than on a screen inside one: the rail
     * opens one group at a time now, so which screens are showing depends on
     * where you have been. The headings are always there, which is the
     * question this step is actually asking — is the rail up.
     */
    await page.click('button[aria-label="Show the menu"]');
    await page.waitForSelector('aside button:has-text("Money")', { timeout: 10000 });

    // Remembered, or it is a setting that has to be set once per sale.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('aside button:has-text("Money")', { timeout: 10000 });

    await page.click('button[aria-label="Hide the menu"]');
    await page.waitForSelector('a[href="/menu"]:visible', { timeout: 10000 });
  });

  await step('every screen is one press away, at a size a finger can hit', async () => {
    await openMenu();
    await page.waitForSelector('main a[title="Trade-ins"]', { timeout: 15000 });

    // A tile on the page, not the rail's link with the same name — this is the
    // menu built for a touch screen, and its size is the point of it.
    const tile = await page.locator('main a[title="Products"]').first().boundingBox();
    if (!tile || tile.height < 120) {
      throw new Error(`the menu tiles are ${tile ? tile.height : 0}px tall, which is not a target`);
    }
    await page.locator('main a[title="Products"]').first().click();
    await page.waitForSelector('text=Braided USB-C cable', { timeout: 15000 });
  });
  await shot('menu-page');

  /*
   * The width a shop's laptop actually is, which is neither of the two this
   * suite used to check.
   *
   * Reported with a screenshot: the vouchers table clipped off the left edge
   * with no way to scroll back to it. A flex column will not shrink below its
   * own content unless told it may, so it refused to give way and the page
   * carried the difference — invisible at 1440, gone by 390 where the layout
   * drops to one column, and broken at every width in between.
   */
  await step('the money screens fit a laptop, not only a desk monitor', async () => {
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 860 });
      for (const path of ['/vouchers', '/transfers']) {
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 2) {
          throw new Error(`${path} is ${overflow}px wider than a ${width}px screen`);
        }
      }
    }
  });

  /*
   * The window a shop actually runs the app in.
   *
   * Reported from a live shop: at anything under a thousand pixels the app was
   * the handset layout — a bottom tab bar, no rail, no open pages, and the tile
   * menu built for a finger — on a desktop machine with a keyboard and a mouse.
   *
   * The cause was one word. The shell switched on `lg`, which is 1024px, and
   * `lg` means "a third column fits now" rather than "this is a desk". They had
   * been the same question only for as long as nobody ran the app in a window.
   * It now switches on its own breakpoint at 768px — see --breakpoint-desk.
   */
  await step('a desktop window under a thousand pixels is a desk, not a handset', async () => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Braided USB-C cable', { timeout: 15000 });

    // The rail, which is the whole of what "desktop layout" means here.
    if (!(await page.locator('aside:visible').count())) {
      throw new Error('the menu rail is missing at 900px — this is the handset layout');
    }
    // And the open pages, which a phone never shows.
    if (!(await page.locator('nav[aria-label="Open pages"]:visible').count())) {
      throw new Error('the open-pages strip is missing at 900px');
    }

    /*
     * And it has to be worth having. The rail starts out of the way in a window
     * this size — 244px of a 900px screen is the products table's price column
     * — so the table must still fit without the page scrolling sideways.
     */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 2) {
      throw new Error(`the products page is ${overflow}px wider than a 900px window`);
    }
  });

  await step('and a real handset still is one', async () => {
    // The other side of the same line: moving it must not have taken the phone
    // layout away from a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    if (await page.locator('aside:visible').count()) {
      throw new Error('the desktop rail is showing on a 390px phone');
    }
  });

  /*
   * Something the shop does, sold at the counter.
   *
   * A service has no shelf, and three separate places had to agree about that
   * before one could be sold: the server, the tile, and the cart's own count.
   * Two of them did. The server allowed it and the tile was no longer greyed
   * out at zero — and the cart quietly capped the line against a stock of
   * nothing, so the first press added the fitting and the second took it
   * straight back off with "Only 0 of Screen fitting in stock".
   *
   * Not something the API tests could catch: they post a finished order and
   * never touch the cart. So it is checked here, through the counter, twice —
   * because it is the second press that used to fail.
   */
  /*
   * Two ways of looking at the same shelf.
   *
   * Cards suit a counter selling forty things somebody recognises by sight;
   * rows suit two thousand accessories known by name and price. The windowing
   * underneath measures a tile once and reuses the height, and the switch is
   * where that goes wrong — a window still working from the card's height pads
   * every row by a card, and the shelf becomes a screen of rows with pages of
   * nothing under them.
   *
   * Checked as a ratio, not as "the list is shorter". A list is one column and
   * a card grid is five across, so per product the list is in fact a little
   * *taller* — about 1.2 times, and 5 times if the height was never
   * re-measured. Anything under 2 can only be a shelf that measured its own
   * rows.
   */
  await step('the shelf can be cards or a list, and the list is a list', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.waitForTimeout(600);

    const shelfHeight = () =>
      page.evaluate(() => Math.round(document.querySelector('section div.overflow-y-auto').scrollHeight));
    const asCards = await shelfHeight();

    await page.click('button[aria-label*="as a list"]');
    await page.waitForTimeout(700);
    const asRows = await shelfHeight();

    if (asRows > asCards * 2) {
      throw new Error(
        `the list is ${(asRows / asCards).toFixed(1)}x the height of the cards ` +
          `(${asRows} vs ${asCards}) — the window is still padding rows by a card`,
      );
    }

    // Remembered, or it is a setting to be set again on every sale.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.waitForTimeout(600);
    if (!(await page.locator('button[aria-label*="as cards"]').count())) {
      throw new Error('the shelf went back to cards on reload');
    }
    await page.click('button[aria-label*="as cards"]');
    await page.waitForTimeout(500);
  });

  /*
   * A stray click outside a dialog must not throw the work away.
   *
   * At a counter that click is a customer leaning over, a sleeve on a
   * touchscreen, a tap aimed at a field near the edge — and what it used to
   * cost was a half-filled repair intake or a customer being created, gone
   * with no warning and no way back.
   */
  await step('clicking beside a dialog keeps what is half-typed in it', async () => {
    await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
    await page.waitForSelector('button:has-text("New product")', { timeout: 20000 });
    await page.click('button:has-text("New product")');

    const firstBox = page.locator('[role=dialog] input').first();
    await firstBox.waitFor({ timeout: 10000 });
    await firstBox.fill('Half typed thing');

    await page.mouse.click(20, 400); // squarely on the backdrop
    await page.waitForTimeout(400);

    if (!(await page.locator('[role=dialog]').count())) {
      throw new Error('the dialog closed on a click outside it, and took the typing with it');
    }
    if ((await firstBox.inputValue()) !== 'Half typed thing') {
      throw new Error('the dialog stayed but the typing did not');
    }

    // Escape is a thing somebody meant to do, and still closes it.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    if (await page.locator('[role=dialog]').count()) {
      throw new Error('Escape no longer closes a dialog');
    }
  });

  await step('a service sells at the counter, and never runs out', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(async () => {
      const auth = {
        Authorization: `Bearer ${localStorage.getItem('pos_token')}`,
        'Content-Type': 'application/json',
      };
      await fetch('/api/products', {
        method: 'POST',
        headers: auth,
        // A quantity is sent on purpose: typing one into a service must not
        // give it a shelf.
        body: JSON.stringify({
          name: 'Screen fitting', sku: 'SVC-FIT', price: 5, cost: 0, stock: 40, is_service: true,
        }),
      });
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
    await page.fill('input[placeholder*="Scan"]', 'Screen fitting');
    await page.waitForTimeout(500);

    const tile = page.locator('div.grid > button').first();
    if (await tile.isDisabled()) throw new Error('the service tile is greyed out — it has no shelf to be out of');
    if (!/service/i.test(await tile.innerText())) {
      throw new Error(`the tile should say what it is: ${await tile.innerText()}`);
    }

    await tile.click();
    await tile.click();

    const line = page.locator('aside:has-text("Current sale")');
    await line.locator('text=Screen fitting').first().waitFor({ timeout: 10000 });
    if (!/2 items/.test(await line.innerText())) {
      throw new Error(`the second one came off again: ${await line.innerText()}`);
    }

    await page.click('aside button:has-text("Clear")');
  });

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

  /*
   * Reported from a phone: the header drawing on top of itself.
   *
   * The bar carries the menu, the branch, the drawer and the way out, and on a
   * handset they wanted more room than there is. Nothing overflowed the page —
   * the last two simply overlapped, so the till figure sat across the name and
   * the log-out button, and pressing one of them was a guess.
   */
  await step('and the top bar lays its own things out, not on top of each other', async () => {
    const drawer = page
      .locator('button[aria-label$="the drawer detail"], button:has-text("Cashbox closed")')
      .first();
    await drawer.waitFor({ timeout: 10000 });
    const chip = await drawer.boundingBox();
    const out = await page.locator('button[aria-label="Log out"]').first().boundingBox();

    if (!chip || !out) throw new Error('the header is missing the drawer or the way out');
    if (chip.x + chip.width > out.x + 1) {
      throw new Error(
        `the drawer chip runs to ${Math.round(chip.x + chip.width)} and log out starts at ${Math.round(out.x)}`,
      );
    }
  });

  /*
   * The back office on a phone, which is where the owner actually reads it —
   * standing in the shop, not at the desk. Its tiles were laid out four across
   * whatever the screen, so on a handset each one was seventy pixels wide with
   * a dollar figure spilling over the one beside it.
   */
  await step('and the back office reads on a phone, with nothing on top of anything', async () => {
    for (const path of ['/admin', '/admin/products', '/admin/customers', '/transfers']) {
      await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 2) throw new Error(`${path} is ${overflow}px wider than the phone`);
    }

    // Every tile in a row keeps to its own column.
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Revenue', { timeout: 15000 });
    const clash = await page.evaluate(() => {
      for (const grid of document.querySelectorAll('[class*="grid-cols-"]')) {
        const boxes = [...grid.children].map((c) => c.getBoundingClientRect());
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i];
            const b = boxes[j];
            if (a.width === 0 || b.width === 0) continue;
            const over =
              a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
            if (over) return `${Math.round(a.left)},${Math.round(a.top)} overlaps ${Math.round(b.left)},${Math.round(b.top)}`;
          }
        }
      }
      return null;
    });
    if (clash) throw new Error(`two tiles are on top of each other: ${clash}`);
  });
  await shot('dashboard-phone');

  await step('and the menu on a phone is the page, not a rail', async () => {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Current sale', { timeout: 15000 });
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
    // A group heading: always in the rail, whichever group happens to be open.
    await page.waitForSelector('aside button:has-text("Money")', { timeout: 15000 });
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

  /*
   * Changing your own password, through the form a shopkeeper actually uses.
   *
   * Reported three times from a live shop and never reproduced, because every
   * layer between the button and the database was a suspect and none of them
   * could be ruled out from a screenshot. This drives the real panel in a real
   * browser against a real server, so "the form works" stops being an opinion.
   *
   * The whole round trip, in the order it matters: the panel refuses the wrong
   * current password *in place* rather than throwing the person back to the
   * sign-in screen; it accepts the right one; the session it hands back still
   * works; and the new password is the one that opens the account afterwards.
   */
  await step('a shopkeeper can change their own password from Settings', async () => {
    // Whoever the step before left signed in, this one is about the owner.
    await signOut();
    await signIn('admin');
    await goTo('Settings');

    const CHANGED = 'owner-changed-password';

    // The wrong current password: refused, with the reason, still on Settings.
    await page.fill('input[name=currentPassword]', 'not-the-right-one');
    await page.fill('input[name=newPassword]', CHANGED);
    await page.fill('input[name=newPasswordAgain]', CHANGED);
    await page.getByRole('button', { name: /set the new password/i }).click();

    await page.waitForSelector('[role=alert]', { timeout: 10000 });
    const refusal = await page.locator('[role=alert]').first().innerText();
    if (!/current password/i.test(refusal)) {
      throw new Error(`expected the panel to name the wrong current password, got: ${refusal}`);
    }
    if (page.url().includes('/login')) {
      throw new Error('a mistyped current password threw the person out to the sign-in screen');
    }

    // The right one: accepted, and the screen stays signed in.
    await page.fill('input[name=currentPassword]', REAL.admin);
    await page.fill('input[name=newPassword]', CHANGED);
    await page.fill('input[name=newPasswordAgain]', CHANGED);
    await page.getByRole('button', { name: /set the new password/i }).click();

    /*
     * It has to *say* it worked, and say nothing else.
     *
     * This step passed for three rounds while the shop was still being shown
     * "the server did not answer", because it only ever checked that the
     * password changed — which it always had. The failure was one line after
     * the work: `toast.success(...)` on a toast that is a plain function,
     * throwing inside the try and landing in the catch, which reported a
     * network error for a change that had already succeeded.
     *
     * So: the confirmation is present, and no error is.
     */
    await page.waitForSelector('text=Password changed', { timeout: 10000 });
    if (await page.locator('[role=alert]').count()) {
      const complaint = await page.locator('[role=alert]').first().innerText();
      throw new Error(`the password changed but the panel complained: ${complaint}`);
    }

    // The session it handed back has to keep working, or the change signs you
    // out of the screen you are standing at.
    await goTo('Products');
    await page.waitForSelector('main', { timeout: 10000 });
    if (page.url().includes('/login')) {
      throw new Error('changing the password signed this screen out');
    }

    // And the new password is the one that opens the account.
    await signOut();
    await page.fill('input[name=username]', 'admin');
    await page.fill('input[name=password]', CHANGED);
    await page.click('button[type=submit]');
    await page.waitForSelector('main', { timeout: 15000 });

    // Put it back, so the steps after this one still know the password.
    await goTo('Settings');
    await page.fill('input[name=currentPassword]', CHANGED);
    await page.fill('input[name=newPassword]', REAL.admin);
    await page.fill('input[name=newPasswordAgain]', REAL.admin);
    await page.getByRole('button', { name: /set the new password/i }).click();
    await page.waitForTimeout(500);
  });


  console.log('\nIn Arabic');

  /*
   * The switch is on the sign-in screen because somebody who needs Arabic
   * cannot read the English screen asking them to choose — so that is where
   * this starts, before any credentials are typed.
   */
  await step('on a phone the shop is a tab bar, and the cart is one press away', async () => {
    /*
     * The register at handset width, which is a different screen from the same
     * page at 1440 and has to be checked as one.
     *
     * The bug this exists for is not cosmetic. On a narrow screen the cart used
     * to be the *bottom half of one long scrolling page*, under the whole
     * product grid — so taking the money meant scrolling past nine hundred
     * products with a customer waiting. It is a sheet now, reached from a bar
     * that always shows the total, and both of those have to still be there.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

      // The rail is a desktop object and must be gone; the tab bar is what
      // replaces it, and it is the only way off this screen.
      const tabs = page.locator('nav[aria-label="Main"]');
      await tabs.waitFor({ timeout: 15000 });

      const box = await tabs.boundingBox();
      if (!box || box.height < 44) {
        throw new Error(`the tab bar is ${box?.height ?? 0}px tall — a thumb needs 44`);
      }
      if (Math.round(box.y + box.height) < 800) {
        throw new Error('the tab bar is not at the bottom of the screen');
      }

      /*
       * Five at most. Not an aesthetic rule: past five, the targets are
       * narrower than the pad of a finger and the shop starts opening the
       * wrong screen.
       */
      const count = await tabs.locator('a').count();
      if (count > 5) throw new Error(`${count} tabs — a thumb cannot aim that finely`);

      /*
       * Whatever is first on the shelf, rather than a product by name: this
       * step runs after others have created, renamed and sold things, and a
       * name pinned here is a step that breaks when the catalogue changes.
       *
       * It had a name pinned here anyway, and the shelf being windowed is what
       * finally caught it — only the tiles in view are in the page now, so a
       * product far enough down the list is not there to be clicked until
       * somebody scrolls or searches for it, which is the whole point of the
       * windowing. Nothing about this step needs a particular product; it needs
       * a tile. The step next door, which searches before it clicks, is the
       * pattern for when a *named* product is the thing being tested.
       */
      await page.locator('div.grid > button').first().click();
      const saleBar = page.locator('button:has-text("item")').last();
      await saleBar.waitFor({ timeout: 10000 });

      // It sits above the tab bar rather than under it — two fixed things at
      // the same offset is one covering the other.
      const barBox = await saleBar.boundingBox();
      if (barBox && box && barBox.y + barBox.height > box.y + 2) {
        throw new Error('the sale bar is underneath the tab bar');
      }

      // And it opens the cart, with the way to take the money in it.
      await saleBar.click();
      await page.waitForSelector('button:has-text("Charge")', { timeout: 10000 });

      /*
       * The whole point of the sheet: the charge button has to be *on screen*,
       * not somewhere below the fold at the end of a page of products.
       */
      const charge = await page.locator('button:has-text("Charge")').first().boundingBox();
      if (!charge || charge.y > 844) {
        throw new Error('the charge button is off the bottom of a phone screen');
      }

      // Leave the cart as it was found, so later steps are not surprised. The
      // sheet is already open, so Clear is on screen.
      await page.click('aside button:has-text("Clear")');
      await page.waitForSelector('text=No items yet', { timeout: 10000 });
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  await step('a table on a phone is cards, with nothing to drag sideways', async () => {
    /*
     * The complaint this exists for, in the shop's own words: having to swipe
     * left and right to see a whole row.
     *
     * A table needs width, and this app has thirty of them — the catalogue is
     * eleven columns. On a 390-pixel screen the only two outcomes are a row
     * squeezed past reading, or a sideways scroll, which means dragging right
     * to see what a thing costs and back again to remember which thing it was.
     *
     * So below `sm` each row becomes a card and each cell a "label — value"
     * line, with the heading copied onto the cell by TableCards.jsx. What is
     * checked here is the thing that was actually wrong: that nothing on the
     * screen scrolls sideways.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
      await page.waitForSelector('table.cards', { timeout: 20000 });

      const measured = await page.evaluate(() => {
        const table = document.querySelector('table.cards');
        const row = table?.querySelector('tbody tr');
        const cell = row?.querySelector('td:nth-child(2)');
        const doc = document.documentElement;
        return {
          tableOverflow: table ? table.scrollWidth - table.clientWidth : -1,
          docOverflow: doc.scrollWidth - doc.clientWidth,
          // The heading has to have travelled onto the cell — without it the
          // card is a column of numbers with nothing saying what they are.
          label: cell?.getAttribute('data-label') ?? null,
          // A card is taller than it is wide once it is stacked.
          rowStacked: row ? row.getBoundingClientRect().height > 60 : false,
        };
      });

      if (measured.tableOverflow > 0) {
        throw new Error(`the table still scrolls ${measured.tableOverflow}px sideways`);
      }
      if (measured.docOverflow > 0) {
        throw new Error(`the page still scrolls ${measured.docOverflow}px sideways`);
      }
      if (!measured.label) {
        throw new Error('a cell has no column heading on it, so the card is unlabelled');
      }
      if (!measured.rowStacked) {
        throw new Error('the row is still laid out as a row, not a card');
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  await step('and back at a desk it is a table again', async () => {
    /*
     * The counter monitor must not pay for the phone. A table is the right
     * shape when there is width for one, and the cards are a `@media` rule
     * rather than a different render, so this is checking the rule's ceiling.
     */
    await page.goto(`${BASE_URL}/admin/products`, { waitUntil: 'networkidle' });
    const row = await page.locator('table tbody tr').first().boundingBox();
    if (!row) throw new Error('the catalogue has no rows at desk width');
    if (row.height > 90) {
      throw new Error(`a desk row is ${row.height}px tall — it is still stacked as a card`);
    }
  });

  await step('the phone menu is a list, not a wall of tiles', async () => {
    /*
     * Thirty screens as 140-pixel tiles is fifteen rows of scrolling to reach
     * Settings. The same list as rows is six at a time in the space one tile
     * used, which is what every phone app does with a long list of places.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.goto(`${BASE_URL}/menu`, { waitUntil: 'networkidle' });
      const register = page.locator('a[href="/"]:visible').first();
      await register.waitFor({ timeout: 15000 });

      const row = await register.boundingBox();
      if (!row) throw new Error('the menu has no rows on a phone');
      if (row.height < 44) {
        throw new Error(`a menu row is ${row.height}px — a thumb needs 44`);
      }
      if (row.height > 96) {
        throw new Error(`a menu row is ${row.height}px — that is still a tile`);
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

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
