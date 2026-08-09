/**
 * The PDF writer.
 *
 * A PDF is only readable if the cross-reference table points at the right
 * bytes, and nothing in the app would notice if it did not — the file would
 * simply fail to open on somebody's machine, days later. So these tests read
 * the file back the way a reader does: follow `startxref`, follow each offset,
 * and check an object really begins there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, textWidth, wrapText } from '../src/lib/pdf.js';

/** Walk the file the way a PDF reader has to: trailer, xref, then objects. */
function parseXref(buffer) {
  const text = buffer.toString('latin1');

  const startxref = /startxref\s+(\d+)/.exec(text);
  assert.ok(startxref, 'the file must say where its xref table is');
  const tableAt = Number(startxref[1]);
  assert.equal(text.slice(tableAt, tableAt + 4), 'xref', 'startxref must point at the table');

  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const entries = [...text.slice(tableAt).matchAll(/^(\d{10}) (\d{5}) ([nf])\s*$/gm)];
  assert.equal(entries.length, size, 'one entry per object, plus the free head');

  const offsets = entries.filter((e) => e[3] === 'n').map((e) => Number(e[1]));
  return { text, offsets, size };
}

test('the file is a PDF a reader can find its way around', () => {
  const doc = createDocument({ title: 'Test report' });
  doc.text('Cashbox report', { size: 18, bold: true });
  doc.rule();
  doc.row([{ text: 'Dollars', width: 200 }, { text: '$1,234.56', align: 'right' }]);
  const pdf = doc.end();

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));

  const { text, offsets } = parseXref(pdf);
  for (const [index, offset] of offsets.entries()) {
    const there = text.slice(offset, offset + 20);
    assert.match(there, new RegExp(`^${index + 1} 0 obj`), `object ${index + 1} must start at its offset`);
  }
});

test('a stream declares the length that was actually written', () => {
  const doc = createDocument();
  doc.text('Some text with (brackets) and a \\ backslash');
  const text = doc.end().toString('latin1');

  const declared = Number(/<< \/Length (\d+) >>\nstream\n/.exec(text)[1]);
  const body = text.slice(text.indexOf('stream\n') + 'stream\n'.length, text.indexOf('\nendstream'));
  assert.equal(Buffer.byteLength(body, 'latin1'), declared, 'a wrong length makes the page unreadable');
});

test('the three characters that would end a string early are escaped', () => {
  const doc = createDocument();
  doc.text('Rami (Achrafieh) \\ Co.');
  const text = doc.end().toString('latin1');
  assert.match(text, /\(Rami \\\(Achrafieh\\\) \\\\ Co\.\) Tj/);
});

test('running past the bottom of the page starts another one', () => {
  const doc = createDocument();
  for (let i = 0; i < 120; i += 1) doc.text(`Movement ${i}`);
  const text = doc.end().toString('latin1');

  const pages = [...text.matchAll(/\/Type \/Page[^s]/g)].length;
  assert.ok(pages > 1, 'a hundred and twenty lines do not fit on one A4 page');
  assert.match(text, new RegExp(`/Count ${pages}`));
});

test('a header is drawn on every page it was set for', () => {
  const doc = createDocument();
  doc.header = (d) => d.text('Cashbox report - sitting #7', { size: 8 });
  for (let i = 0; i < 200; i += 1) doc.text(`Movement ${i}`);
  const text = doc.end().toString('latin1');

  const pages = [...text.matchAll(/\/Type \/Page[^s]/g)].length;
  const headers = [...text.matchAll(/\(Cashbox report - sitting #7\)/g)].length;
  assert.ok(pages > 2, 'two hundred lines run to several pages');
  assert.equal(headers, pages - 1, 'every page after the first carries the running header');
});

test('script the standard fonts cannot draw is flagged rather than silently mangled', () => {
  const doc = createDocument();
  doc.text('محل الهاتف');
  doc.end();
  assert.equal(doc.unsupportedText, true, 'the caller has to be able to say so on the page');
});

test('accented Latin survives, because plenty of Lebanese names carry it', () => {
  const doc = createDocument();
  doc.text('Café Béchara');
  const text = doc.end().toString('latin1');
  assert.equal(doc.unsupportedText, false);
  assert.match(text, /Caf\\351 B\\351chara/, 'WinAnsi octal escapes, not question marks');
});

test('measuring is what makes a column of figures line up', () => {
  assert.ok(textWidth('$1,000.00', 10) > textWidth('$1.00', 10));
  assert.ok(
    textWidth('Total', 10, true) > textWidth('Total', 10, false),
    'bold is wider, and a header that ignores that overlaps the column beside it',
  );
  assert.equal(textWidth('', 10), 0);
});

test('wrapping breaks on spaces and never loses a word', () => {
  const source = 'The difference is recorded against this sitting so the next one starts from what is there';
  const lines = wrapText(source, 150, 9);

  assert.ok(lines.length > 1);
  assert.equal(lines.join(' '), source, 'every word comes back, in order');
  for (const line of lines) {
    // A single word longer than the column still gets its own line rather than
    // being dropped, so only multi-word lines are held to the width.
    if (line.includes(' ')) assert.ok(textWidth(line, 9) <= 150);
  }
});
