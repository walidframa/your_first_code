/**
 * A statement of account as a PDF.
 *
 * The screen prints one through the browser, and that is the right way on a
 * computer. In the phone app there is no browser print at all: the WebView
 * ignores `window.print()`, so the Print button did nothing and the shop
 * concluded it was broken. A file the phone can open, share or print through
 * its own sheet is the answer there — and a file is also what gets emailed to
 * a customer who asked for their account, which a print dialog never was.
 *
 * Same facts as the screen, in the same order: who, the period, the balance
 * brought forward, every line with its two columns and the running balance,
 * the totals, and whatever else was on file in the period.
 */
import { createDocument } from './pdf.js';
import { getSettings } from './settings.js';
import { knownZone } from './shopTime.js';

const INK = [0.1, 0.12, 0.16];
const MUTED = [0.45, 0.5, 0.56];
const RED = [0.8, 0.15, 0.15];

const usd = (n) =>
  `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A stored UTC stamp as a date on the shop's clock, day first. */
function day(value, zone) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text.split('-').reverse().join('/');
  const at = new Date(`${text.replace(' ', 'T')}${/[zZ]$/.test(text) ? '' : 'Z'}`);
  if (Number.isNaN(at.getTime())) return text;
  return at.toLocaleDateString('en-GB', { timeZone: zone });
}

/** What a line is, in a few words, with its paper named. */
function describe(line) {
  const parts = [];
  if (line.reference) parts.push(line.reference);
  if (line.note && !(line.reference && line.note === line.reference)) parts.push(line.note);
  if (!parts.length) parts.push(line.label);
  return parts.join(' · ');
}

export function renderStatementPdf(statement, { timeZone = 'UTC' } = {}) {
  const zone = knownZone(timeZone);
  const shop = getSettings();
  const { party, period, lines, totals, alsoOnFile } = statement;
  const owedWord = statement.partyType === 'supplier' ? 'owed to them' : 'owed to us';
  const today = new Date().toLocaleDateString('en-GB', { timeZone: zone });

  const doc = createDocument({ title: `Statement - ${party.name}` });
  doc.header = (d) => {
    d.text(`Statement of account · ${party.name}`, { size: 8, color: MUTED });
    d.rule({ above: 2, below: 8 });
  };

  if (shop.company_name) {
    doc.text(shop.company_name, { size: 11, bold: true, color: INK });
    const details = [
      shop.company_address?.replace(/\s*\n\s*/g, ', '),
      [shop.company_phone, shop.company_phone2].filter(Boolean).join(' · '),
      shop.company_tax_number && `VAT / MOF: ${shop.company_tax_number}`,
    ]
      .filter(Boolean)
      .join(' · ');
    if (details) doc.text(details, { size: 8, color: MUTED });
    doc.gap(4);
  }

  doc.text('Statement of account', { size: 18, bold: true, color: INK });
  doc.text(party.name, { size: 12, bold: true, color: INK });
  const who = [party.phone, party.address].filter(Boolean).join(' · ');
  if (who) doc.text(who, { size: 9, color: MUTED });
  doc.text(
    `${period.from ? day(period.from, zone) : 'the beginning'} to ${
      period.to ? day(period.to, zone) : 'today'
    } · printed ${today}`,
    { size: 9, color: MUTED },
  );
  doc.gap(6);
  doc.rule({ below: 6 });

  /* ------------------------------------------------------------ the lines */

  const cols = { date: 62, charge: 78, credit: 78, balance: 84 };
  doc.row(
    [
      { text: 'Date', width: cols.date },
      { text: 'Detail' },
      { text: 'Charged', width: cols.charge, align: 'right' },
      { text: 'Paid', width: cols.credit, align: 'right' },
      { text: 'Balance', width: cols.balance, align: 'right' },
    ],
    { bold: true, size: 8.5 },
  );
  doc.rule({ above: 1, below: 2 });

  doc.row([
    { text: '', width: cols.date },
    { text: 'Balance brought forward', color: MUTED },
    { text: '', width: cols.charge },
    { text: '', width: cols.credit },
    { text: usd(statement.opening), width: cols.balance, align: 'right', color: INK },
  ]);

  for (const line of lines) {
    doc.row([
      { text: day(line.at, zone), width: cols.date, color: MUTED },
      { text: describe(line), color: INK },
      { text: line.charge ? usd(line.charge) : '', width: cols.charge, align: 'right', color: INK },
      { text: line.credit ? usd(line.credit) : '', width: cols.credit, align: 'right', color: INK },
      { text: usd(line.balance), width: cols.balance, align: 'right', color: line.balance < 0 ? RED : INK },
    ]);
  }
  if (!lines.length) {
    doc.row([{ text: '', width: cols.date }, { text: 'Nothing moved in this period.', color: MUTED }]);
  }

  doc.rule({ above: 3, below: 2 });
  doc.row(
    [
      { text: '', width: cols.date },
      { text: 'Totals for the period', bold: true, color: INK },
      { text: usd(totals.charged), width: cols.charge, align: 'right', bold: true },
      { text: usd(totals.paid), width: cols.credit, align: 'right', bold: true },
      { text: usd(totals.closing), width: cols.balance, align: 'right', bold: true },
    ],
    { size: 9.5 },
  );
  doc.gap(4);
  const closing = totals.closing;
  doc.paragraph(
    closing === 0
      ? 'Nothing is owed either way.'
      : `${usd(Math.abs(closing))} ${closing > 0 ? owedWord : 'in credit'} as at ${
          period.to ? day(period.to, zone) : today
        }.`,
    { size: 9.5, bold: true, color: INK },
  );

  /* ------------------------------------------------------ also on file */

  if (alsoOnFile?.length) {
    doc.gap(10);
    doc.text('Also on file in this period', { size: 10, bold: true, color: INK });
    doc.text('Paperwork that did not move the balance: paid at the counter, or not yet confirmed.', {
      size: 8,
      color: MUTED,
    });
    doc.rule({ above: 3, below: 2 });
    for (const item of alsoOnFile) {
      doc.row([
        { text: day(item.at, zone), width: cols.date, color: MUTED },
        {
          text: `${item.reference} · ${String(item.docType || '').replace(/_/g, ' ')} · ${item.status}`,
          color: INK,
        },
        { text: usd(item.total), width: cols.balance, align: 'right', color: INK },
      ]);
    }
  }

  return doc.end();
}
