/**
 * Going through the catalogue and finding a picture for everything without one.
 *
 * One product is a button and an answer. Nine hundred is a job: at a second or
 * two each it runs for twenty minutes, which no browser request survives and no
 * shopkeeper watches. So it runs on the server and the screen asks how it is
 * getting on.
 *
 * Deliberately small:
 *
 *  - **One run at a time, held in memory.** Two runs over the same catalogue
 *    would fetch everything twice and race each other to the same rows. If the
 *    server restarts mid-run the run is lost — but every picture it had already
 *    saved is on its product, and starting again simply skips them, because
 *    what it looks for is products with no picture.
 *  - **It writes as it goes.** A run stopped halfway is worth exactly what it
 *    did before it stopped, rather than nothing.
 *  - **Everything it did is undoable.** It is a machine guessing from a name,
 *    and it will sometimes be confidently wrong. The list it leaves behind is
 *    what "undo" is built from, so it holds what each product's picture was
 *    before — which is how a run over products that already had pictures can be
 *    put back exactly, not merely blanked.
 */
import { db, transaction } from '../db.js';
import { attribution, findOnePhoto } from './productPhotos.js';
import { getSettings } from './settings.js';

/**
 * How many products are being looked up at once.
 *
 * Not a knob worth turning up. Wikimedia and Openverse both rate-limit an
 * anonymous caller, and a shop that hammers them gets 429s for the rest of the
 * run — which looks exactly like "the feature does not work". Four is quick
 * enough to finish a large catalogue over a coffee and slow enough to be
 * welcome.
 */
const CONCURRENCY = 4;

/** The one run, or null. Replaced wholesale rather than mutated in place. */
let run = null;

/** Products still without a picture, oldest first so a run is repeatable. */
export function withoutPhotos({ limit = null, includeArchived = false } = {}) {
  return db
    .prepare(
      `SELECT id, name FROM products
        WHERE (image_url IS NULL OR image_url = '')
          ${includeArchived ? '' : 'AND active = 1'}
          AND is_service = 0
        ORDER BY id
        ${limit ? 'LIMIT ?' : ''}`,
    )
    .all(...(limit ? [limit] : []));
}

/** How many there are, for the screen that offers to go and get them. */
export function countWithoutPhotos(options = {}) {
  return withoutPhotos(options).length;
}

/** What the screen polls for. Safe to call when nothing is running. */
export function status() {
  if (!run) return { running: false, started: false };
  return {
    running: run.running,
    started: true,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    total: run.total,
    done: run.done,
    found: run.results.length,
    missed: run.missed,
    failed: run.failed,
    stopping: run.stopping,
    error: run.error,
    /* Newest first: what a shop watches is what just came in. */
    results: run.results.slice().reverse(),
  };
}

export function stop() {
  if (run?.running) run.stopping = true;
  return status();
}

/** For tests, and for a screen that wants a clean slate before starting again. */
export function reset() {
  run = null;
}

/**
 * Put back what a run did, in whole or for one product.
 *
 * Restores the picture the product had before rather than clearing it, because
 * a run can be asked to look at products that already had one.
 */
export function undo({ productId = null } = {}) {
  if (!run) return { undone: 0 };

  const restore = db.prepare('UPDATE products SET image_url = ?, image_source = ? WHERE id = ?');
  const wanted = productId ? run.results.filter((r) => r.productId === Number(productId)) : run.results;

  let undone = 0;
  const apply = transaction((rows) => {
    for (const row of rows) {
      if (row.undone) continue;
      restore.run(row.wasImage || null, row.wasSource || null, row.productId);
      row.undone = true;
      undone += 1;
    }
  });
  apply(wanted);

  return { undone };
}

/**
 * Start looking. Returns immediately; the work carries on behind the request.
 *
 * `products` is taken once, at the start, so a sale rung up mid-run does not
 * change what the run is doing or how far along it says it is.
 */
export function start({ limit = null, includeArchived = false } = {}) {
  if (run?.running) return { started: false, reason: 'A search is already running', status: status() };

  const products = withoutPhotos({ limit, includeArchived });
  if (products.length === 0) {
    return { started: false, reason: 'Every product already has a picture', status: status() };
  }

  run = {
    running: true,
    stopping: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: products.length,
    done: 0,
    missed: 0,
    failed: 0,
    error: null,
    results: [],
  };

  // Read once: a run must not pick up a settings change halfway through and
  // start asking a different library than the one it reported.
  const settings = getSettings();
  const save = db.prepare('UPDATE products SET image_url = ?, image_source = ? WHERE id = ?');
  const before = db.prepare('SELECT image_url, image_source FROM products WHERE id = ?');

  const queue = products.slice();
  const worker = async () => {
    while (queue.length && !run.stopping) {
      const product = queue.shift();
      try {
        const { picture, candidate } = await findOnePhoto(product.name, { settings });
        if (picture) {
          const was = before.get(product.id) || {};
          save.run(picture.dataUri, attribution(candidate), product.id);
          run.results.push({
            productId: product.id,
            name: product.name,
            image: picture.dataUri,
            source: attribution(candidate),
            title: candidate?.title || '',
            provider: candidate?.provider || '',
            byteSize: picture.byteSize,
            wasImage: was.image_url || null,
            wasSource: was.image_source || null,
            undone: false,
          });
        } else {
          run.missed += 1;
        }
      } catch (err) {
        /*
         * One product failing is not the run failing. A name that finds
         * nothing, a library refusing the caller for a minute, a link that has
         * moved — all of these are ordinary, and stopping on the first would
         * mean a catalogue never gets past whichever product is awkward.
         */
        run.failed += 1;
        run.error = err.message;
      } finally {
        run.done += 1;
      }
    }
  };

  const started = run;
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, products.length) }, worker))
    .catch((err) => {
      started.error = err.message;
    })
    .finally(() => {
      started.running = false;
      started.stopping = false;
      started.finishedAt = new Date().toISOString();
    });

  return { started: true, status: status() };
}
