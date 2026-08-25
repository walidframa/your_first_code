/** A sale rung up at the register, and the books afterwards. */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = '/home/user/your_first_code';
const API = 4715;
const WEB = 4716;
const work = mkdtempSync(path.join(tmpdir(), 'v8-'));
const kids = [];
const clean = () => {
  for (const k of kids) { try { process.kill(-k.pid, 'SIGKILL'); } catch { /* gone */ } }
  rmSync(work, { recursive: true, force: true });
};
process.on('exit', clean);

const env = { ...process.env, DB_PATH: path.join(work, 'v.sqlite'),
  JWT_SECRET: 'v8-secret-long-enough-to-pass-the-guard', PORT: String(API), NODE_ENV: 'test' };
const seed = spawnSync(process.execPath, ['src/seed.js'], { cwd: path.join(ROOT, 'server'), env, encoding: 'utf8' });
if (seed.status !== 0) { console.error(seed.stderr); process.exit(1); }
kids.push(spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env, stdio: 'ignore', detached: true }));

async function up(url) {
  for (let i = 0; i < 160; i += 1) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`never came up: ${url}`);
}
await up(`http://127.0.0.1:${API}/api/health`);

const clientEnv = { ...env, API_TARGET: `http://127.0.0.1:${API}` };
spawnSync('npm', ['run', 'build'], { cwd: path.join(ROOT, 'client'), stdio: 'ignore', env: { ...clientEnv, NODE_ENV: 'production' } });
kids.push(spawn('npx', ['vite', 'preview', '--port', String(WEB), '--strictPort', '--host', '127.0.0.1'],
  { cwd: path.join(ROOT, 'client'), stdio: 'ignore', env: clientEnv, detached: true }));
await up(`http://127.0.0.1:${WEB}/`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `/tmp/claude-0/-home-user-your-first-code/09f16ef9-192e-5591-8aed-452b5becae1e/scratchpad/${n}.png` });
const ok = (l, c) => console.log(`${c ? '  ok  ' : '  FAIL '} ${l}`);

await page.goto(`http://127.0.0.1:${WEB}/login`, { waitUntil: 'networkidle' });
await page.waitForSelector('input[name=username]', { timeout: 20000 });
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('button[type=submit]');
const gate = page.locator('input[name=currentPassword]');
await Promise.race([
  gate.waitFor({ timeout: 20000 }).catch(() => {}),
  page.locator('input[name=username]').waitFor({ state: 'detached', timeout: 20000 }),
]);
if (await gate.count()) {
  await page.fill('input[name=currentPassword]', 'admin123');
  await page.fill('input[name=newPassword]', 'owner-real-password');
  await page.fill('input[name=newPasswordAgain]', 'owner-real-password');
  await page.click('button[type=submit]');
  await gate.waitFor({ state: 'detached', timeout: 20000 });
}
await page.waitForTimeout(1500);

console.log('\n== the books before trading ==');
await page.goto(`http://127.0.0.1:${WEB}/admin/trial-balance`);
await page.waitForTimeout(2500);
const empty = await page.locator('main').innerText();
ok('nothing posted yet', /Nothing posted yet/.test(empty));

console.log('\n== ring up a sale at the register ==');
await page.goto(`http://127.0.0.1:${WEB}/`);
await page.waitForTimeout(2500);
await page.locator('button:visible', { hasText: /cashbox/i }).first().click();
await page.waitForTimeout(800);
await page.getByLabel('Dollars').first().fill('100');
await page.getByRole('button', { name: /open cashbox/i }).click();
await page.waitForTimeout(1500);

await page.getByPlaceholder(/search|scan/i).first().fill('Espresso');
await page.waitForTimeout(800);
await page.locator('button', { hasText: 'Espresso' }).first().click();
await page.waitForTimeout(700);
await page.getByRole('button', { name: /Charge \$/ }).click();
await page.waitForTimeout(1200);
const sheet = page.locator('[role="dialog"]').last();
await sheet.getByRole('button', { name: /^Cash$/ }).click();
await page.waitForTimeout(900);
await sheet.getByRole('button', { name: '$5.00' }).click();
await page.waitForTimeout(600);
await sheet.locator('button:visible').last().click();
await page.waitForTimeout(2500);
await shot('p1-sold');

console.log('\n== and the books afterwards ==');
await page.goto(`http://127.0.0.1:${WEB}/admin/trial-balance`);
await page.waitForTimeout(2500);
await shot('p2-books');
const tb = await page.locator('main').innerText();
console.log('  ' + tb.split('\n').filter(Boolean).slice(0, 18).join('\n  '));
ok('the sale wrote itself into the books', !/Nothing posted yet/.test(tb));
ok('and they balance', /The books balance/.test(tb));
ok('sales has the takings', /Sales/.test(tb));
ok('cost of goods sold is there too', /Cost of goods sold/.test(tb));
ok('nothing landed in Suspense', !/Suspense/.test(tb));

await page.goto(`http://127.0.0.1:${WEB}/admin/journal`);
await page.waitForTimeout(2000);
await shot('p3-journal');
const journal = await page.locator('table').first().innerText();
ok('and the journal names the sale', /Sale ORD-/.test(journal));

await browser.close();
console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('  ' + e);
