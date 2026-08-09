/**
 * A very small PDF writer.
 *
 * The shop needs to hand somebody a file — a shift report emailed to the owner,
 * a printout kept in a folder — and "open the browser's print dialog and choose
 * Save as PDF" is not that. It is a different file every time, it depends on
 * which browser is in front of you, and it cannot be produced by the server at
 * all.
 *
 * So this writes the PDF itself. It is deliberately the smallest thing that
 * produces a real, valid file: one page size, the two standard Helvetica faces
 * that every reader already has, text, rules and filled boxes. No font
 * embedding, no images, no dependency to keep up to date — a report is a page of
 * numbers, and numbers are what this can lay out well.
 *
 * The one real limit: the standard fonts are WinAnsi, so Arabic and any other
 * non-Latin script cannot be drawn. Characters outside that range become '?'
 * rather than corrupting the file, and `unsupportedText` reports whether that
 * happened so a caller can say so instead of shipping a page full of question
 * marks.
 */

/** Points, at 72 to the inch. A4 because that is what a Lebanese shop prints on. */
export const PAGE_SIZES = {
  A4: [595.28, 841.89],
  LETTER: [612, 792],
};

/*
 * Character widths for the two faces, in thousandths of the font size, for
 * ASCII 32–126. Right-aligning money without these is guesswork, and a column
 * of figures that does not line up is the one thing a shopkeeper notices before
 * the figures themselves.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * What a string will measure once drawn.
 *
 * Exported because callers that build columns need it before they can decide
 * where a column starts.
 */
export function textWidth(text, size, bold = false) {
  const widths = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let total = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    // Outside the table: accented Latin is roughly a lowercase letter, and
    // anything else will be drawn as '?' anyway.
    total += code >= 32 && code <= 126 ? widths[code - 32] : widths['?'.charCodeAt(0) - 32];
  }
  return (total * size) / 1000;
}

/** Wrap on spaces so a long note becomes a paragraph rather than a truncation. */
export function wrapText(text, width, size, bold = false) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && textWidth(candidate, size, bold) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

/*
 * PDF strings are parenthesised, so the three characters that would end one
 * early have to be escaped. Everything outside WinAnsi becomes '?' — a reader
 * shown a question mark knows something was dropped; a reader shown a broken
 * file does not.
 */
function pdfString(text) {
  let out = '';
  let dropped = false;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += `\\${char}`;
    } else if (code >= 32 && code <= 126) {
      out += char;
    } else if (code >= 160 && code <= 255) {
      // WinAnsi and Latin-1 agree here, so an octal escape is enough.
      out += `\\${code.toString(8).padStart(3, '0')}`;
    } else {
      out += '?';
      dropped = true;
    }
  }
  return { out, dropped };
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/**
 * A document being built.
 *
 * The cursor runs down the page and a new page starts on its own when the
 * bottom margin is reached — a report is a list of unknown length, and every
 * caller working out its own page breaks is how a table ends up split across a
 * footer.
 */
export function createDocument({ pageSize = 'A4', margin = 48, title = '' } = {}) {
  const [width, height] = PAGE_SIZES[pageSize] || PAGE_SIZES.A4;
  const pages = [];
  let ops = [];
  let cursor = height - margin;
  let unsupportedText = false;
  let onNewPage = null;

  const contentWidth = width - margin * 2;

  function newPage() {
    if (ops.length > 0) pages.push(ops);
    ops = [];
    cursor = height - margin;
    if (onNewPage) onNewPage(api);
  }

  /** Make room for `needed` points, starting a page if there is not any. */
  function reserve(needed) {
    if (cursor - needed < margin) newPage();
  }

  function draw(text, { x, y, size, bold, color }) {
    const { out, dropped } = pdfString(text);
    if (dropped) unsupportedText = true;
    const font = bold ? '/F2' : '/F1';
    const [r, g, b] = color || [0, 0, 0];
    ops.push(
      `BT ${font} ${fmt(size)} Tf ${fmt(r)} ${fmt(g)} ${fmt(b)} rg 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm (${out}) Tj ET`,
    );
  }

  const api = {
    width,
    height,
    margin,
    contentWidth,

    /** Called at the top of every page after the first — headers, page numbers. */
    set header(fn) {
      onNewPage = fn;
    },

    get y() {
      return cursor;
    },
    set y(value) {
      cursor = value;
    },

    /** Drop the cursor without drawing anything. */
    gap(points = 8) {
      cursor -= points;
      return api;
    },

    /**
     * One line of text, left, right or centre aligned within the content area.
     * `x` overrides the alignment when a caller is laying out its own columns.
     */
    text(content, { size = 10, bold = false, align = 'left', x = null, color, indent = 0, leading } = {}) {
      const step = leading ?? size * 1.45;
      reserve(step);
      cursor -= step;

      let left = margin + indent;
      if (x !== null) left = x;
      else if (align === 'right') left = margin + contentWidth - textWidth(content, size, bold);
      else if (align === 'center') left = margin + (contentWidth - textWidth(content, size, bold)) / 2;

      draw(content, { x: left, y: cursor + step * 0.25, size, bold, color });
      return api;
    },

    /** A paragraph, wrapped to the content width. */
    paragraph(content, { size = 9, bold = false, color, indent = 0 } = {}) {
      for (const line of wrapText(content, contentWidth - indent, size, bold)) {
        api.text(line, { size, bold, color, indent });
      }
      return api;
    },

    /**
     * A table row.
     *
     * `columns` are `{ text, width, align, bold, color }`, laid out left to
     * right from the margin. Widths are points; a column with no width takes
     * whatever is left.
     */
    row(columns, { size = 9.5, leading = 14, bold = false } = {}) {
      reserve(leading);
      cursor -= leading;

      const fixed = columns.reduce((sum, c) => sum + (c.width || 0), 0);
      const flexible = columns.filter((c) => !c.width).length;
      const spare = flexible > 0 ? (contentWidth - fixed) / flexible : 0;

      let x = margin;
      for (const column of columns) {
        const colWidth = column.width || spare;
        const isBold = column.bold ?? bold;
        const content = String(column.text ?? '');
        // Truncate rather than overflow into the next column: a name running
        // through a figure is worse than a name cut short. Two dots rather than
        // an ellipsis, which the standard fonts cannot draw.
        let shown = content;
        if (textWidth(shown, size, isBold) > colWidth - 4) {
          while (shown.length > 1 && textWidth(`${shown}..`, size, isBold) > colWidth - 4) {
            shown = shown.slice(0, -1);
          }
          shown = `${shown}..`;
        }

        let left = x;
        if (column.align === 'right') left = x + colWidth - textWidth(shown, size, isBold) - 2;
        else if (column.align === 'center') left = x + (colWidth - textWidth(shown, size, isBold)) / 2;

        draw(shown, { x: left, y: cursor + leading * 0.28, size, bold: isBold, color: column.color });
        x += colWidth;
      }
      return api;
    },

    /** A horizontal rule across the content area. */
    rule({ color = [0.85, 0.87, 0.9], thickness = 0.7, above = 4, below = 4 } = {}) {
      reserve(above + below + thickness);
      cursor -= above;
      const [r, g, b] = color;
      ops.push(
        `${fmt(r)} ${fmt(g)} ${fmt(b)} RG ${fmt(thickness)} w ${fmt(margin)} ${fmt(cursor)} m ${fmt(
          margin + contentWidth,
        )} ${fmt(cursor)} l S`,
      );
      cursor -= below;
      return api;
    },

    pageBreak() {
      newPage();
      return api;
    },

    /** True when something could not be drawn in a standard font. */
    get unsupportedText() {
      return unsupportedText;
    },

    /** Serialise to a Buffer. */
    end() {
      if (ops.length > 0) pages.push(ops);
      if (pages.length === 0) pages.push([]);
      return serialise({ pages, width, height, title });
    },
  };

  return api;
}

/**
 * Assemble the objects into a file.
 *
 * A PDF is a set of numbered objects and a table saying where each one starts,
 * so the offsets have to be counted in bytes as the body is built rather than
 * worked out afterwards.
 */
function serialise({ pages, width, height, title }) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based, matching PDF object numbering
  };

  const catalogId = 1;
  const pagesId = 2;
  objects.push('', ''); // placeholders, filled in once the page ids are known

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(width)} ${fmt(height)}] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const infoId = add(
    `<< /Title (${pdfString(title).out}) /Producer (Front Desk POS) /CreationDate (${pdfDate(new Date())}) >>`,
  );

  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}

function pdfDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}
