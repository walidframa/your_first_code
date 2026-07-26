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

async function waitFor(url, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

const env = {
  ...process.env,
  DB_PATH: path.join(workDir, 'e2e.sqlite'),
  JWT_SECRET: 'e2e-secret-long-enough-to-satisfy-the-production-guard',
  PORT: String(API_PORT),
  NODE_ENV: 'test',
  // Points the client's dev/preview proxy at this run's API instance.
  API_TARGET: `http://127.0.0.1:${API_PORT}`,
};

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

console.log('Starting API…');
track(
  spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(repoRoot, 'server'),
    env,
    stdio: 'inherit',
  }),
  'API',
);
await waitFor(`http://127.0.0.1:${API_PORT}/api/health`, 'API');

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

track(
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
await waitFor(`http://127.0.0.1:${WEB_PORT}/`, 'client');

console.log('Running smoke test…');
const smoke = spawnSync(process.execPath, ['e2e/smoke.mjs'], {
  cwd: repoRoot,
  env: { ...env, E2E_BASE_URL: `http://127.0.0.1:${WEB_PORT}` },
  stdio: 'inherit',
});

process.exit(smoke.status ?? 1);
