/**
 * A list, as a page.
 *
 * The products page, the customers page, the suppliers page: each is a table
 * the owner sometimes wants in their hand rather than on the screen — to fax
 * to a supplier, to file, to read on the sofa. The screen already knows which
 * rows and which columns are wanted; this lays exactly those out on paper,
 * with the shop's name on top and the page number at the bottom, and nothing
 * the screen did not send.
 *
 * Drawn with lib/pdf.js, so the same limit applies: the standard fonts cannot
 * draw Arabic. `unsupportedText` says whether any cell lost characters, so the
 * caller can tell the shop to take the Excel instead of shipping a page of
 * question marks.
 */
import { createDocument, textWidth } from './pdf.js';

const INK = [0.12, 0.16, 0.22];
const MUTED = [0.45, 0.5, 0.58];

/**
 * `columns` are `{ label, align }`; `rows` are arrays of cell values in the
 * same order. Wide tables go on a landscape page; widths are shared out by the
 * longest thing in each column, within reason, so a notes column cannot
 * starve the figures beside it.
 */
export function renderTablePdf({ title, subtitle = null, columns, rows, company = null, generatedBy = null }) {
  const landscape = columns.length > 5;
  const doc = createDocument({ pageSize: landscape ? 'A4_LANDSCAPE' : 'A4', margin: 40, title });

  const cells = rows.map((row) => columns.map((_, i) => formatCell(row[i])));

  /* Share the width out by how much each column has to say, but no column
     under a name's worth nor over a third of the page. */
  const size = 8.5;
  const wanted = columns.map((c, i) => {
    let longest = textWidth(String(c.label ?? ''), size, true);
    for (const row of cells) {
      const w = textWidth(row[i], size, false);
      if (w > longest) longest = w;
    }
    return Math.min(doc.contentWidth / 3, Math.max(36, longest + 10));
  });
  const total = wanted.reduce((a, b) => a + b, 0);
  const scale = doc.contentWidth / total;
  const widths = wanted.map((w) => w * scale);

  const headerRow = () =>
    doc
      .row(
        columns.map((c, i) => ({ text: String(c.label ?? ''), width: widths[i], align: c.align, bold: true, color: INK })),
        { size, leading: 14 },
      )
      .rule({ above: 1, below: 3 });

  let pageNo = 1;
  doc.header = (d) => {
    pageNo += 1;
    d.text(`${title} · page ${pageNo}`, { size: 8, color: MUTED });
    d.rule({ above: 2, below: 6 });
    headerRow();
  };

  if (company?.name) {
    doc.text(company.name, { size: 11, bold: true, color: INK });
    const details = [company.address, company.phones].filter(Boolean).join(' · ');
    if (details) doc.text(details, { size: 8, color: MUTED });
    doc.gap(4);
  }
  doc.text(title, { size: 16, bold: true, color: INK });
  const line = [subtitle, `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, stamp(new Date()), generatedBy]
    .filter(Boolean)
    .join(' · ');
  doc.text(line, { size: 9, color: MUTED });
  doc.gap(6);
  headerRow();

  cells.forEach((row, n) => {
    doc.row(
      row.map((text, i) => ({ text, width: widths[i], align: columns[i].align, color: INK })),
      { size, leading: 13 },
    );
    if (n % 5 === 4) doc.rule({ color: [0.93, 0.94, 0.95], thickness: 0.4, above: 0, below: 0 });
  });

  return { pdf: doc.end(), unsupportedText: doc.unsupportedText };
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).replace(/\s+/g, ' ').trim();
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
