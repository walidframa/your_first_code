import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvToRecords, detectDelimiter } from '../src/lib/csv.js';

test('parses a simple table', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('keeps delimiters inside quoted fields', () => {
  assert.deepEqual(parseCsv('a,b\n"x,y",2'), [
    ['a', 'b'],
    ['x,y', '2'],
  ]);
});

test('unescapes doubled quotes', () => {
  assert.deepEqual(parseCsv('a\n"say ""hi"""'), [['a'], ['say "hi"']]);
});

test('supports newlines inside quoted fields', () => {
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",2'), [
    ['a', 'b'],
    ['line1\nline2', '2'],
  ]);
});

test('handles CRLF line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('ignores a trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('preserves empty fields', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,,3'), [
    ['a', 'b', 'c'],
    ['1', '', '3'],
  ]);
});

test('skips blank lines', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n3,4'), [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
  ]);
});

test('strips a UTF-8 BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('detects alternate delimiters', () => {
  assert.equal(detectDelimiter('a;b;c'), ';');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('a|b|c'), '|');
  assert.equal(detectDelimiter('a,b,c'), ',');
});

test('ignores delimiters inside quotes when detecting', () => {
  assert.equal(detectDelimiter('"a,b";c'), ';');
});

test('maps rows onto header keys', () => {
  const { headers, records } = parseCsvToRecords('Name,SKU\nWidget,W-1\n');
  assert.deepEqual(headers, ['Name', 'SKU']);
  assert.deepEqual(records, [{ Name: 'Widget', SKU: 'W-1' }]);
});

test('trims surrounding whitespace in cells and headers', () => {
  const { headers, records } = parseCsvToRecords(' Name , SKU \n Widget , W-1 ');
  assert.deepEqual(headers, ['Name', 'SKU']);
  assert.deepEqual(records, [{ Name: 'Widget', SKU: 'W-1' }]);
});

test('returns nothing for empty input', () => {
  const { headers, records } = parseCsvToRecords('');
  assert.deepEqual(headers, []);
  assert.deepEqual(records, []);
});
