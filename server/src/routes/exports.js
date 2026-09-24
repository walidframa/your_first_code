/**
 * A list, handed back as a file.
 *
 * The screen decides what goes in — which rows survived the search and the
 * filters, which columns were ticked — and sends exactly that. The server's
 * only job is to turn it into a real .xlsx or a real PDF, which the browser
 * cannot make on its own. Nothing here reads the database, so nothing here
 * can hand out a row the screen was not allowed to show.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { writeWorkbook } from '../lib/xlsx.js';
import { renderTablePdf } from '../lib/exportTable.js';
import { getSettings } from '../lib/settings.js';

const router = Router();

const MAX_ROWS = 20000;
const MAX_COLUMNS = 40;

/** What the two routes have in common: a name, headings, and the rows under them. */
function readTable(body) {
  const { name, title, subtitle = null, columns, rows } = body || {};
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_COLUMNS) {
    throw new Error('Pick at least one column');
  }
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    throw new Error(`Up to ${MAX_ROWS.toLocaleString('en-US')} rows at a time`);
  }
  const heads = columns.map((c) => ({
    label: String(c?.label ?? '').slice(0, 80),
    align: c?.align === 'right' ? 'right' : c?.align === 'center' ? 'center' : 'left',
  }));
  const cells = rows.map((row) =>
    heads.map((_, i) => {
      const v = Array.isArray(row) ? row[i] : null;
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || typeof v === 'boolean') return v;
      return String(v).slice(0, 500);
    }),
  );
  const safeName = String(name || title || 'list')
    .replace(/[^\w؀-ۿ .-]+/g, ' ')
    .trim()
    .slice(0, 80) || 'list';
  return { name: safeName, title: String(title || safeName).slice(0, 120), subtitle, columns: heads, rows: cells };
}

router.post('/xlsx', requireAuth, (req, res) => {
  let table;
  try {
    table = readTable(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const file = writeWorkbook({ sheet: table.title, columns: table.columns, rows: table.rows });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(table.name)}.xlsx"`);
  res.setHeader('Content-Length', file.length);
  res.send(file);
});

router.post('/pdf', requireAuth, (req, res) => {
  let table;
  try {
    table = readTable(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const settings = getSettings();
  const { pdf, unsupportedText } = renderTablePdf({
    title: table.title,
    subtitle: table.subtitle,
    columns: table.columns,
    rows: table.rows,
    company: {
      name: settings.company_name,
      address: settings.company_address,
      phones: [settings.company_phone, settings.company_phone2].filter(Boolean).join(' · '),
    },
    generatedBy: req.user.name || req.user.username || null,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(table.name)}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  /* So the screen can say "some names came out as ?" rather than leaving it to be found later. */
  res.setHeader('X-Unsupported-Text', unsupportedText ? '1' : '0');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Unsupported-Text');
  res.send(pdf);
});

export default router;
