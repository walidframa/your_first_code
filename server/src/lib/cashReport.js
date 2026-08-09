/**
 * The cashbox report.
 *
 * One sitting of one till, start to finish: what was in the drawer, what moved
 * through it, what was counted at the end and what that came out at. It is the
 * page a shopkeeper puts in a folder, or emails to whoever is not standing in
 * the shop — so it exists twice over, as data the app can draw and as a PDF the
 * server can hand over. Both come from the same builder, because a printed
 * report that disagrees with the screen is worse than either on its own.
 *
 * The profit line is separate and optional. Takings are not profit, most of the
 * staff have no business seeing the second, and a report that quietly leaks it
 * to whoever closed the till would be a permission bypass with a filename.
 */
import { combinedUsd, round2 } from './currency.js';
import { sessionSummary } from './cash.js';
import { getSettings } from './settings.js';
import { profitForSession } from './profit.js';
import { createDocument } from './pdf.js';

const KIND_LABELS = {
  opening_float: 'Opening float',
  sale: 'Cash sales',
  refund: 'Refunds',
  customer_payment: 'Customer payments',
  supplier_payment: 'Supplier payments',
  document: 'Invoices paid in cash',
  transfer: 'Money transfers',
  voucher: 'Vouchers',
  cash_in: 'Cash in',
  cash_out: 'Cash out',
  bank_drop: 'To the bank',
  correction: 'Over / short',
};

const REASON_LABELS = {
  petty_cash: 'petty cash',
  owner_funds: 'owner’s money',
  owner_draw: 'owner took out',
  bank_drop: 'to the bank',
  customer_payment: 'customer payment',
  supplier: 'supplier',
  expense: 'expense',
  wages: 'wages',
  refund: 'refund',
  correction: 'correction',
  short: 'short',
  over: 'over',
  other: 'other',
};

export const usd = (n) =>
  `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const lbp = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-US')} LL`;

const signed = (n, format) => (n > 0 ? `+${format(n)}` : format(n));

/** UTC out of SQLite, shown as the shop's own clock. */
const stamp = (value) => (value ? new Date(`${value}Z`).toLocaleString('en-GB', { timeZone: 'UTC' }) : '—');
const clock = (value) =>
  value ? new Date(`${value}Z`).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }).slice(0, 5) : '';

/**
 * Everything the report shows, as plain data.
 *
 * `includeProfit` is the caller's decision, made from the permission on the
 * request — this function does not know who is asking and should not guess.
 */
export function buildCashReport(sessionId, { includeProfit = false } = {}) {
  const summary = sessionSummary(sessionId);
  if (!summary) return null;

  const { session, movements, expected, byKind, sales, salesTotal, refunds } = summary;
  const closed = session.status === 'closed';
  const settings = getSettings();

  /*
   * The sitting's own rate, not today's. A report read back next month should
   * say what it said on the night; re-converting at a rate that has since moved
   * would rewrite a count that was correct.
   */
  const rate = session.exchange_rate || settings.exchange_rate;

  const counted = closed ? { usd: session.counted_usd, lbp: session.counted_lbp } : null;
  const difference = closed ? { usd: session.over_short_usd, lbp: session.over_short_lbp } : null;

  return {
    session,
    account: { id: session.account_id, name: session.account_name || 'Cashbox' },
    /* Whose shop it is, so a filed or forwarded report can be placed. */
    company: {
      name: settings.company_name,
      address: settings.company_address,
      phones: [settings.company_phone, settings.company_phone2].filter(Boolean).join(' · '),
      taxNumber: settings.company_tax_number,
    },
    closed,
    rate,
    expected,
    counted,
    difference,
    /*
     * The two currencies added up through the rate. Kept beside the per-currency
     * figures rather than instead of them: the drawer is right or wrong in each
     * on its own, but "am I short" is one number.
     */
    combined: rate > 0
      ? {
          expected: round2(combinedUsd(expected.usd, expected.lbp, rate)),
          counted: counted ? round2(combinedUsd(counted.usd, counted.lbp, rate)) : null,
          difference: difference ? round2(combinedUsd(difference.usd, difference.lbp, rate)) : null,
        }
      : null,
    byKind: byKind.map((k) => ({ ...k, label: KIND_LABELS[k.kind] || k.kind })),
    sales,
    salesTotal,
    refunds,
    movements: movements.map((m) => ({
      ...m,
      label: KIND_LABELS[m.kind] || m.kind,
      reasonLabel: m.reason ? REASON_LABELS[m.reason] || m.reason : null,
    })),
    profit: includeProfit ? sessionProfit(sessionId) : null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The headline profit figures for one sitting, without the long tail.
 *
 * `profitForSession` also works out the best and worst sellers, which is a page
 * of its own and not what a report header or a panel above the drawer wants.
 */
export function sessionProfit(sessionId) {
  const report = profitForSession(sessionId);
  if (!report) return null;
  return {
    revenue: report.revenue,
    cost: report.cost,
    grossProfit: report.grossProfit,
    grossMargin: report.grossMargin,
    expenses: report.expenses.total,
    expenseCount: report.expenses.count,
    netProfit: report.netProfit,
    /*
     * Sales rung up before their cost was known have nothing to subtract, so
     * their profit is overstated. Saying so beats quietly reporting a number
     * that is too good.
     */
    unknownCostLines: report.unknownCostLines,
  };
}

/* ------------------------------------------------------------------- PDF */

const INK = [0.11, 0.13, 0.17];
const MUTED = [0.45, 0.5, 0.56];
const RED = [0.76, 0.15, 0.15];
const AMBER = [0.72, 0.46, 0.06];

const toneFor = (value) => (value === 0 ? INK : value < 0 ? RED : AMBER);

/**
 * Draw the report.
 *
 * Laid out the way it is read: what the drawer came out at first, because that
 * is why the report was opened, then the trade behind it, then every movement
 * for anyone checking the figure rather than trusting it.
 */
export function renderCashReportPdf(report, { generatedBy = null } = {}) {
  const doc = createDocument({ title: `Cashbox report #${report.session.id}` });
  const { session, account } = report;

  const title = `Cashbox report — ${account.name}`;
  doc.header = (d) => {
    d.text(`${title} · sitting #${session.id}`, { size: 8, color: MUTED });
    d.rule({ above: 2, below: 8 });
  };

  /*
   * Whose shop this is. The report is a file that gets emailed and filed, and a
   * page of figures with no name on it is a page nobody can place a month later.
   */
  const shop = report.company;
  if (shop?.name) {
    doc.text(shop.name, { size: 11, bold: true, color: INK });
    const details = [shop.address?.replace(/\s*\n\s*/g, ', '), shop.phones, shop.taxNumber && `VAT / MOF: ${shop.taxNumber}`]
      .filter(Boolean)
      .join(' · ');
    if (details) doc.text(details, { size: 8, color: MUTED });
    doc.gap(4);
  }

  doc.text(title, { size: 18, bold: true, color: INK });
  doc.text(`Sitting #${session.id} · ${report.closed ? 'closed' : 'open now'}`, { size: 10, color: MUTED });
  doc.gap(6);

  doc.rule({ below: 6 });
  const meta = [
    ['Opened', `${stamp(session.opened_at)} · ${session.opened_by_name || '—'}`],
    ['Closed', report.closed ? `${stamp(session.closed_at)} · ${session.closed_by_name || '—'}` : 'still open'],
    ['Opening float', `${usd(session.opening_usd)} · ${lbp(session.opening_lbp)}`],
    ['Exchange rate', report.rate > 0 ? `1 USD = ${Number(report.rate).toLocaleString('en-US')} LL` : 'not set'],
  ];
  for (const [label, value] of meta) {
    doc.row([
      { text: label, width: 120, color: MUTED },
      { text: value, color: INK },
    ]);
  }
  doc.rule({ above: 6, below: 10 });

  /* --------------------------------------------------------- the count */

  if (report.closed) {
    section(doc, 'The count');
    doc.row(
      [
        { text: '', width: 150 },
        { text: 'Expected', width: 110, align: 'right' },
        { text: 'Counted', width: 110, align: 'right' },
        { text: 'Difference', align: 'right' },
      ],
      { bold: true, size: 8.5 },
    );
    doc.rule({ above: 1, below: 2 });

    const rows = [
      ['Dollars', report.expected.usd, report.counted.usd, report.difference.usd, usd],
      ['Lebanese pounds (LBP)', report.expected.lbp, report.counted.lbp, report.difference.lbp, lbp],
    ];
    for (const [label, was, got, diff, format] of rows) {
      doc.row([
        { text: label, width: 150, color: INK },
        { text: format(was), width: 110, align: 'right', color: MUTED },
        { text: format(got), width: 110, align: 'right', color: INK },
        {
          text: diff === 0 ? 'exact' : `${signed(diff, format)} ${diff > 0 ? 'over' : 'short'}`,
          align: 'right',
          bold: true,
          color: toneFor(diff),
        },
      ]);
    }

    if (report.combined) {
      doc.rule({ above: 3, below: 2 });
      const diff = report.combined.difference;
      doc.row([
        { text: 'Altogether, in dollars', width: 150, bold: true, color: INK },
        { text: usd(report.combined.expected), width: 110, align: 'right', color: MUTED },
        { text: usd(report.combined.counted), width: 110, align: 'right', color: INK },
        {
          text: diff === 0 ? 'exact' : `${signed(diff, usd)} ${diff > 0 ? 'over' : 'short'}`,
          align: 'right',
          bold: true,
          color: toneFor(diff),
        },
      ]);
      doc.gap(2);
      doc.paragraph(
        'The pounds are converted at the rate this sitting was opened at. Each currency is still ' +
          'recorded on its own — a drawer is right or wrong in each independently.',
        { size: 8, color: MUTED },
      );
    }

    doc.gap(4);
    doc.row([
      { text: 'Left in the drawer for the next sitting', width: 260, color: MUTED },
      { text: `${usd(session.carried_usd)} · ${lbp(session.carried_lbp)}`, align: 'right', color: INK },
    ]);
    doc.row([
      { text: 'Taken out', width: 260, color: MUTED },
      {
        text: `${usd(round2((session.counted_usd || 0) - (session.carried_usd || 0)))} · ${lbp(
          (session.counted_lbp || 0) - (session.carried_lbp || 0),
        )}`,
        align: 'right',
        color: INK,
      },
    ]);
    if (session.closing_note) {
      doc.gap(2);
      doc.paragraph(`Note: ${session.closing_note}`, { size: 8.5, color: MUTED });
    }
    doc.gap(10);
  }

  /* --------------------------------------------------------- the drawer */

  section(doc, report.closed ? 'What moved through the drawer' : 'What is in the drawer');
  doc.row(
    [
      { text: '', width: 260 },
      { text: 'Dollars', width: 110, align: 'right' },
      { text: 'Lebanese pounds', align: 'right' },
    ],
    { bold: true, size: 8.5 },
  );
  doc.rule({ above: 1, below: 2 });

  for (const kind of report.byKind) {
    doc.row([
      { text: `${kind.label}  ×${kind.count}`, width: 260, color: INK },
      { text: usd(kind.usd), width: 110, align: 'right', color: kind.usd < 0 ? RED : INK },
      { text: lbp(kind.lbp), align: 'right', color: kind.lbp < 0 ? RED : MUTED },
    ]);
  }
  doc.rule({ above: 3, below: 2 });
  doc.row([
    { text: report.closed ? 'Left in the drawer' : 'In the drawer now', width: 260, bold: true },
    { text: usd(report.expected.usd), width: 110, align: 'right', bold: true },
    { text: lbp(report.expected.lbp), align: 'right', bold: true },
  ]);
  doc.gap(10);

  /* ---------------------------------------------------------- the trade */

  section(doc, 'Sales in this sitting');
  if (report.sales.length === 0 && report.refunds.orders === 0) {
    doc.paragraph('Nothing was sold while this till was open.', { size: 9, color: MUTED });
  } else {
    for (const sale of report.sales) {
      doc.row([
        { text: `${sale.payment_method}  ×${sale.orders}`, width: 260, color: INK },
        { text: usd(sale.total), align: 'right', color: INK },
      ]);
    }
    if (report.refunds.orders > 0) {
      doc.row([
        { text: `refunded  ×${report.refunds.orders}`, width: 260, color: INK },
        { text: `-${usd(report.refunds.total)}`, align: 'right', color: RED },
      ]);
    }
    doc.rule({ above: 3, below: 2 });
    doc.row([
      { text: 'Taken', width: 260, bold: true },
      { text: usd(report.salesTotal), align: 'right', bold: true },
    ]);
    doc.gap(2);
    doc.paragraph(
      'Every sale made while this till was open, however it was paid — a shift report that counted ' +
        'only cash would understate the day.',
      { size: 8, color: MUTED },
    );
  }
  doc.gap(10);

  /* --------------------------------------------------------- the profit */

  if (report.profit) {
    section(doc, 'Profit');
    const p = report.profit;
    const lines = [
      ['Revenue', usd(p.revenue), INK],
      ['What the goods cost', `-${usd(p.cost)}`, MUTED],
      ['Gross profit', usd(p.grossProfit), INK, true],
      ['Expenses', `-${usd(p.expenses)}`, MUTED],
      ['Net profit', usd(p.netProfit), p.netProfit < 0 ? RED : INK, true],
    ];
    for (const [label, value, color, bold] of lines) {
      doc.row([
        { text: label, width: 260, bold, color: bold ? INK : MUTED },
        { text: value, align: 'right', bold, color },
      ]);
    }
    if (p.unknownCostLines > 0) {
      doc.gap(2);
      doc.paragraph(
        `${p.unknownCostLines} sold line${p.unknownCostLines === 1 ? '' : 's'} had no cost recorded, so ` +
          'the profit above is overstated by whatever those goods cost.',
        { size: 8, color: AMBER },
      );
    }
    doc.gap(10);
  }

  /* ------------------------------------------------------ every movement */

  section(doc, 'Every movement');
  doc.row(
    [
      { text: 'Time', width: 45 },
      { text: 'What', width: 130 },
      { text: 'Against', width: 150 },
      { text: 'Dollars', width: 90, align: 'right' },
      { text: 'LBP', align: 'right' },
    ],
    { bold: true, size: 8.5 },
  );
  doc.rule({ above: 1, below: 2 });

  for (const m of report.movements) {
    doc.row(
      [
        { text: clock(m.created_at), width: 45, color: MUTED },
        { text: m.reasonLabel ? `${m.label} · ${m.reasonLabel}` : m.label, width: 130, color: INK },
        { text: m.order_number || m.doc_number || m.note || '', width: 150, color: MUTED },
        {
          text: m.amount_usd !== 0 ? usd(m.amount_usd) : '',
          width: 90,
          align: 'right',
          color: m.amount_usd < 0 ? RED : INK,
        },
        {
          text: m.amount_lbp !== 0 ? lbp(m.amount_lbp) : '',
          align: 'right',
          color: m.amount_lbp < 0 ? RED : MUTED,
        },
      ],
      { size: 8.5, leading: 12.5 },
    );
  }

  doc.gap(12);
  doc.rule({ below: 4 });
  doc.text(
    `Produced ${new Date(report.generatedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC` +
      (generatedBy ? ` by ${generatedBy}` : ''),
    { size: 7.5, color: MUTED },
  );

  if (doc.unsupportedText) {
    doc.text(
      'Some characters could not be printed in a standard PDF font and are shown as “?”.',
      { size: 7.5, color: AMBER },
    );
  }

  return doc.end();
}

function section(doc, heading) {
  doc.text(heading, { size: 11, bold: true, color: INK });
  doc.gap(1);
}

/** A filename a folder full of these can be sorted by. */
export function reportFilename(report) {
  const date = (report.session.closed_at || report.session.opened_at || '').slice(0, 10) || 'undated';
  const till = report.account.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `cashbox-${till || 'till'}-${date}-${report.session.id}.pdf`;
}
