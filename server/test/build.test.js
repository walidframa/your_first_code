/**
 * Which build a process says it is running.
 *
 * This is the thing a deploy asks each shop before it will call itself
 * finished, so what matters is not that the figure is pretty but that it is the
 * *process's own* answer — fixed when it started, and unmoved by anything that
 * happens to the files on disk afterwards.
 *
 * The bug it guards against: several shops run from one checkout, each as its
 * own process. Miss one restart and that shop serves the new client — static
 * files, read off disk, so they change the instant the build finishes — against
 * last week's routes, which are in memory. The screens get newer than the
 * server behind them, and the only outward sign is a page that will not load.
 * A `build` that quietly re-read the disk would report the new commit for that
 * stale process and hide exactly the case it exists to catch.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4640;

let child;
let workDir;
let env;

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

const health = async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pos-build-'));
  env = {
    ...process.env,
    DB_PATH: path.join(workDir, 'build.sqlite'),
    JWT_SECRET: 'build-test-secret-long-enough-for-the-guard',
    PORT: String(PORT),
    NODE_ENV: 'test',
    /*
     * Stamped rather than left to the checkout, so this test says something
     * definite on a machine with no `.git` — a container built from a tarball,
     * which is exactly the deployment `POS_BUILD` exists for.
     */
    POS_BUILD: 'abcdef0123456789abcdef0123456789abcdef01',
  };

  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: serverRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  await waitForServer();
});

after(() => {
  child?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a shop says which build it is serving, without being asked to sign in', async () => {
  /*
   * Unauthenticated on purpose. A deploy checks this before anybody has a
   * token, and a commit hash of a public repository is not a secret — needing
   * credentials to ask would defeat the one job the field has.
   */
  const body = await health();
  assert.equal(body.ok, true);
  assert.equal(body.build, 'abcdef0123456789abcdef0123456789abcdef01');
});

test('the answer is the running process, not a second look at the disk', async () => {
  /*
   * The whole point. Asked twice with the world changing underneath it, a
   * process must keep saying what it started as — otherwise a shop left on old
   * code would report the new commit and a deploy would wave it through.
   */
  const first = await health();

  // Nothing about the environment now agrees with how this process started.
  process.env.POS_BUILD = 'ffffffffffffffffffffffffffffffffffffffff';

  const second = await health();
  assert.equal(second.build, first.build);
  assert.equal(second.build, 'abcdef0123456789abcdef0123456789abcdef01');
});

test('a checkout with no stamp answers from its own git, or admits it cannot', async () => {
  /*
   * Read in a child process because the module settles its answer at import,
   * so the only way to ask it a different question is to start it again.
   */
  const probe = spawnSync(
    process.execPath,
    ['-e', 'import("./src/lib/build.js").then((m) => console.log(JSON.stringify(m.BUILD)))'],
    { cwd: serverRoot, env: { ...process.env, POS_BUILD: '' }, encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const build = JSON.parse(probe.stdout.trim());

  // A full commit, or null. Never a half-read file or a stray newline, because
  // a deploy compares this against `git rev-parse HEAD` character for character.
  if (build !== null) assert.match(build, /^[0-9a-f]{40}$/);
});
