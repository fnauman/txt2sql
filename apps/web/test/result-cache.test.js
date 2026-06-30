import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { ResultCache, normalizeQuestion, schemaVersion } from '../src/server/result-cache.js';

const DB_NAME = process.env.DB_NAME;
const DB_USER = process.env.DB_USER;

beforeEach(() => {
  // The cache only stores synthetic demo data; emulate that source for set() tests.
  process.env.DB_NAME = 'demo_retail';
  process.env.DB_USER = 'demo_readonly';
});

afterEach(() => {
  if (DB_NAME === undefined) delete process.env.DB_NAME;
  else process.env.DB_NAME = DB_NAME;
  if (DB_USER === undefined) delete process.env.DB_USER;
  else process.env.DB_USER = DB_USER;
});

const schema = { actualTables: ['a', 'b', 'c'], missingTables: [] };
const ok = { success: true, sql: 'SELECT 1', rows: [{ a: 1 }] };

test('normalizeQuestion is case- and whitespace-insensitive', () => {
  assert.equal(normalizeQuestion('  Top   Customers '), 'top customers');
});

test('schemaVersion changes when tables drift', () => {
  assert.notEqual(
    schemaVersion({ actualTables: ['a', 'b'], missingTables: [] }),
    schemaVersion({ actualTables: ['a'], missingTables: ['b'] })
  );
});

test('get returns a stored payload for an equivalent question', () => {
  const cache = new ResultCache();
  cache.set('Top customers', schema, 1000, true, ok);
  assert.deepEqual(cache.get('  top   CUSTOMERS', schema, 1000, true), ok);
});

test('key is sensitive to rowLimit and includeInsights', () => {
  const cache = new ResultCache();
  cache.set('q', schema, 1000, true, ok);
  assert.equal(cache.get('q', schema, 500, true), null);
  assert.equal(cache.get('q', schema, 1000, false), null);
});

test('schema drift busts the cache', () => {
  const cache = new ResultCache();
  cache.set('q', schema, 1000, true, ok);
  assert.equal(cache.get('q', { actualTables: ['a'], missingTables: ['b', 'c'] }, 1000, true), null);
});

test('failed results are never cached', () => {
  const cache = new ResultCache();
  cache.set('q', schema, 1000, true, { success: false });
  assert.equal(cache.get('q', schema, 1000, true), null);
});

test('non-demo sources are refused (data-egress guard)', () => {
  const cache = new ResultCache();
  process.env.DB_NAME = 'internal_erp_db'; // a non-demo database
  cache.set('q', schema, 1000, true, ok);
  assert.equal(cache.get('q', schema, 1000, true), null, 'must not cache non-demo data');

  process.env.DB_NAME = 'demo_retail';
  process.env.DB_USER = 'root'; // not the SELECT-only user
  cache.set('q', schema, 1000, true, ok);
  assert.equal(cache.get('q', schema, 1000, true), null, 'must require demo_readonly');
});

test('entries expire after the TTL', () => {
  const cache = new ResultCache();
  cache.set('q', schema, 1000, true, ok, 0);
  assert.deepEqual(cache.get('q', schema, 1000, true, 1000), ok); // within TTL
  assert.equal(cache.get('q', schema, 1000, true, 60 * 60 * 1000), null); // past TTL
});
