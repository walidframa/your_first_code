/**
 * No two test files may listen on the same port.
 *
 * The suite runs its files in parallel, each booting a real server. Two of them
 * sharing a port do not fail honestly: the second finds the first's server
 * already answering, talks to its database instead of its own, and produces a
 * failure somewhere else entirely — in whichever file happened to lose the
 * race, about data it never wrote.
 *
 * Three files were quietly sharing two ports before this existed, which is the
 * argument for it: the clash is invisible until the day it is a red build
 * nobody can reproduce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));

/* The end-to-end runner takes these for its own API and preview server. */
const RESERVED = new Map([
  [4610, 'the end-to-end API server'],
  [4611, 'the end-to-end preview client'],
]);

test('every test file that opens a port has one to itself', () => {
  const taken = new Map();

  for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
    const source = readFileSync(path.join(testDir, file), 'utf8');
    const match = source.match(/^const PORT = (\d+);/m);
    if (!match) continue;

    const port = Number(match[1]);
    const clash = taken.get(port) || RESERVED.get(port);
    assert.equal(
      clash,
      undefined,
      `${file} listens on ${port}, which ${clash} already uses. Give it one of its own.`,
    );
    taken.set(port, file);
  }

  // A sanity check on the check: if the regex stopped matching, this would pass
  // by finding nothing at all.
  assert.ok(taken.size >= 10, `only found ${taken.size} test servers — has the pattern changed?`);
});
