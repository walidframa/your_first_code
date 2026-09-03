/**
 * The shop's own day.
 *
 * Every timestamp in this database is UTC — `datetime('now')` has no other
 * mode — and that is right: it is unambiguous, it sorts, and it survives a
 * server being moved. What is *not* right is asking a shopkeeper to think in
 * it. A shop in Beirut runs on Beirut time, and its "today" starts at midnight
 * there, not at three in the morning when UTC happens to roll over.
 *
 * Until this module, every report cut the day at UTC midnight. On this shop
 * that is 03:00 local, so:
 *
 *   - a sale rung up at half past midnight was filed under *yesterday*, and
 *     the owner reading the day's takings the next morning could not find it;
 *   - the busiest-hours chart was three hours out, reporting a shop that was
 *     busiest at three in the afternoon when it is busiest at six;
 *   - "this month" started on the 1st in UTC, which is the last three hours of
 *     the previous month here.
 *
 * So: dates the shop types and dates the shop reads are **civil dates in the
 * shop's zone**, and this turns them into the UTC bounds the tables are
 * actually filtered by. Nothing else in the app needs to know.
 *
 * The zone is a setting, defaulting to UTC — which is what every existing
 * installation was already getting, so nothing changes for anybody until they
 * say where they are.
 */
import { getSettings } from './settings.js';

export const DEFAULT_ZONE = 'UTC';

/** A zone the platform actually knows, or UTC. */
export function knownZone(zone) {
  const name = String(zone || '').trim();
  if (!name) return DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name }).format(new Date());
    return name;
  } catch {
    /* A zone nobody can resolve is not one to report in. */
    return DEFAULT_ZONE;
  }
}

/** Where this shop keeps its day. */
export function shopZone() {
  return knownZone(getSettings().time_zone);
}

const PARTS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/** The wall-clock reading in `zone` at an instant, as numbers. */
function wallClock(at, zone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...PARTS }).formatToParts(at);
  const got = {};
  for (const p of parts) if (p.type !== 'literal') got[p.type] = Number(p.value);
  // Midnight comes back as hour 24 in some engines' en-GB output.
  if (got.hour === 24) got.hour = 0;
  return got;
}

/**
 * How far ahead of UTC the zone is at that instant, in minutes.
 *
 * Measured rather than tabulated, so summer time is right without this file
 * knowing when Lebanon changes its clocks.
 */
export function zoneOffsetMinutes(zone = shopZone(), at = new Date()) {
  const w = wallClock(at, zone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asIfUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

const pad = (n) => String(n).padStart(2, '0');

/** The civil date — "YYYY-MM-DD" — it is in the shop right now. */
export function shopDay(at = new Date(), zone = shopZone()) {
  const w = wallClock(at, zone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** The UTC timestamp string the table stores, for an instant. */
export function utcStamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The instant a shop-local wall-clock reading happens.
 *
 * Two passes, because the offset itself depends on the answer: the first guess
 * uses the offset at roughly the right moment, the second corrects it if that
 * guess landed the other side of a clock change. Anything past two passes is a
 * gap or an overlap in the local calendar, where any answer is a convention.
 */
function instantOf(year, month, day, hour, minute, second, zone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i += 1) {
    const offset = zoneOffsetMinutes(zone, new Date(guess));
    const next = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** The UTC timestamp at which a shop-local day begins. */
export function dayStartUtc(date, zone = shopZone()) {
  const [y, m, d] = String(date).split('-').map(Number);
  return utcStamp(instantOf(y, m, d, 0, 0, 0, zone));
}

/**
 * The last UTC second of a shop-local day.
 *
 * The whole end day is included on purpose — a report "to the 31st" that
 * stopped at midnight would silently drop the busiest day of the month.
 */
export function dayEndUtc(date, zone = shopZone()) {
  const [y, m, d] = String(date).split('-').map(Number);
  return utcStamp(instantOf(y, m, d, 23, 59, 59, zone));
}

/**
 * What to add to a stored UTC timestamp to read it as shop time, as SQLite
 * says it: `date(created_at, '+180 minutes')`.
 *
 * A single offset for a whole range, so a report that spans a clock change is
 * out by an hour at one boundary. That is the trade for being able to group by
 * day in SQL at all, and an hour at the end of March is a price a shop will
 * never notice — the alternative is pulling every order into JavaScript to
 * bucket it.
 */
export function sqlDayShift(zone = shopZone(), at = new Date()) {
  return `${zoneOffsetMinutes(zone, at) >= 0 ? '+' : '-'}${Math.abs(zoneOffsetMinutes(zone, at))} minutes`;
}
