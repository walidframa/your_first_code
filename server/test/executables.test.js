/**
 * Anything with a shebang is committed executable.
 *
 * `server/src/tenants.js` is symlinked into /usr/local/bin as `pos-tenant`, and
 * a symlink to a file without the bit fails as `command not found` — which
 * reads as "it was never installed" rather than as a file mode.
 *
 * The obvious repair is `chmod +x` on the server. That is also a trap: git
 * tracks the bit, so the fix shows up as a modified file and the *next* deploy
 * refuses to run, pointing at a source file nobody edited. The bit belongs in
 * the commit, once, where it survives every checkout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

const startsWithShebang = (file) => {
  if (/node_modules|\.(png|ico|sqlite|jpg)$/.test(file)) return false;
  try {
    return readFileSync(path.join(repoRoot, file), 'utf8').slice(0, 2) === '#!';
  } catch {
    return false;
  }
};

test('every file starting with #! is executable in git', () => {
  const wrong = [];
  let checked = 0;

  for (const line of git('ls-files', '-s').split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t');
    const mode = meta.split(' ')[0];
    // Symlinks and submodules have modes of their own and no contents to read.
    if (mode !== '100644' && mode !== '100755') continue;
    if (!startsWithShebang(file)) continue;

    checked += 1;
    if (mode !== '100755') wrong.push(`${file} is ${mode}`);
  }

  assert.deepEqual(wrong, [], `run: git update-index --chmod=+x <file>`);
  // A guard that finds nothing to check is a guard that has stopped working.
  assert.ok(checked >= 3, `only found ${checked} files with a shebang`);
});

test('a new file with a shebang is caught before it is committed', () => {
  /*
   * `git ls-files` lists what git already knows about, so a brand-new script is
   * invisible to the check above until the moment it is committed — which is
   * exactly one moment too late. This one wrote a new service, ran the tests,
   * saw them pass, committed, and learned about the missing bit from CI.
   *
   * So the working tree is checked too. The fix is the same either way; the
   * difference is finding out before the push rather than after it.
   */
  const untracked = git('ls-files', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean)
    .filter(startsWithShebang);

  const wrong = untracked.filter((file) => {
    // eslint-disable-next-line no-bitwise
    return (statSync(path.join(repoRoot, file)).mode & 0o111) === 0;
  });

  assert.deepEqual(
    wrong,
    [],
    'run: chmod +x <file> before adding it, or git will record it without the bit',
  );
});
