/**
 * Photograph the dark theme on a shop with things in it.
 *
 * A palette swap can pass every automated check and still be unreadable — grey
 * text on a grey panel is valid CSS. The only way to know is to look, so this
 * signs in, turns the theme on the way a shopkeeper would, and captures the
 * screens that carry the most colour: the register, a table, the money-coloured
 * Profit page, a dialog and the settings screen it was switched from.
 *
 * Run with: E2E_SCRIPT=e2e/dark-shots.mjs npm run e2e
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const OUT = process.env.DARK_SHOT_DIR || 'dark-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  captured ${name}`);
};

await page.goto(BASE_URL, { waitUntil: 'networkidle' });

/* Dark before signing in, so the sign-in screen is photographed too — it is
   the one screen every shopkeeper sees first, every morning. */
await page.evaluate(() => localStorage.setItem('pos_theme', 'dark'));
await page.reload({ waitUntil: 'networkidle' });
await shot('01-signin');

await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('button[type=submit]');
await page.waitForTimeout(1500);

// The seeded account is made to set a real password on first use.
if (await page.locator('input[name=currentPassword]').count()) {
  await page.fill('input[name=currentPassword]', 'admin123');
  await page.fill('input[name=newPassword]', 'owner-real-password');
  await page.fill('input[name=newPasswordAgain]', 'owner-real-password');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1500);
}

await page.waitForSelector('text=Current sale', { timeout: 20000 });
await shot('02-register');

// A cart with something in it: the row, the running total, the pay button.
const search = page.locator('input[placeholder*="barcode" i], input[placeholder*="Scan" i]').first();
if (await search.count()) {
  await search.fill('Espresso');
  await page.waitForTimeout(900);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
}
await shot('03-register-cart');

for (const [name, path_] of [
  ['04-menu', '/menu'],
  ['05-products', '/admin/products'],
  ['06-documents', '/admin/documents'],
  ['07-profit', '/admin/profit'],
  ['08-customers', '/admin/customers'],
  ['09-settings', '/admin/settings'],
]) {
  await page.goto(`${BASE_URL}${path_}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot(name);
}

// A dialog over a dark page — the backdrop and the raised surface together.
await page.goto(`${BASE_URL}/admin/documents`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const newDoc = page.locator('button:has-text("New document")').first();
if (await newDoc.count()) {
  await newDoc.click();
  await page.waitForTimeout(900);
  await shot('10-dialog');
}

await browser.close();
console.log(`\nWrote ${OUT}/`);
