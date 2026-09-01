/**
 * The deploy must never say green about a shop it did not ask.
 *
 * What happened, on the live installation: the deploy restarted the tenant and
 * the console, skipped `pos.service` — the process behind the address the owner
 * actually opens — and printed a green "Live at" over a shop two commits
 * behind. The shop was not reported as failing. It was not reported at all.
 *
 * The cause was one line, and it is the kind that reads as correct:
 *
 *     systemctl list-unit-files | grep -q "^pos.service"
 *
 * under `set -o pipefail`. `grep -q` stops at the first match and exits;
 * `systemctl` is still writing the other several hundred units, takes SIGPIPE
 * and dies with 141; `pipefail` reports the *pipeline* as 141 — a failure —
 * although the match was found. So the script concluded the machine had no shop
 * of its own, and a shop it does not know about is a shop it cannot check.
 *
 * The console's own detection two dozen lines above was the same shape but
 * passed the unit name to `systemctl` as a filter, so its output was one line,
 * so `grep` read all of it and there was no broken pipe. Same bug, only one of
 * them armed — which is why the console kept working and hid the other.
 *
 * Two things are held here: the detection, and the safety net that makes a
 * wrong answer to it visible instead of green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const script = path.join(repoRoot, 'deploy', 'deploy.sh');
const source = readFileSync(script, 'utf8');

/**
 * A stand-in shaped like the machine this went wrong on: hundreds of units,
 * with the ones that matter among them. The length is the point — a short list
 * never trips the broken pipe, which is why this was invisible in testing.
 */
function fakeSystemctl() {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-systemctl-'));
  const bin = path.join(dir, 'systemctl');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
case "$1" in
  cat)
    case "$2" in
      pos.service|pos-console.service|pos-tenant@protech.service) echo '[Unit]'; exit 0 ;;
      *) exit 1 ;;
    esac ;;
  list-unit-files)
    if printf '%s\\n' "$@" | grep -q 'pos[*]'; then
      echo 'pos.service enabled'
      echo 'pos-console.service enabled'
      echo 'pos-tenant@.service enabled'
      echo 'pos-tenant@protech.service enabled'
      exit 0
    fi
    for i in $(seq 1 400); do echo "unit-$i.service enabled"; done
    echo 'pos.service enabled'
    for i in $(seq 401 800); do echo "unit-$i.service enabled"; done
    exit 0 ;;
  *) exit 0 ;;
esac
`,
    'utf8',
  );
  chmodSync(bin, 0o755);
  return dir;
}

/** Run a snippet under the same shell options deploy.sh sets. */
function shell(snippet, dir) {
  return execFileSync('bash', ['-c', `set -euo pipefail\n${snippet}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  }).trim();
}

/** The real function out of the real file, so this cannot test a copy of it. */
function unitExistsFromScript() {
  const match = source.match(/^unit_exists\(\) \{\n[\s\S]*?^\}/m);
  assert.ok(match, 'deploy.sh no longer defines unit_exists');
  return match[0];
}

test('the script parses', () => {
  execFileSync('bash', ['-n', script]);
});

test('a unit is found even when hundreds of others follow it', () => {
  /*
   * The regression itself. With the old line this answers "no" — the match is
   * found and the pipeline still fails.
   */
  const dir = fakeSystemctl();
  try {
    const out = shell(
      `${unitExistsFromScript()}\nif unit_exists pos.service; then echo yes; else echo no; fi`,
      dir,
    );
    assert.equal(out, 'yes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('and a unit that is not installed is still not found', () => {
  const dir = fakeSystemctl();
  try {
    const out = shell(
      `${unitExistsFromScript()}\nif unit_exists nope.service; then echo yes; else echo no; fi`,
      dir,
    );
    assert.equal(out, 'no');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing asks systemctl for every unit and then stops reading', () => {
  /*
   * The shape, not the symptom. Any `systemctl ... | grep -q` where systemctl
   * is not given the unit name to filter on is the same trap waiting to be
   * re-set by the next person, and it fails silently in the safe direction —
   * "no such unit" — which is the direction that skips a shop.
   */
  for (const line of source.split('\n')) {
    // The note above `unit_exists` quotes the old line on purpose, so that the
    // next person meets the trap before they re-set it. A comment is not code.
    if (/^\s*#/.test(line)) continue;
    if (!/systemctl[^|]*\|\s*grep\s+-q/.test(line)) continue;
    assert.fail(`deploy.sh pipes systemctl into "grep -q": ${line.trim()}`);
  }
});

test('a shop that was never asked is refused, not passed', () => {
  /*
   * The safety net, tested on the exact state of the deploy that went wrong:
   * the tenant and the console were asked, `pos.service` never was. Even if
   * the detection above breaks again for some other reason, this must not come
   * out green.
   */
  const dir = fakeSystemctl();
  const invariant = source.slice(source.indexOf('INSTALLED_ALL='), source.indexOf('printf \'\\n\\033[1;32m==> Live at'));
  assert.ok(invariant.includes('MISSED'), 'the never-checked invariant is gone from deploy.sh');

  try {
    const run = (asked) =>
      execFileSync(
        'bash',
        ['-c', `set -euo pipefail\nASKED="${asked}"\nSKIPPED=""\n${invariant}\necho GREEN`],
        { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
      );

    assert.throws(
      () => run(' pos-tenant@protech.service pos-console.service'),
      /Command failed/,
      'a deploy that skipped pos.service still reported success',
    );

    const all = run(' pos.service pos-tenant@protech.service pos-console.service');
    assert.match(all, /GREEN/, 'a deploy that asked every shop should pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the template unit is not mistaken for a shop', () => {
  // `pos-tenant@.service` with no slug is the template systemd instantiates
  // from. There is no such shop, and demanding it be checked would make every
  // deploy fail.
  assert.match(source, /pos-tenant@\.service'\) continue/);
});
