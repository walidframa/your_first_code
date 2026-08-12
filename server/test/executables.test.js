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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('every file starting with #! is executable in git', () => {
  const listing = execFileSync('git', ['ls-files', '-s'], { cwd: repoRoot, encoding: 'utf8' });

  const wrong = [];
  let checked = 0;

  for (const line of listing.split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t');
    const mode = meta.split(' ')[0];
    // Symlinks and submodules have modes of their own and no contents to read.
    if (mode !== '100644' && mode !== '100755') continue;
    if (/node_modules|\.(png|ico|sqlite|jpg)$/.test(file)) continue;

    let head;
    try {
      head = readFileSync(path.join(repoRoot, file), 'utf8').slice(0, 2);
    } catch {
      continue;
    }
    if (head !== '#!') continue;

    checked += 1;
    if (mode !== '100755') wrong.push(`${file} is ${mode}`);
  }

  assert.deepEqual(wrong, [], `run: git update-index --chmod=+x <file>`);
  // A guard that finds nothing to check is a guard that has stopped working.
  assert.ok(checked >= 3, `only found ${checked} files with a shebang`);
});
