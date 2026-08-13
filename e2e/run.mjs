/**
 * Boots a throwaway API + preview client, runs the smoke test against them, and
 * always tears the processes down. Used by `npm run e2e` and by CI.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_PORT = 4610;
const WEB_PORT = 4611;

const workDir = mkdtempSync(path.join(tmpdir(), 'pos-e2e-'));
const children = [];
let shuttingDown = false;

function shutdown() {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  rmSync(workDir, { recursive: true, force: true });
}

process.on('exit', shutdown);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

/** Track a long-running service so a crash surfaces immediately, not as a timeout. */
function track(child, label) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`\n${label} exited unexpectedly (code ${code}, signal ${signal})`);
      process.exit(1);
    }
  });
  children.push(child);
  return child;
}

/**
 * Refuse to start when the port is already taken.
 *
 * Without this a server left over from an earlier run answers the readiness
 * check before the newly spawned one has finished failing, and the suite
 * quietly tests yesterday's build.
 */
async function requireFreePort(port, label) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return; // Nothing listening, which is what we want.
  }
  console.error(`Port ${port} is already serving something; stop it before running the ${label}.`);
  process.exit(1);
}

async function waitFor(url, label, child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // If the service died (e.g. its port was already taken), stop immediately —
    // otherwise a stale server left over from an earlier run can answer the
    // health check and the suite silently tests the wrong process.
    if (child && child.exitCode !== null) {
      throw new Error(`${label} exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

/*
 * A book of shops, with this run's shop in it, paid up for years.
 *
 * Without it the app runs as nobody's tenant, and two things that only exist
 * for tenants — the licence bar and the vendor's support visit — cannot be
 * reached by a browser at all. Dated far out on purpose: an expiry that crept
 * up on the calendar would one day lock the whole suite out of the register for
 * reasons having nothing to do with the change being tested.
 */
const controlPath = path.join(workDir, 'control.sqlite');
{
  const { DatabaseSync } = await import('node:sqlite');
  const { ensureControlSchema } = await import('../server/src/lib/control.js');
  const control = ensureControlSchema(new DatabaseSync(controlPath));
  control
    .prepare(
      `INSERT INTO tenants (slug, shop_name, plan, price, port, paid_through)
       VALUES ('e2e', 'End To End Mobile', 'monthly', 25, ?, '2099-01-01')`,
    )
    .run(API_PORT);
  control.close();
}

const env = {
  ...process.env,
  DB_PATH: path.join(workDir, 'e2e.sqlite'),
  JWT_SECRET: 'e2e-secret-long-enough-to-satisfy-the-production-guard',
  PORT: String(API_PORT),
  NODE_ENV: 'test',
  CONTROL_DB: controlPath,
  TENANT_SLUG: 'e2e',
  // The smoke test writes a ticket into the book the way the console would.
  E2E_CONTROL_DB: controlPath,
  // Points the client's dev/preview proxy at this run's API instance.
  API_TARGET: `http://127.0.0.1:${API_PORT}`,
};

await requireFreePort(API_PORT, 'API');
await requireFreePort(WEB_PORT, 'client');

console.log('Seeding a throwaway database…');
const seed = spawnSync('npm', ['--prefix', 'server', 'run', 'seed'], {
  cwd: repoRoot,
  env,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

/*
 * This suite's figures are an eight-per-cent shop's.
 *
 * Tax is the shop's own setting now and starts off, which is right for a new
 * shop and wrong for a fixture whose expected totals were all written with it
 * on. Set here rather than clicked through the settings screen, so the tax
 * arithmetic under test is not also testing the form that turns it on — there
 * is a step for that further down.
 */
{
  const { DatabaseSync } = await import('node:sqlite');
  const shop = new DatabaseSync(env.DB_PATH);
  const put = shop.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  put.run('tax_enabled', 'true');
  put.run('tax_percent', '8');
  shop.close();
}

console.log('Starting API…');
const api = track(
  spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(repoRoot, 'server'),
    env,
    stdio: 'inherit',
  }),
  'API',
);
await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, 'API', api);

console.log('Building and serving the client…');
const build = spawnSync('npm', ['--prefix', 'client', 'run', 'build'], {
  cwd: repoRoot,
  // Build as production so the smoke test exercises the same bundle users get,
  // rather than React's development build.
  env: { ...env, NODE_ENV: 'production' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) process.exit(1);

const web = track(
  spawn(
    'npm',
    [
      '--prefix', 'client', 'run', 'preview', '--',
      '--port', String(WEB_PORT),
      '--strictPort',
      // Bind IPv4 explicitly. Left to default, vite binds "localhost", which
      // resolves to ::1 on CI runners while we poll 127.0.0.1.
      '--host', '127.0.0.1',
    ],
    { cwd: repoRoot, env, stdio: 'inherit', shell: process.platform === 'win32' },
  ),
  'client',
);
await waitFor(`http://127.0.0.1:${WEB_PORT}/`, 'client', web);

console.log('Running smoke test…');
const smoke = spawnSync(process.execPath, ['e2e/smoke.mjs'], {
  cwd: repoRoot,
  env: { ...env, E2E_BASE_URL: `http://127.0.0.1:${WEB_PORT}` },
  stdio: 'inherit',
});

process.exit(smoke.status ?? 1);
