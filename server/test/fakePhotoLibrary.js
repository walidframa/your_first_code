/**
 * A stand-in for the picture libraries.
 *
 * All four in one server, because the app points them all at one base when it
 * is being tested and because they only differ by the shape of the reply. A
 * real HTTP server rather than a stubbed fetch, for the same reason
 * `fakeTelegram.js` is one: what is worth testing here happens across a
 * network — a library that answers with nothing, a link that has moved, a
 * picture far too big for a tile, a file that turns out to be a web page.
 */
import http from 'node:http';

/**
 * A real PNG, one pixel, 67 bytes.
 *
 * Real bytes rather than a made-up string so what comes back out the far end is
 * genuinely `data:image/png;base64,…` that a browser would render.
 */
export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export function createFakePhotoLibrary() {
  const state = {
    /** Every search that arrived: { library, query, url }. */
    searches: [],
    /** Set to make a library answer with no results. */
    empty: new Set(),
    /** Set to make a library fail outright. */
    failing: new Set(),
    /** How many bytes /img/big.png claims and sends. */
    bigBytes: 400 * 1024,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json') => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': bytes.length });
      res.end(bytes);
    };

    /* ---- the pictures themselves ---- */
    if (url.pathname === '/img/ok.png') return send(200, ONE_PIXEL_PNG, 'image/png');
    if (url.pathname === '/img/big.png') {
      return send(200, Buffer.alloc(state.bigBytes, 1), 'image/png');
    }
    if (url.pathname === '/img/gone.png') return send(404, { error: 'gone' });
    if (url.pathname === '/img/notreally.png') {
      // A link that answers with a web page, which is what a hotlink-blocking
      // site does rather than refusing outright.
      return send(200, Buffer.from('<html>nope</html>'), 'text/html');
    }

    const base = `http://127.0.0.1:${server.address().port}`;

    /* ---- Wikimedia: Commons and Wikipedia share one endpoint ---- */
    if (url.pathname === '/w/api.php') {
      const commons = url.searchParams.get('gsrnamespace') === '6';
      const library = commons ? 'commons' : 'wikipedia';
      const query = url.searchParams.get('gsrsearch') || '';
      state.searches.push({ library, query, url: req.url });

      if (state.failing.has(library)) return send(503, { error: 'busy' });
      if (state.empty.has(library)) return send(200, { query: { pages: [] } });

      if (commons) {
        return send(200, {
          query: {
            pages: [
              {
                title: `File:${query}.png`,
                imageinfo: [
                  {
                    thumburl: `${base}/img/ok.png`,
                    descriptionurl: `${base}/wiki/File:${encodeURIComponent(query)}.png`,
                    extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
                  },
                ],
              },
            ],
          },
        });
      }

      return send(200, {
        query: {
          pages: [
            { title: query, thumbnail: { source: `${base}/img/ok.png`, width: 600, height: 400 } },
          ],
        },
      });
    }

    /* ---- Openverse ---- */
    if (url.pathname === '/v1/images/') {
      const query = url.searchParams.get('q') || '';
      state.searches.push({ library: 'openverse', query, url: req.url });
      if (state.failing.has('openverse')) return send(503, { error: 'busy' });
      if (state.empty.has('openverse')) return send(200, { results: [] });
      return send(200, {
        results: [
          {
            title: query,
            thumbnail: `${base}/img/ok.png`,
            url: `${base}/img/ok.png`,
            license: 'by',
            license_version: '4.0',
            source: 'flickr',
            foreign_landing_url: `${base}/photos/1`,
          },
        ],
      });
    }

    /* ---- Google custom search ---- */
    if (url.pathname === '/customsearch/v1') {
      const query = url.searchParams.get('q') || '';
      state.searches.push({
        library: 'google',
        query,
        url: req.url,
        key: url.searchParams.get('key'),
        cx: url.searchParams.get('cx'),
      });
      if (state.failing.has('google')) return send(403, { error: 'over quota' });
      if (state.empty.has('google')) return send(200, { items: [] });
      return send(200, {
        items: [
          {
            title: query,
            link: `${base}/img/ok.png`,
            displayLink: 'example.com',
            image: { thumbnailLink: `${base}/img/ok.png`, contextLink: `${base}/page` },
          },
        ],
      });
    }

    // So a runner can wait for it to be up the way it waits for the API.
    if (url.pathname === '/health') return send(200, { ok: true });

    send(404, { error: 'no such endpoint' });
  });

  return {
    state,
    listen: (port = 0) =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
