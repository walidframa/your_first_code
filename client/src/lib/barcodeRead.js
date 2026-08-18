/**
 * Reading a barcode off a picture, when the browser will not.
 *
 * `BarcodeDetector` is built into Chromium and does this in one call. Safari
 * does not have it — which on this shop's counter means the phone in the
 * owner's pocket, the one thing that is always with them while they walk the
 * shelves, was the one device that could not scan. So the app reads the code
 * itself where it has to.
 *
 * Only the four symbologies this app prints, and only 1D: EAN-13, UPC-A,
 * EAN-8 and Code 128. That is what a label out of this app carries and what a
 * retail box in Lebanon carries, and a decoder that also does QR would be
 * several times the size for a code no shelf has on it.
 *
 * The method is the one every laser scanner uses. A barcode is not really
 * black and white — it is a sequence of *run lengths*, and the ratios between
 * them are the message. So a row of pixels becomes a list of runs, each group
 * of runs is measured against the module width its own group implies, and the
 * result is matched against the symbology's table. Nothing here cares about
 * absolute brightness or how big the code is in frame, which is what makes it
 * survive a phone held at arm's length under a shop's fluorescent light.
 *
 * Every read is checked before it is believed: EAN and UPC carry a check
 * digit, Code 128 a modulo-103 checksum. A misread that passes both is rarer
 * than a mistyped number, and the caller asks for two agreeing reads on top.
 */

/* -------------------------------------------------------------- EAN / UPC */

/*
 * The widths of the four runs that make one digit, seven modules in all.
 *
 * `L` is the left half's odd parity; the even-parity `G` set is each of these
 * reversed, and the right half's `R` set is the same widths with the colours
 * swapped — which, working in runs, means the same numbers again. One table,
 * three uses.
 */
const EAN_L = [
  '3211', '2221', '2122', '1411', '1132', '1231', '1114', '1312', '1213', '3112',
];

/* Which of the first six digits are even-parity, and what that says the
   thirteenth digit is — the digit EAN-13 never prints as bars at all. */
const EAN_PARITY = [
  'OOOOOO', 'OOEOEE', 'OOEEOE', 'OOEEEO', 'OEOOEE',
  'OEEOOE', 'OEEEOO', 'OEOEOE', 'OEOEEO', 'OEEOEO',
];

/* ------------------------------------------------------------- Code 128 */

/*
 * The 107 symbols, as the widths of their six runs — the stop symbol has
 * seven. These are the patterns of ISO/IEC 15417; a test checks them against
 * the encoder this app already prints labels with, so a transcription slip
 * cannot ship.
 */
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const CODE128_STOP = 106;
const CODE128_START = { 103: 'A', 104: 'B', 105: 'C' };

/* The printable characters of set A and set B, by symbol value. */
const SET_B = (() => {
  const out = [];
  for (let v = 0; v < 95; v += 1) out.push(String.fromCharCode(v + 32));
  return out;
})();
const SET_A = (() => {
  const out = [];
  for (let v = 0; v < 64; v += 1) out.push(String.fromCharCode(v + 32));
  for (let v = 64; v < 95; v += 1) out.push(String.fromCharCode(v - 64));
  return out;
})();

/* ------------------------------------------------------------------ runs */

/**
 * One row of pixels as alternating runs of dark and light.
 *
 * The threshold is the row's own midpoint rather than a fixed level: a shelf
 * under a strip light and a box in a shadow produce completely different
 * numbers for the same white, and a fixed level reads one of them as all
 * black. Rows with almost no contrast are refused outright — that is a wall,
 * a hand, or a camera still focusing, and running the decoder on it wastes
 * the frame.
 */
export function rowToRuns(row) {
  let min = 255;
  let max = 0;
  for (const v of row) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 40) return null;

  const threshold = (min + max) / 2;
  const runs = [];
  let dark = row[0] < threshold;
  let length = 0;
  for (const v of row) {
    const isDark = v < threshold;
    if (isDark === dark) {
      length += 1;
    } else {
      runs.push(length);
      dark = isDark;
      length = 1;
    }
  }
  runs.push(length);
  return { runs, darkFirst: row[0] < threshold };
}

/** Widths of `count` runs from `at`, in modules of their own average. */
function modules(runs, at, count, perSymbol) {
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const run = runs[at + i];
    if (run === undefined) return null;
    total += run;
  }
  const module = total / perSymbol;
  // A module under a pixel is noise being read as a barcode.
  if (module < 0.9) return null;

  let out = '';
  for (let i = 0; i < count; i += 1) {
    const width = Math.round(runs[at + i] / module);
    if (width < 1 || width > 4) return null;
    out += width;
  }
  return out;
}

/* ------------------------------------------------------------- symbologies */

const reversed = (pattern) => [...pattern].reverse().join('');

/**
 * An EAN-13, EAN-8 or UPC-A starting at `at`, which must be the first bar of
 * the start guard.
 */
function readEan(runs, at) {
  // The guard says how wide a module is here: three runs, one module each.
  const guard = modules(runs, at, 3, 3);
  if (guard !== '111') return null;

  for (const digits of [6, 4]) {
    const left = at + 3;
    const middle = left + digits * 4;
    const right = middle + 5;
    const end = right + digits * 4;
    if (modules(runs, middle, 5, 5) !== '11111') continue;
    if (modules(runs, end, 3, 3) !== '111') continue;

    let parity = '';
    let code = '';
    let ok = true;

    for (let d = 0; d < digits && ok; d += 1) {
      const pattern = modules(runs, left + d * 4, 4, 7);
      const odd = pattern === null ? -1 : EAN_L.indexOf(pattern);
      const even = pattern === null ? -1 : EAN_L.indexOf(reversed(pattern));
      if (odd >= 0) {
        parity += 'O';
        code += odd;
      } else if (even >= 0) {
        parity += 'E';
        code += even;
      } else {
        ok = false;
      }
    }

    for (let d = 0; d < digits && ok; d += 1) {
      const pattern = modules(runs, right + d * 4, 4, 7);
      const value = pattern === null ? -1 : EAN_L.indexOf(pattern);
      if (value >= 0) code += value;
      else ok = false;
    }
    if (!ok) continue;

    if (digits === 4) {
      // EAN-8 has no parity to carry a thirteenth digit.
      if (parity !== 'OOOO') continue;
      if (!checkDigitOk(code)) continue;
      return code;
    }

    const first = EAN_PARITY.indexOf(parity);
    if (first < 0) continue;
    const full = `${first}${code}`;
    if (!checkDigitOk(full)) continue;
    /*
     * A UPC-A is an EAN-13 with a nothing in front of it, and that is how a
     * shop's catalogue holds it — twelve digits, the way it is printed on the
     * box. Handing back the thirteen would find no product.
     */
    return full.startsWith('0') ? full.slice(1) : full;
  }
  return null;
}

/** The modulo-10 check digit EAN-13, EAN-8 and UPC-A all carry. */
function checkDigitOk(code) {
  let sum = 0;
  let weight = 3;
  for (let i = code.length - 2; i >= 0; i -= 1) {
    sum += Number(code[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === Number(code[code.length - 1]);
}

/**
 * A Code 128 string starting at `at`, which must be a start symbol.
 *
 * Read as symbols first and turned into characters afterwards, because the
 * last symbol before the stop is not a character at all — it is the checksum,
 * and which of the three character sets the ones before it belong to depends
 * on switches that appear among them.
 */
function readCode128(runs, at) {
  const start = CODE128_PATTERNS.indexOf(modules(runs, at, 6, 11));
  if (!CODE128_START[start]) return null;

  const symbols = [];
  let i = at + 6;

  // Long enough for any label this app prints, and a bound rather than a
  // `while` so a wall of noise cannot spin here.
  for (let guard = 0; guard < 120; guard += 1) {
    /*
     * The stop first: it is seven runs, and its first six can look like an
     * ordinary symbol to a decoder that does not check for it.
     */
    if (modules(runs, i, 7, 13) === CODE128_PATTERNS[CODE128_STOP]) {
      if (symbols.length < 2) return null;
      const checksum = symbols.pop();
      let sum = start;
      for (const [n, symbol] of symbols.entries()) sum += symbol * (n + 1);
      if (sum % 103 !== checksum) return null;
      return textOf(start, symbols);
    }

    const symbol = CODE128_PATTERNS.indexOf(modules(runs, i, 6, 11));
    if (symbol < 0) return null;
    symbols.push(symbol);
    i += 6;
  }
  return null;
}

/** The characters those symbols spell, given which set the code started in. */
function textOf(start, symbols) {
  let set = CODE128_START[start];
  let shifted = null;
  let text = '';

  for (const symbol of symbols) {
    const active = shifted || set;
    shifted = null;

    if (active === 'C') {
      if (symbol < 100) {
        // Set C is two digits per symbol, which is why a long number is short.
        text += String(symbol).padStart(2, '0');
      } else if (symbol === 100) set = 'B';
      else if (symbol === 101) set = 'A';
      else if (symbol !== 102) return null; // 102 is FNC1, which prints nothing
      continue;
    }

    if (symbol < 96) {
      text += active === 'A' ? SET_A[symbol] : SET_B[symbol];
      continue;
    }
    // 96 and 97 are FNC3 and FNC2, 102 is FNC1: control, not characters.
    if (symbol === 96 || symbol === 97 || symbol === 102) continue;
    if (symbol === 98) {
      // SHIFT borrows the other set for exactly one character.
      shifted = active === 'A' ? 'B' : 'A';
      continue;
    }
    if (symbol === 99) {
      set = 'C';
      continue;
    }
    if (symbol === 100) {
      // CODE B from set A; from set B it is FNC4, which prints nothing.
      if (active === 'A') set = 'B';
      continue;
    }
    if (symbol === 101) {
      // The mirror of the above: CODE A from set B, FNC4 from set A.
      if (active === 'B') set = 'A';
      continue;
    }
    return null;
  }
  return text || null;
}

/* ---------------------------------------------------------------- the row */

/**
 * Whatever is encoded along one row of pixels, or null.
 *
 * Both directions, because a code held upside down is the same code and a
 * shopkeeper should not have to know which way round the label goes.
 */
export function decodeRow(row) {
  const found = rowToRuns(row);
  if (!found) return null;

  for (const direction of [0, 1]) {
    const runs = direction === 0 ? found.runs : [...found.runs].reverse();
    // Which runs are dark: the first run's colour flips when the row does, and
    // only a dark run can start a symbol.
    const darkFirst = direction === 0 ? found.darkFirst : (found.runs.length % 2 === 1 ? found.darkFirst : !found.darkFirst);

    for (let i = darkFirst ? 0 : 1; i < runs.length; i += 2) {
      const ean = readEan(runs, i);
      if (ean) return ean;
      const code128 = readCode128(runs, i);
      if (code128) return code128;
    }
  }
  return null;
}

/**
 * Whatever is encoded anywhere in a picture, or null.
 *
 * Rows are tried from the middle outwards, because that is where somebody
 * points a phone, and a barcode only has to cross *one* of them to be read —
 * which is why this beats trying to find the code in the image first.
 */
export function decodeImage({ data, width, height }, { rows = 24 } = {}) {
  const row = new Uint8Array(width);
  const order = [];
  for (let n = 1; n <= rows; n += 1) {
    order.push(Math.floor((height * n) / (rows + 1)));
  }
  order.sort((a, b) => Math.abs(a - height / 2) - Math.abs(b - height / 2));

  for (const y of order) {
    const start = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const p = start + x * 4;
      // Green alone: it carries most of the luminance and costs two loads less
      // per pixel, which matters at thirty frames a second on a phone.
      row[x] = data[p + 1];
    }
    const code = decodeRow(row);
    if (code) return code;
  }
  return null;
}
