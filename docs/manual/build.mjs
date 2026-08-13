#!/usr/bin/env node
/**
 * Builds the customer manual and the training quick start, as PDFs.
 *
 *     npm run manual
 *
 * Boots a throwaway copy of the app with a phone shop in it, photographs every
 * screen in both languages with a real browser, lays the pictures into a
 * document and prints it. Four PDFs come out: a manual and a quick start, each
 * in English and Arabic.
 *
 * Nothing here touches a real shop. The database is made in a temporary
 * directory and deleted on the way out, and the ports are its own — so this can
 * run while the tests or a dev server are running.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MANUAL, QUICKSTART, BRAND } from './content.mjs';
import { render } from './render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(here));

// Its own ports, clear of the dev server (4000/5173) and the e2e run (4610/4611).
const API_PORT = 4620;
const WEB_PORT = 4621;

const OUT = path.join(here, 'out');
const SHOTS = path.join(here, 'shots');
const LANGUAGES = (process.env.MANUAL_LANGS || 'en,ar').split(',');

const workDir = mkdtempSync(path.join(tmpdir(), 'pos-manual-'));
const children = [];
let shuttingDown = false;

function shutdown() {
  shuttingDown = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  rmSync(workDir, { recursive: true, force: true });
}
process.on('exit', shutdown);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const step = (m) => console.log(`\n\x1b[1;36m==> ${m}\x1b[0m`);
const die = (m) => {
  console.error(`\n\x1b[1;31m!! ${m}\x1b[0m`);
  process.exit(1);
};

function track(child, label) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown) die(`${label} exited unexpectedly (code ${code}, signal ${signal})`);
  });
  children.push(child);
  return child;
}

/** Refuse rather than photograph whatever else is already on the port. */
async function requireFreePort(port, label) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return;
  }
  die(`Port ${port} is already serving something; stop it before building the manual (${label}).`);
}

async function waitFor(url, label, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      die(`${label} exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  die(`${label} did not become ready at ${url}`);
}

const env = {
  ...process.env,
  DB_PATH: path.join(workDir, 'manual.sqlite'),
  JWT_SECRET: 'manual-build-secret-long-enough-for-the-production-guard',
  ACCOUNT_SECRET: 'manual-build-account-secret-long-enough-for-the-guard',
  PORT: String(API_PORT),
  NODE_ENV: 'test',
  API_TARGET: `http://127.0.0.1:${API_PORT}`,
};

await requireFreePort(API_PORT, 'API');
await requireFreePort(WEB_PORT, 'client');

/* ------------------------------------------------------------- the shop */

step('Setting up a shop to photograph');
for (const [label, argv] of [
  ['seed', ['--prefix', 'server', 'run', 'seed']],
  [null, null],
]) {
  if (!argv) break;
  const res = spawnSync('npm', argv, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(res.stdout, res.stderr);
    die(`${label} failed`);
  }
}
{
  const res = spawnSync(process.execPath, [path.join(here, 'demo.mjs')], {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });
  if (res.status !== 0) die('the demo data could not be built');
}

/* ------------------------------------------------------------ the app */

step('Starting the app');
const api = track(
  spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(repoRoot, 'server'),
    env,
    stdio: 'ignore',
  }),
  'API',
);
await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, 'API', api);

const build = spawnSync('npm', ['--prefix', 'client', 'run', 'build'], {
  cwd: repoRoot,
  env: { ...env, NODE_ENV: 'production' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) die('the client would not build');

const web = track(
  spawn(
    'npm',
    [
      '--prefix', 'client', 'run', 'preview', '--',
      '--port', String(WEB_PORT),
      '--strictPort',
      '--host', '127.0.0.1',
    ],
    { cwd: repoRoot, env, stdio: 'ignore', shell: process.platform === 'win32' },
  ),
  'client',
);
await waitFor(`http://127.0.0.1:${WEB_PORT}/`, 'client', web);

/* ------------------------------------------------------- the photographs */

step('Photographing every screen');
rmSync(SHOTS, { recursive: true, force: true });
{
  const res = spawnSync(process.execPath, [path.join(here, 'capture.mjs')], {
    cwd: repoRoot,
    env: {
      ...env,
      MANUAL_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
      MANUAL_SHOTS: SHOTS,
      MANUAL_LANGS: LANGUAGES.join(','),
    },
    stdio: 'inherit',
  });
  if (res.status !== 0) die('the screenshots could not be taken');
}

/* --------------------------------------------------------------- the PDFs */

step('Printing');
mkdirSync(OUT, { recursive: true });
const css = readFileSync(path.join(here, 'manual.css'), 'utf8');

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const made = [];
for (const language of LANGUAGES) {
  for (const [doc, name, cover] of [
    [MANUAL, 'manual', 'full'],
    [QUICKSTART, 'quickstart', 'short'],
  ]) {
    const html = render({ doc, language, shotsDir: SHOTS, css, cover });
    const htmlFile = path.join(OUT, `${name}-${language}.html`);
    writeFileSync(htmlFile, html);

    const page = await browser.newPage();
    await page.goto(`file://${htmlFile}`, { waitUntil: 'load' });

    const pdf = path.join(OUT, `xtechpos-${name}-${language}.pdf`);
    await page.pdf({
      path: pdf,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      // Page numbers, and the product name so a printed page found on its own
      // still says what it belongs to.
      footerTemplate: `
        <div style="width:100%;font-size:8pt;color:#94a3b8;padding:0 16mm;
                    display:flex;justify-content:space-between;">
          <span>${BRAND.product} — ${doc.title[language] ?? doc.title.en}</span>
          <span class="pageNumber"></span>
        </div>`,
      margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' },
    });
    await page.close();

    made.push(pdf);
    console.log(`    ${path.relative(repoRoot, pdf)}`);
  }
}

await browser.close();

console.log(`\n\x1b[1;32m==> ${made.length} documents in docs/manual/out\x1b[0m\n`);
