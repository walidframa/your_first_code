/**
 * Telling every other screen that something changed.
 *
 * A shop with two counters had a second PC that showed the stock as it stood
 * when its page was opened. A sale on the first PC took a phone off the shelf;
 * the second kept offering it until somebody pressed F5. The same with a
 * repair moved on the bench, a payment taken at the desk, a price changed in
 * the back office — each true on the machine it happened on and stale on
 * every other one.
 *
 * So the server keeps one open connection per screen (server-sent events: a
 * plain HTTP response that never ends) and, whenever a request *changes*
 * something — anything but a GET that came back without an error — tells
 * every screen which part of the shop moved. Screens that care ask for their
 * data again; the rest ignore it. Nothing about *what* changed goes down the
 * wire, only *that* it did, so the stream carries no data a login could not
 * already read, and it needs the same login to open.
 *
 * Each screen sends its own id with every request, and the event carries it
 * back, so the screen that made a change — which already has the new state
 * in hand — can leave the event alone. The other PC is the one that needs it.
 */
import { requireAuth } from '../middleware/auth.js';

const screens = new Set();

/** Which part of the shop a request touched: the first segment of its path. */
function topicOf(req) {
  const path = String(req.path || '');
  return path.split('/').filter(Boolean)[0] || 'shop';
}

/* Requests that change nothing anyone else is looking at. */
const QUIET = new Set(['auth', 'live', 'support']);

export function publish(event) {
  if (screens.size === 0) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of screens) {
    try {
      res.write(line);
    } catch {
      screens.delete(res);
    }
  }
}

/**
 * Mounted under /api before the routes: after any request that changed
 * something answers, say so. On `finish` rather than in the route, so no
 * endpoint has to remember — the one that forgot would be the one that
 * mattered.
 */
export function broadcastWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const topic = topicOf(req);
  if (QUIET.has(topic)) return next();
  const origin = req.get('x-client-id') || null;
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    publish({ topic, origin, at: Date.now() });
  });
  next();
}

/**
 * The stream itself. A browser's EventSource cannot set headers, so the login
 * token arrives in the query string and is put where the auth check looks.
 */
export const liveRoute = [
  (req, _res, next) => {
    if (!req.headers.authorization && req.query.token) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }
    next();
  },
  requireAuth,
  (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      /* nginx would otherwise hold the reply until it had a page of it. */
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    screens.add(res);

    /* Something down the pipe every so often, or a proxy shuts an idle one. */
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* closed under us; the close handler tidies up */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      screens.delete(res);
    });
  },
];

/** For the tests: how many screens are listening. */
export function listening() {
  return screens.size;
}
