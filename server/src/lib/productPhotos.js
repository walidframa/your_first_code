/**
 * Pictures for the catalogue, found on the internet from the product's name.
 *
 * A shop that typed in nine hundred products has nine hundred grey monograms on
 * the register, and photographing every one of them is a week nobody has. So
 * this asks the internet: "Samsung A54 screen protector" goes out, a picture
 * comes back, and it goes on the tile.
 *
 * Three things this deliberately does *not* do:
 *
 *  - **It does not keep a link.** The picture is downloaded and stored on the
 *    product as a `data:` URI, exactly like one chosen from the counter's
 *    computer — see `client/src/components/ProductImageField.jsx` for why this
 *    app has no file store. A link would rot, and a register in a shop whose
 *    internet is out would show a wall of torn-page icons.
 *  - **It does not resize.** Every provider here is asked for a thumbnail at
 *    roughly the size the tile wants, so nothing arrives that needs shrinking
 *    and the server needs no image library. Anything that comes back bigger
 *    than `MAX_PHOTO_BYTES` is refused rather than stored, and the next
 *    candidate is tried.
 *  - **It does not pretend a match is certain.** A name is a weak search, and
 *    "Cable 2m" will find somebody's garden hose. Every candidate carries where
 *    it came from and under what licence, the shop sees the picture before it
 *    is kept when it asks for one product, and a bulk run is undoable.
 *
 * On licences: the two keyless providers are chosen for their answer to this.
 * Wikimedia Commons is free-licensed by definition, and Openverse only indexes
 * openly-licensed work. Both are recorded on the product with the licence name
 * and a link to the page, which is what those licences ask for. Google image
 * search finds far better matches for a shop's actual stock and finds them for
 * almost everything — but it returns whatever is on the web, copyright and all,
 * so it is off unless the shop puts its own key in and turns it on.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { getSettings } from './settings.js';

/** So a test can watch what would have gone out without a network. */
let fetchImpl = (...args) => fetch(...args);
export function setFetchForTests(fn) {
  fetchImpl = fn || ((...args) => fetch(...args));
}

/**
 * The ceiling for one picture, as stored.
 *
 * Every product's picture travels with the product list to every register that
 * opens, so this is not about disk — it is about how long the register takes to
 * come up. The field a shopkeeper uses by hand aims at 30–60 KB; this leaves
 * room above that for a provider's thumbnail without letting a full-size
 * photograph through.
 */
export const MAX_PHOTO_BYTES = 160 * 1024;

/** What a picture is allowed to be. SVG is excluded: it is a script vector. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Long enough for a slow provider, short enough that a bulk run still moves. */
const TIMEOUT_MS = 12_000;

/**
 * Whether a picture may be fetched from an address only this machine can reach.
 *
 * Never, except under the test runner, where the stand-in libraries are on
 * 127.0.0.1 and the thing worth testing is what happens across a real network.
 * Read from the environment rather than from the settings table on purpose: a
 * shop's own admin screen must not be a way to turn the guard below off.
 */
const ALLOW_PRIVATE = process.env.NODE_ENV === 'test';

/**
 * Where the libraries live.
 *
 * Only ever set by the tests, which point all four at one stand-in server —
 * the same arrangement as `shopify_base_url` and `telegram_base_url`.
 */
function bases(settings) {
  const stub = String(settings?.photo_base_url || '').trim().replace(/\/$/, '');
  return {
    commons: stub || 'https://commons.wikimedia.org',
    wikipedia: stub || 'https://en.wikipedia.org',
    openverse: stub || 'https://api.openverse.org',
    google: stub || 'https://www.googleapis.com',
  };
}

/** Roughly the size of a register tile at two-times pixel density. */
const THUMB_PX = 600;

/**
 * The name, made into something worth searching for.
 *
 * Shop names carry things that are meaningful on a shelf label and noise to a
 * search engine: a bracketed note to the counter, a supplier's order code, the
 * unit. "iPhone 14 Pro 128GB (2 left in blue) [ORD-4471]" is a good product
 * name and a bad query.
 *
 * Kept conservative on purpose. The shop said to search by the name, so the
 * name is what goes out — this only takes away what is certainly not part of
 * what the thing is called.
 */
export function searchQuery(name) {
  const cleaned = String(name || '')
    // Anything in brackets is a note to the shop, not part of the product.
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    // Punctuation that means something to a search engine and nothing here.
    .replace(/["“”'`*+|<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Past about eight words a search stops narrowing and starts finding nothing.
  return cleaned.split(' ').filter(Boolean).slice(0, 8).join(' ');
}

/** A fetch that gives up rather than holding a bulk run open for ever. */
async function withTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      headers: {
        // Wikimedia asks callers to identify themselves, and answers 403 to
        // some default agents. Openverse is happier with one too.
        'User-Agent': 'FrontDeskPOS/1.0 (point-of-sale product photos)',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url) {
  const res = await withTimeout(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 * Where pictures come from
 * ------------------------------------------------------------------ */

/**
 * Wikimedia Commons — the file library, not the encyclopaedia.
 *
 * Everything in it is free-licensed, which makes it the one source a shop can
 * use without having to think about it. Weakest on ordinary retail stock: it
 * has a photograph of a Samsung Galaxy A54 and nothing at all of a generic
 * screen protector.
 */
async function commons(query, config) {
  const url =
    `${config.bases.commons}/w/api.php?action=query&format=json&formatversion=2` +
    '&generator=search&gsrnamespace=6&gsrlimit=8' +
    `&gsrsearch=${encodeURIComponent(query)}` +
    `&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=${THUMB_PX}`;

  const data = await getJson(url);
  const pages = data?.query?.pages || [];

  return pages
    .map((page) => {
      const info = page.imageinfo?.[0];
      if (!info?.thumburl) return null;
      const meta = info.extmetadata || {};
      return {
        url: info.thumburl,
        title: String(page.title || '').replace(/^File:/, ''),
        provider: 'Wikimedia Commons',
        licence: meta.LicenseShortName?.value || 'See the file page',
        page: info.descriptionurl || null,
      };
    })
    .filter(Boolean);
}

/**
 * The picture at the top of a Wikipedia article.
 *
 * Better than Commons at named things — a phone model, an inverter brand — because
 * it answers with the article's own lead image rather than with whatever file
 * happens to be titled that way. Its licence is usually free and occasionally
 * is not, which is why the file page goes on the product beside it.
 */
async function wikipedia(query, config) {
  const url =
    `${config.bases.wikipedia}/w/api.php?action=query&format=json&formatversion=2` +
    '&generator=search&gsrlimit=5' +
    `&gsrsearch=${encodeURIComponent(query)}` +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=${THUMB_PX}`;

  const data = await getJson(url);
  const pages = data?.query?.pages || [];

  return pages
    .filter((page) => page.thumbnail?.source)
    .map((page) => ({
      url: page.thumbnail.source,
      title: page.title,
      provider: 'Wikipedia',
      licence: 'See the file page',
      page: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
    }));
}

/**
 * Openverse — openly-licensed pictures from across the web.
 *
 * Broadest of the keyless three, and the loosest: a search for a product name
 * returns things that are *about* that name rather than photographs of it. Last
 * in the order for that reason.
 */
async function openverse(query, config) {
  const url =
    `${config.bases.openverse}/v1/images/?page_size=8` +
    `&q=${encodeURIComponent(query)}`;

  const data = await getJson(url);
  return (data?.results || [])
    .filter((r) => r.thumbnail || r.url)
    .map((r) => ({
      url: r.thumbnail || r.url,
      title: r.title || query,
      provider: r.source ? `Openverse · ${r.source}` : 'Openverse',
      licence: [r.license, r.license_version].filter(Boolean).join(' ').toUpperCase() || 'Open licence',
      page: r.foreign_landing_url || null,
    }));
}

/**
 * Google image search, on the shop's own key.
 *
 * Finds the actual product where the other three find nothing, which for a
 * phone shop is most of the catalogue. It is off until a shop enters its own
 * key and search-engine id, for two reasons that both matter: the allowance is
 * charged to whoever owns the key, and the results are ordinary web images
 * whose copyright belongs to whoever made them. A shop turning this on is
 * deciding to use them; that decision is not one this app can make for it.
 */
async function google(query, config) {
  const { key, cx } = config.google;
  const url =
    `${config.bases.google}/customsearch/v1?searchType=image&num=8&safe=active&imgSize=medium` +
    `&key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}` +
    `&q=${encodeURIComponent(query)}`;

  const data = await getJson(url);
  return (data?.items || [])
    .filter((item) => item.link || item.image?.thumbnailLink)
    .map((item) => ({
      // The thumbnail first: it is the size a tile wants, and it is served by
      // Google rather than by whatever site is hosting the original, which may
      // be slow, down, or refusing anything that is not a browser.
      url: item.image?.thumbnailLink || item.link,
      title: item.title || query,
      provider: item.displayLink ? `Google · ${item.displayLink}` : 'Google',
      licence: 'Whatever the source site allows',
      page: item.image?.contextLink || item.link || null,
    }));
}

/** Every provider, in the order a run should try them. */
export const PROVIDERS = {
  google: { label: 'Google image search', keyed: true, find: google },
  commons: { label: 'Wikimedia Commons', keyed: false, find: commons },
  wikipedia: { label: 'Wikipedia', keyed: false, find: wikipedia },
  openverse: { label: 'Openverse', keyed: false, find: openverse },
};

/**
 * What the shop has switched on, and in what order to ask.
 *
 * Google first when it is configured, because when it is available it is the
 * one that answers; the free three below it, best licence first.
 */
export function photoSettings(settings = getSettings()) {
  const key = String(settings.photo_google_key || '').trim();
  const cx = String(settings.photo_google_cx || '').trim();
  const choice = String(settings.photo_source || 'auto').trim() || 'auto';

  const order = choice === 'auto' ? ['google', 'commons', 'wikipedia', 'openverse'] : [choice];

  return {
    source: choice,
    google: { key, cx },
    googleReady: Boolean(key && cx),
    bases: bases(settings),
    order: order.filter((name) => PROVIDERS[name] && (name !== 'google' || (key && cx))),
  };
}

/* ------------------------------------------------------------------ *
 * Bringing one back
 * ------------------------------------------------------------------ */

/**
 * Refuse to fetch anything that is not out on the internet.
 *
 * The addresses handed to `download` come from a provider's reply, and with
 * Google that means an arbitrary third-party URL chosen by whoever got their
 * page indexed. A server that will fetch any address it is given is a way to
 * read things only the server can reach — the droplet's own admin ports, the
 * cloud metadata service at 169.254.169.254, anything else on the private
 * network. So the host is resolved first and the answer has to be a public
 * address.
 */
async function assertPublic(hostname) {
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0) throw new Error('That address does not resolve');

  for (const { address } of addresses) {
    const v4 = net.isIPv4(address);
    const parts = v4 ? address.split('.').map(Number) : [];
    const bad = v4
      ? parts[0] === 0 ||
        parts[0] === 10 ||
        parts[0] === 127 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
        parts[0] >= 224
      : /^(::1?$|::$|fc|fd|fe80|::ffff:)/i.test(address);

    if (bad && !ALLOW_PRIVATE) throw new Error('That address is not on the public internet');
  }
}

/**
 * Fetch a candidate and turn it into what the product column holds.
 *
 * Everything that can go wrong here is ordinary — a link that has moved, a site
 * that refuses a robot, a picture far too big for a tile — so each one is a
 * thrown message the caller can show or step past, not a crash.
 */
export async function download(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That is not an address');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only web addresses can be fetched');
  }
  await assertPublic(parsed.hostname);

  const res = await withTimeout(parsed.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`The picture could not be fetched (${res.status})`);

  const mime = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ACCEPTED.has(mime)) throw new Error(`That is not a picture (${mime || 'no type given'})`);

  // Checked before reading where the server said, and again after, because a
  // Content-Length is a claim rather than a fact.
  const claimed = Number(res.headers.get('content-length') || 0);
  if (claimed > MAX_PHOTO_BYTES) {
    throw new Error(`That picture is ${Math.round(claimed / 1024)}KB, too big for a tile`);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('That picture is empty');
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new Error(`That picture is ${Math.round(bytes.length / 1024)}KB, too big for a tile`);
  }

  return {
    dataUri: `data:${mime};base64,${bytes.toString('base64')}`,
    byteSize: bytes.length,
    mime,
  };
}

/**
 * Ask for pictures of something, from the first provider that has any.
 *
 * Providers are tried in turn rather than all at once and merged: a run over a
 * whole catalogue makes one call per product when the first source answers, and
 * only pays for the rest when it does not.
 */
export async function findPhotos(name, { settings = getSettings(), limit = 8 } = {}) {
  const query = searchQuery(name);
  if (!query) return { query, candidates: [], tried: [] };

  const config = photoSettings(settings);
  const tried = [];

  for (const key of config.order) {
    const provider = PROVIDERS[key];
    try {
      const found = await provider.find(query, config);
      tried.push({ provider: key, found: found.length });
      if (found.length) return { query, candidates: found.slice(0, limit), tried };
    } catch (err) {
      // One provider being down or rate-limiting is not the end of the search.
      tried.push({ provider: key, error: err.message });
    }
  }

  return { query, candidates: [], tried };
}

/**
 * A name in, a picture ready to store out — or null, said plainly.
 *
 * Walks the candidates in order and keeps the first that actually comes back as
 * an image of a sane size, so one dead link near the top of a search does not
 * leave a product grey when the second result would have done.
 */
export async function findOnePhoto(name, options = {}) {
  const { query, candidates, tried } = await findPhotos(name, options);
  const refused = [];

  for (const candidate of candidates) {
    try {
      const picture = await download(candidate.url);
      return { query, picture, candidate, tried, refused };
    } catch (err) {
      refused.push({ url: candidate.url, reason: err.message });
    }
  }

  return { query, picture: null, candidate: null, tried, refused };
}

/**
 * The line kept on the product saying where its picture came from.
 *
 * Not decoration: a Creative Commons licence is granted on condition the source
 * is credited, and a shop cannot credit what nobody wrote down. Also the only
 * way to answer "where did this picture come from?" a year later, which is the
 * question that gets asked when one turns out to be wrong.
 */
export function attribution(candidate) {
  if (!candidate) return '';
  return [candidate.provider, candidate.licence, candidate.page].filter(Boolean).join(' · ');
}
