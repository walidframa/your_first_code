import { matchesSearch } from './search';
import { useState } from 'react';
import { isoDay } from './when';

/**
 * The bar above a list of things that already happened.
 *
 * Every history in the app was answering a different question about when: one
 * showed this month, one showed everything, one showed the last fifty rows and
 * called it a list. So an owner looking for a repair from March pressed
 * different things on different screens, and on some of them could not get
 * there at all.
 *
 * One bar, one set of periods, one box to type into. The periods are named
 * because nobody types two dates to answer "what did we do today", and "All" is
 * here because somebody looking for one invoice from March does not remember it
 * was March — they have the number, and the box is right there.
 */
export const PRESETS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All'],
  ['custom', 'Between two dates'],
];

/* The device's own calendar date. `toISOString` is UTC's, which in Beirut is
   yesterday until three in the morning — see when.js. */
const iso = (d) => isoDay(d);

/** The two dates a named period means, or nulls for "all of it". */
export function rangeFor(preset) {
  const today = new Date();
  if (preset === 'today') return { from: iso(today), to: iso(today) };
  if (preset === 'week') {
    const start = new Date(today);
    // Monday, the way a shop's week runs.
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return { from: iso(start), to: iso(today) };
  }
  if (preset === 'month') {
    return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) };
  }
  if (preset === 'year') {
    return { from: iso(new Date(today.getFullYear(), 0, 1)), to: iso(today) };
  }
  return { from: null, to: null };
}

/**
 * The state behind the bar, and the two questions a list asks of it.
 *
 * `within` takes a timestamp and says whether it is in range; `matches` takes
 * whatever fields the row can be recognised by and says whether the typed text
 * is in one of them. Both are deliberately blunt — a shop searching for "rami"
 * wants the row with Rami on it, wherever on the row he is.
 */
export function useHistoryFilter(initialPreset = 'month', initialTerm = '') {
  const [preset, setPreset] = useState(initialPreset);
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date()));
  const [term, setTerm] = useState(initialTerm);

  const range = preset === 'custom' ? { from, to } : rangeFor(preset);
  const query = term.trim().toLowerCase();

  const within = (stamp) => {
    if (!range.from && !range.to) return true;
    // Dates arrive as 'YYYY-MM-DD HH:MM:SS' or just the day; either way the
    // first ten characters are the day, and days compare as strings.
    const on = String(stamp || '').slice(0, 10);
    if (!on) return true;
    return (!range.from || on >= range.from) && (!range.to || on <= range.to);
  };

  /*
   * Words in any order, across the fields together — see lib/search.js. A
   * shop looking through repairs for a customer types the name the way they
   * say it, not the way it was keyed in.
   */
  const matches = (...fields) => matchesSearch(query, ...fields);

  return {
    preset,
    setPreset,
    from,
    setFrom,
    to,
    setTo,
    term,
    setTerm,
    range,
    query,
    within,
    matches,
  };
}
