/**
 * Keeping the till on screen when the server is not there.
 *
 * A shop runs this on a tablet at the counter talking to a machine in the back.
 * That machine gets switched off, rebooted, or loses power — and without this,
 * the next time anybody touches the screen the app is gone, because the page
 * itself came from the machine that just went away.
 *
 * Three rules, and the differences between them matter:
 *
 * **The page and its assets: cache first.** They are built with a hash in the
 * filename, so a file that exists can never change, and serving it from the
 * cache is both faster and the thing that survives the outage.
 *
 * **Reads the register needs: network first, cache as a fallback.** Prices and
 * stock should be today's when today's can be had. A day-old catalogue is worth
 * having when the alternative is an empty screen; a day-old catalogue served in
 * preference to a live one is just a bug.
 *
 * **Everything else: network only.** Anything that writes goes to the server or
 * not at all. A sale that cannot be sent is held by the app, in IndexedDB,
 * where it can be counted and shown — not silently swallowed here, where
 * nobody would ever see it.
 */
const VERSION = 'v1';
const SHELL = `pos-shell-${VERSION}`;
const READS = `pos-reads-${VERSION}`;

/*
 * What the register cannot open without. Kept deliberately short: these are
 * read on every load and are the difference between a working till and a blank
 * one. Anything to do with money already banked — reports, the cashbox, the
 * books — is left off, because a stale figure about money is worse than no
 * figure at all.
 */
const CACHEABLE_READS = [
  '/api/products',
  '/api/products/categories',
  '/api/orders/tax-rate',
  '/api/wallets',
  '/api/settings',
  '/api/branches',
];

self.addEventListener('install', (event) => {
  /*
   * The page itself is fetched now, because it is the one file whose address is
   * fixed and the one without which nothing else matters. Its assets are not
   * listed: their filenames carry build hashes nobody can know in advance
   * without a build step whose only job would be to write them down, so they
   * are cached as they are used.
   *
   * That means the till has to have loaded the app at least once with this
   * worker in charge before an outage — which is the first load after
   * installing it, and every load after that.
   */
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Straight from the server rather than from the browser's own cache: an
      // index.html that names last week's assets is worse than none.
      await cache.add(new Request('/index.html', { cache: 'reload' }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, READS]);
      for (const name of await caches.keys()) {
        if (name.startsWith('pos-') && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

const isRead = (url) => CACHEABLE_READS.some((path) => url.pathname === path);

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(READS);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * A navigation is the shop opening the app, or reloading it because the
   * screen went strange. It has to be answered even with the server away, so it
   * falls back to whatever index.html was last served — which is the app, which
   * then reads the path itself and shows the right page.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(SHELL);
            cache.put('/index.html', response.clone());
          }
          return response;
        } catch {
          return (await caches.match('/index.html')) || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (isRead(url)) event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
