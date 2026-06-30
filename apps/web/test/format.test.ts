import assert from 'node:assert/strict';
import test from 'node:test';

import { csvField, formatCurrency, formatValue, friendlyError } from '../src/client/format.ts';

test('formatValue handles empties, numbers, booleans, and text', () => {
  assert.equal(formatValue(null), '-');
  assert.equal(formatValue(undefined), '-');
  assert.equal(formatValue(''), '-');
  assert.equal(formatValue(1000), '1,000');
  assert.equal(formatValue(12.5), '12.5');
  assert.equal(formatValue(true), 'Yes');
  assert.equal(formatValue(false), 'No');
  assert.equal(formatValue('Acme'), 'Acme');
});

test('formatCurrency renders currency or a dash', () => {
  assert.ok(formatCurrency(1.5, 'USD').includes('$'));
  assert.equal(formatCurrency(undefined), '-');
});

test('csvField quotes only when needed and escapes quotes', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField(null), '');
});

test('friendlyError maps backend strings to plain language', () => {
  assert.match(friendlyError('Database "demo_retail" is missing expected demo tables. Missing: Brand'), /not fully set up/i);
  assert.match(friendlyError('SQL references table "X" which is outside the allowed table set.'), /valid query/i);
  assert.match(friendlyError('Only read-only SQL is allowed.'), /safe, read-only/i);
  assert.match(friendlyError('Failed to fetch'), /reach the query service/i);
  assert.match(friendlyError('Too many requests. Please wait 5s'), /wait a moment/i);
  // Already user-actionable messages are passed through unchanged.
  assert.equal(friendlyError('Question must be 2000 characters or fewer.'), 'Question must be 2000 characters or fewer.');
  // Never returns an empty string.
  assert.ok(friendlyError('').length > 0);
  assert.ok(friendlyError(null).length > 0);
});
