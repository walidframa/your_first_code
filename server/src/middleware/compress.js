/**
 * Compressing what goes back on the wire.
 *
 * The catalogue is the whole of this file's reason to exist. A shop with 1,829
 * products answers `GET /products` with 1.2MB of JSON, and the register asks
 * for it on every visit to every screen. Measured on that catalogue: the server
 * spends 40ms building it and the till spends seconds downloading it, which is
 * a slow app in exactly the way a shopkeeper means when they say the app is
 * slow.
 *
 * That JSON compresses to about a thirtieth of itself — 1.2MB down to 41KB —
 * because a catalogue is the same two dozen keys repeated two thousand times,
 * which is the shape gzip is best at. Five milliseconds of CPU for twenty-seven
 * times less to send is not a trade-off, it is a bug fix.
 *
 * Only `res.json` is wrapped, deliberately. The other big thing this server
 * hands over is the client bundle, and that is already served `immutable` with
 * a year's cache — downloaded once per deploy and never again, so squeezing it
 * saves a shop one download a fortnight. The catalogue is the one that is paid
 * for over and over.
 *
 * gzip rather than brotli, which would reach 23KB instead of 41KB. At this size
 * the difference is a fifth of a second on a slow line, and it costs twice the
 * CPU on a machine that is also serving three shops. One code path, understood
 * by everything, and the twenty-seven-fold win is already taken.
 */
import { gzip } from 'node:zlib';

/*
 * Below this, compression is a waste and can make the body larger: a gzip
 * header alone is eighteen bytes, and most of this API's replies — a login, a
 * saved product, an ok — are a few hundred. The catalogue and the inventory
 * list, the two that hurt, are three orders of magnitude above it.
 */
const THRESHOLD = 1024;

const accepts = (header) =>
  String(header || '')
    .split(',')
    .some((part) => part.trim().split(';')[0].toLowerCase() === 'gzip');

/**
 * Wrap `res.json` so a large reply travels compressed.
 *
 * Wrapped rather than hooked into the socket the way a general-purpose
 * compression middleware does. That kind has to handle streaming, chunked
 * writes, flushes and every other way a body can be produced; this server sends
 * every one of its API replies through `res.json` in one piece, so the one
 * place worth touching is that one, and the fiddly cases simply do not arise.
 */
export function compressJson(req, res, next) {
  const plain = res.json.bind(res);

  res.json = (body) => {
    const text = JSON.stringify(body);

    /* Anything already encoded, or too small to be worth it, goes as it was. */
    if (
      res.headersSent ||
      res.getHeader('Content-Encoding') ||
      !accepts(req.headers['accept-encoding']) ||
      Buffer.byteLength(text) < THRESHOLD
    ) {
      return plain(body);
    }

    /*
     * Said whatever happens next: a cache that keeps the compressed copy and
     * hands it to a client that cannot read it has broken the app for that
     * client, and this header is the only thing that stops it.
     */
    res.vary('Accept-Encoding');

    gzip(Buffer.from(text, 'utf8'), (err, out) => {
      /* A failure here is not worth failing the request over — the shop wanted
         its catalogue, not its catalogue compressed. */
      if (err || res.headersSent) return plain(body);

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', out.length);
      res.end(out);
    });

    return res;
  };

  next();
}
