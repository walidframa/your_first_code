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
import { deflateRawSync, inflateRawSync } from 'node:zlib';

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


/* ----------------------------------------------------------------- writing */

/*
 * And the other way: a list handed back to the shop as a spreadsheet.
 *
 * The owner wants the catalogue, or the customer list, in Excel — to send to a
 * supplier, to work on at home, to hand to the accountant. A CSV opens in
 * Excel too, but opens *badly*: barcodes become 1.23457E+12 and Arabic names
 * become question marks unless somebody knows about the import wizard. A real
 * .xlsx has none of that, and writing one is the reader above run backwards:
 * a handful of XML parts in a ZIP, which `node:zlib` can deflate.
 *
 * Strings go in as inline strings rather than through a shared-string table,
 * which is longer on disk and simpler to write; numbers go in as numbers so
 * Excel adds them up. The first row is bold. Nothing else — no dates, no
 * formulas, no styling beyond that — because a list is a list.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of `{ name, data }` parts, each deflated. Enough for an .xlsx. */
function zip(parts) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8');
    const raw = Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8');
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(SIG_CENTRAL, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    /* Control characters are not XML; a name with one in it would break the file. */
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** A1, B1 … AA1: the column letters Excel expects on every cell. */
function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(value, ref, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/**
 * One sheet: a header row and the rows under it. `columns` are
 * `{ label, width }` (width in characters, worked out from the data when
 * left out); `rows` are arrays of strings, numbers or booleans in the same
 * order. Returns the .xlsx as a Buffer.
 */
export function writeWorkbook({ sheet = 'Sheet1', columns, rows }) {
  const widths = columns.map((c, i) => {
    if (c.width) return c.width;
    let longest = String(c.label || '').length;
    for (const row of rows) {
      const len = String(row[i] ?? '').length;
      if (len > longest) longest = len;
    }
    return Math.min(60, Math.max(8, longest + 2));
  });

  const lines = [];
  lines.push(`<row r="1">${columns.map((c, i) => cellXml(String(c.label ?? ''), `${columnName(i)}1`, 1)).join('')}</row>`);
  rows.forEach((row, r) => {
    const n = r + 2;
    lines.push(`<row r="${n}">${columns.map((_, i) => cellXml(row[i], `${columnName(i)}${n}`)).join('')}</row>`);
  });

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${lines.join('')}</sheetData>` +
    `</worksheet>`;

  const safeSheet = escapeXml(String(sheet).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');

  const parts = [
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${safeSheet}" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
        `</styleSheet>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ];
  return zip(parts);
}
