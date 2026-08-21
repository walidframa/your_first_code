/**
 * Which build this process is running.
 *
 * Read **once, at startup**, and that is the entire point of this file rather
 * than a convenience. The question a deploy needs answered is not "what is on
 * disk" — anybody can look at that — but "what is the process that is serving
 * requests actually running", and those two stopped agreeing the day this app
 * grew a shared checkout.
 *
 * The shape of the bug it exists to catch: several shops run from one copy of
 * these files, each as its own process on its own port. A deploy pulls, builds,
 * and restarts what it believes is running. The client is static files read off
 * disk on every request, so the moment the build finishes every till is showing
 * the new screens. The routes those screens call live in memory in a process
 * that only changes when it is restarted. Miss one restart — a unit named
 * something the script did not match, a shop that was stopped, a `systemctl`
 * that failed quietly — and that shop gets the new app talking to the old
 * server, with a green "Live at" on the terminal and nothing else amiss until a
 * shopkeeper finds a screen that will not load.
 *
 * Because this is read at startup, a process still running last week's code
 * reports last week's commit however new the files under it are, which is
 * exactly the discrepancy `deploy.sh` now refuses to finish without checking.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout these files were loaded from: server/src/lib -> repo root. */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The commit at `.git`, read without shelling out to git.
 *
 * By hand rather than with `git rev-parse` because this runs at startup inside
 * a hardened unit, and spawning a process there is both slower and one more
 * thing that can fail on a machine where git is not installed at all — a
 * container built from a tarball, say. A file read that misses is a null, and a
 * null is a perfectly good answer here.
 */
function fromGit() {
  const head = readFileSync(join(REPO, '.git', 'HEAD'), 'utf8').trim();

  // Detached: HEAD is the commit itself.
  if (!head.startsWith('ref:')) return head;

  const ref = head.slice(4).trim();
  try {
    return readFileSync(join(REPO, '.git', ref), 'utf8').trim();
  } catch {
    /*
     * A ref that has been packed has no file of its own — which is the normal
     * state of a fresh `git clone`, so this is the common path on a new server
     * rather than an edge case.
     */
    const packed = readFileSync(join(REPO, '.git', 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.split(' ');
      if (name === ref) return sha;
    }
    return null;
  }
}

/**
 * `POS_BUILD` wins, so a deployment that has no `.git` at all — a container
 * built from an archive, an image baked in CI — can still say what it is.
 */
function readBuild() {
  if (process.env.POS_BUILD) return process.env.POS_BUILD.trim().slice(0, 40);
  try {
    const sha = fromGit();
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    // No checkout and nothing told us. Unknown is honest; wrong would not be.
    return null;
  }
}

/** The full commit, or null when this copy cannot tell. */
export const BUILD = readBuild();

/** The same thing as somebody would write it down. */
export const BUILD_SHORT = BUILD ? BUILD.slice(0, 7) : null;
