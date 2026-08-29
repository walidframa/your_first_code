/**
 * Read an Excel file, without a library.
 *
 * A supplier sends a price list as a spreadsheet, not a CSV, and telling a
 * shopkeeper to open it and "save as CSV" is how half a catalogue arrives with
 * the barcodes turned into 1.23457E+12 — Excel's own CSV export is where that
 * damage happens, so the file is better read as it came.
 *
 * An .xlsx is a ZIP of XML, both of which Node can already do: `node:zlib`
 * inflates, and the parts that matter here are simple enough to read with a
 * scanner rather than a DOM. That keeps this in the same shape as
 * `lib/pdf.js` — the format written out by hand rather than pulled in — and
 * means an import feature does not put a parser for arbitrary archives, run
 * against files strangers email to the shop, into the dependency tree.
 *
 * What it deliberately does not do: formulas (the cached result is used, which
 * is what the sender saw), styles, dates as dates (a serial number comes
 * through as a number — nothing a product catalogue maps to is a date), and the
 * old binary .xls, which is a different format entirely and gets an error
 * saying so.
 */
import { inflateRawSync } from 'node:zlib';

/* --------------------------------------------------------------------- zip */

const SIG_EOCD = 0x0605_4b50;
const SIG_EOCD64_LOCATOR = 0x0706_4b50;
const SIG_CENTRAL = 0x0201_4b50;
const SIG_LOCAL = 0x0403_4b50;

/**
 * Find the end-of-central-directory record.
 *
 * Scanned backwards because it sits at the very end unless the file carries a
 * trailing comment, which is legal and which some exporters use. 64KB back is
 * the whole space a comment can occupy.
 */
function findEocd(buf) {
  const earliest = Math.max(0, buf.length - 0xff_ff - 22);
  for (let i = buf.length - 22; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * The archive's index: every entry, where it starts and how it is packed.
 *
 * Read from the central directory rather than by walking local headers, because
 * a local header is allowed to say the sizes are "in a descriptor after the
 * data" — which cannot be read without already knowing where the data ends.
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('That file is not a spreadsheet — it is not even a zip archive');

  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  /*
   * ZIP64. A product catalogue never needs it, but a file saved by a tool that
   * always writes ZIP64 would otherwise fail with a baffling message.
   */
  if (offset === 0xffff_ffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) {
      throw new Error('That spreadsheet uses a zip layout this cannot read');
    }
    const eocd64 = Number(buf.readBigUInt64LE(locator + 8));
    count = Number(buf.readBigUInt64LE(eocd64 + 32));
    offset = Number(buf.readBigUInt64LE(eocd64 + 48));
  }

  const entries = new Map();
  let p = offset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) break;

    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);

    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One file out of the archive, as text. */
function readEntry(buf, entry) {
  if (!entry) return null;

  const start = entry.localOffset;
  if (buf.readUInt32LE(start) !== SIG_LOCAL) throw new Error('That spreadsheet is damaged');

  // The local header's own name and extra lengths, which may differ from the
  // central directory's — the spec allows it and real writers do it.
  const nameLength = buf.readUInt16LE(start + 26);
  const extraLength = buf.readUInt16LE(start + 28);
  const from = start + 30 + nameLength + extraLength;
  const raw = buf.subarray(from, from + entry.compressedSize);

  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) return inflateRawSync(raw).toString('utf8');
  throw new Error('That spreadsheet is compressed in a way this cannot read');
}

/* --------------------------------------------------------------------- xml */

const XML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(text) {
  return text
    .replaceAll(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m])
    .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** The value of one attribute on a tag, given the tag's opening text. */
function attr(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]) : null;
}

/**
 * Every `<t>` inside a fragment, joined.
 *
 * A cell whose text was edited in pieces — a word made bold halfway through —
 * is stored as several runs, and reading only the first would silently truncate
 * a product name.
 */
function textOf(fragment) {
  let out = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    out += unescapeXml(m[1] ?? '');
  }
  return out;
}

/* ------------------------------------------------------------------ sheets */

/** "BC" → 54. Column letters are base-26 with no zero. */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A cell's value as the text a person would have seen.
 *
 * Numbers are the delicate case. A 13-digit barcode is stored as a number, and
 * anything that lets it near exponent notation destroys it — which is exactly
 * what happens when the same file is exported to CSV by Excel. Integers are
 * printed as integers for that reason.
 */
function cellText(value, type, shared) {
  if (value === null || value === undefined) return '';

  if (type === 's') {
    const index = Number(value);
    return shared[index] ?? '';
  }
  // 'str' is a formula's cached string result; 'b' is a boolean.
  if (type === 'str' || type === 'inlineStr' || type === 'e') return value;
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';

  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Number.isInteger(n) ? n.toFixed(0) : String(n);
}

/** One worksheet as a grid of strings, ragged rows squared off. */
function parseSheet(xml, shared) {
  const rows = [];
  let width = 0;

  /*
   * The self-closing form is matched explicitly. A blank line in the middle of
   * a sheet is written `<row r="7"/>`, and a pattern that only knows
   * `<row ...>...</row>` matches its opening tag and then runs on to the next
   * row's closing one, merging the two. Nothing is lost when that happens — a
   * self-closing row has no cells to lose and the ones it swallows are still
   * placed by their own references — so this is tidiness rather than a fix.
   * It is here because a reader that quietly merges rows is one bad assumption
   * away from a reader that quietly drops them.
   */
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];

    for (const cellMatch of (rowMatch[1] ?? '').matchAll(
      /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const open = ` ${cellMatch[1]}`;
      const body = cellMatch[2] ?? '';
      const type = attr(open, 't');

      let raw;
      if (type === 'inlineStr') {
        raw = textOf(body);
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        raw = v ? unescapeXml(v[1]) : null;
      }

      /*
       * Placed by its own reference rather than by counting: an empty cell is
       * simply absent from the file, so a row read positionally shifts every
       * value after the first gap into the wrong column.
       */
      const at = columnIndex(attr(open, 'r') || '') ?? cells.length;
      cells[at] = cellText(raw, type, shared);
    }

    // A row with no cells at all is a blank line in the middle of a sheet.
    const filled = [...cells].map((c) => c ?? '');
    width = Math.max(width, filled.length);
    rows.push(filled);
  }

  return rows.map((row) => {
    const padded = [...row];
    padded.length = width;
    return [...padded].map((c) => c ?? '');
  });
}

/* ------------------------------------------------------------------- entry */

/**
 * Open a workbook.
 *
 * Returns every sheet with its name, in the order the file lists them, because
 * a supplier's file routinely has a price list, a cover note and last month's
 * version in one workbook, and only the shop can say which is which.
 */
export function readWorkbook(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // The old binary format, which is not a zip at all. Worth naming, because
  // "not a zip archive" is not an answer anybody can act on.
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf_11e0) {
    throw new Error(
      'That is an old .xls file. Open it in Excel and save it as .xlsx, then import it again.',
    );
  }

  const entries = readCentralDirectory(buf);

  const workbookXml = readEntry(buf, entries.get('xl/workbook.xml'));
  if (!workbookXml) throw new Error('That file is not an Excel workbook');

  /*
   * Sheet name to file. The workbook lists sheets by relationship id and the
   * rels file maps those to paths — the order of xl/worksheets/sheetN.xml is
   * not the order of the tabs, so the mapping cannot be skipped.
   */
  const rels = readEntry(buf, entries.get('xl/_rels/workbook.xml.rels')) || '';
  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\s([^>]*)\/>/g)) {
    const id = attr(` ${m[1]}`, 'Id');
    const path = attr(` ${m[1]}`, 'Target');
    if (id && path) target.set(id, path.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const shared = [];
  const sharedXml = readEntry(buf, entries.get('xl/sharedStrings.xml'));
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g)) {
      shared.push(textOf(m[1] ?? ''));
    }
  }

  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\s([^>]*?)\/>/g)) {
    const open = ` ${m[1]}`;
    const name = attr(open, 'name') || `Sheet ${sheets.length + 1}`;
    const rid = attr(open, 'r:id') || attr(open, 'id');
    const path = target.get(rid);
    const xml = path ? readEntry(buf, entries.get(path)) : null;
    // A chart sheet has a name and no grid; it belongs in the list so the
    // numbering the shopkeeper sees matches their tabs, but it has no rows.
    sheets.push({ name, rows: xml ? parseSheet(xml, shared) : [] });
  }

  if (sheets.length === 0) throw new Error('That workbook has no sheets in it');
  return { sheets };
}

/** How far in to look for the header before giving up and taking the first row. */
const HEADER_SEARCH_ROWS = 10;

/**
 * Which row is the header.
 *
 * Not simply the first row with something in it. A supplier's export opens with
 * their name across one cell, then a blank line, then the real columns — and
 * taking the first non-empty row turns their letterhead into a column name and
 * the actual header into a product called "Item Name".
 *
 * The header is the widest row near the top: a title fills one cell, a header
 * fills all of them. Ties go to the earliest, so a sheet that starts straight
 * in at row 1 behaves as it always did.
 */
function headerRowIndex(rows) {
  let best = -1;
  let bestFilled = 0;
  let looked = 0;

  for (const [i, row] of rows.entries()) {
    const filled = row.filter((cell) => String(cell).trim() !== '').length;
    if (filled === 0) continue;
    if (filled > bestFilled) {
      best = i;
      bestFilled = filled;
    }
    looked += 1;
    if (looked >= HEADER_SEARCH_ROWS) break;
  }
  return best;
}

/**
 * A sheet as header names and records, the shape the CSV import already speaks.
 *
 * Anything above the header is dropped. If the guess is wrong the wizard's
 * mapping step is still there to correct it by hand — this only has to be right
 * often enough that nobody has to.
 */
export function sheetToRecords(rows) {
  const start = headerRowIndex(rows);
  if (start < 0) return { headers: [], records: [] };

  const seen = new Map();
  const headers = rows[start].map((cell, i) => {
    const name = String(cell).trim() || `Column ${i + 1}`;
    /*
     * Two columns called "Price" would otherwise collide into one and the
     * second would silently win. Suffixed rather than dropped, so the mapping
     * screen can show both and the shop can pick.
     */
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  });

  const records = [];
  for (const row of rows.slice(start + 1)) {
    if (row.every((cell) => String(cell).trim() === '')) continue;
    const record = {};
    headers.forEach((header, i) => {
      record[header] = String(row[i] ?? '').trim();
    });
    records.push(record);
  }

  return { headers, records };
}
