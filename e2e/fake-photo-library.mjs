/**
 * The stand-in picture libraries, as a process of their own.
 *
 * A process rather than a server inside the runner, because the runner drives
 * the suite with `spawnSync` — which blocks its event loop for the whole run,
 * so an HTTP server living in it would accept connections and never answer one.
 * That is not a hypothetical: it is what happened the first time this was
 * wired up, and it looked exactly like "finding pictures hangs".
 */
import { createFakePhotoLibrary } from '../server/test/fakePhotoLibrary.js';

const port = Number(process.argv[2] || 0);
const library = createFakePhotoLibrary();
console.log(`Picture libraries standing in at ${await library.listen(port)}`);
