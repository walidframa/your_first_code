/**
 * The money screens at the widths a shop actually owns.
 *
 * The report was a table clipped off the left edge with no way to scroll back
 * to it — a flex column that would not shrink below its own content while a
 * fixed-width drawer panel held its ground beside it. Photographed at three
 * widths because the failure only appears between them: wide enough for both
 * columns is fine, and a phone drops to one column anyway.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const OUT = process.env.NARROW_SHOT_DIR || 'narrow-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('button[type=submit]');
await page.waitForTimeout(1500);
if (await page.locator('input[name=currentPassword]').count()) {
  await page.fill('input[name=currentPassword]', 'admin123');
  await page.fill('input[name=newPassword]', 'owner-real-password');
  await page.fill('input[name=newPasswordAgain]', 'owner-real-password');
  await page.click('button[type=submit]');
  await page.waitForTimeout(1500);
}

for (const [label, width] of [['1280', 1280], ['1024', 1024], ['900', 900]]) {
  await page.setViewportSize({ width, height: 860 });
  for (const [name, path_] of [['vouchers', '/vouchers'], ['transfers', '/transfers']]) {
    await page.goto(`${BASE_URL}${path_}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    /*
     * The actual question, asked of the document rather than of the picture:
     * is anything reachable only by scrolling the window sideways?
     */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    console.log(`  ${name} @ ${label}px — horizontal overflow: ${overflow}px`);
    if (overflow > 0) console.log(`    ^^ still running off the side`);

    await page.screenshot({ path: `${OUT}/${name}-${label}.png` });
  }
}

await browser.close();
console.log(`\nWrote ${OUT}/`);
