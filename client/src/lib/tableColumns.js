import { useState } from 'react';

/**
 * Which columns a table shows.
 *
 * A shop's catalogue answers different questions to different people. The
 * owner pricing a delivery wants cost, average cost and margin side by side;
 * the person on the counter wants the name, the price and what is left on the
 * shelf, and everything else is in the way. Both are looking at the same table.
 *
 * So the columns are the reader's choice, kept **on the device** rather than in
 * the database — the same reason the text size is. The tablet at the counter
 * and the laptop in the back office are two different jobs, and a shop with one
 * login should not have to choose between them.
 *
 * A table declares its columns; this remembers which of them are wanted. New
 * columns added in a later version appear for everybody, because what is stored
 * is the set that was **turned off**, not the set that was on — storing the
 * "on" set would freeze a saved layout at the columns that existed the day it
 * was saved, and the shop would never see a new one.
 */

const KEY = 'pos_columns';

/** Columns nobody may hide: without these the row is not a row of anything. */
export const fixed = (columns) => columns.filter((c) => c.fixed).map((c) => c.key);

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    // A storage entry edited by hand, or a browser that refuses it: the table
    // shows everything, which is the same as never having chosen.
    return {};
  }
}

function write(all) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Private browsing, or a full quota. The choice lasts the session.
  }
}

/** The keys this table is currently hiding. */
export function hiddenFor(table) {
  const stored = read()[table];
  return Array.isArray(stored) ? stored.filter((k) => typeof k === 'string') : [];
}

/** Remember what is hidden, or forget it when nothing is. */
export function setHiddenFor(table, hidden) {
  const all = read();
  if (!hidden || hidden.length === 0) delete all[table];
  else all[table] = [...new Set(hidden)];
  write(all);
}

/**
 * The columns to render, in the order the table declared them.
 *
 * A column marked `fixed` survives whatever is stored against it, so a layout
 * saved before a column became compulsory cannot leave a table with no name in
 * it.
 */
export function visibleColumns(columns, hidden) {
  const off = new Set(hidden || []);
  return columns.filter((c) => c.fixed || !off.has(c.key));
}

/**
 * The columns state a table needs, read back from the device on first render.
 *
 * Lives here rather than beside the picker because what it reads is the store
 * above it — and a table that shows the columns without offering the picker
 * (a printed view, a narrow screen) still wants the reader's choice honoured.
 */
export function useColumns(table, columns) {
  const [hidden, setHidden] = useState(() => hiddenFor(table));
  return {
    hidden,
    setHidden,
    visible: visibleColumns(columns, hidden),
  };
}
