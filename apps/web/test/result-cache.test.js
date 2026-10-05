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

test('the constructor takes the loaded config: disabled caches store nothing', () => {
  const cache = new ResultCache({ enabled: false });
  cache.set('q', schema, 1000, true, ok);
  assert.equal(cache.get('q', schema, 1000, true), null);
  assert.equal(cache.enabled, false);
  assert.equal(new ResultCache({ maxEntries: 0 }).enabled, false, 'size 0 disables');
});

test('maxEntries and ttlMs come from the constructor', () => {
  const cache = new ResultCache({ maxEntries: 1, ttlMs: 10 });
  cache.set('a', schema, 1000, true, ok, 0);
  cache.set('b', schema, 1000, true, ok, 0);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('a', schema, 1000, true, 5), null, 'evicted (LRU)');
  assert.deepEqual(cache.get('b', schema, 1000, true, 5), ok);
  assert.equal(cache.get('b', schema, 1000, true, 50), null, 'expired');
});

test('an injected demo-source check replaces the env lookup', () => {
  const cache = new ResultCache({ isDemoSource: () => false });
  cache.set('q', schema, 1000, true, ok);
  assert.equal(cache.get('q', schema, 1000, true), null);
});

test('clear() drops entries and rejects writes computed before it (schema refresh race)', () => {
  const cache = new ResultCache();
  const generation = cache.generation;
  cache.set('q', schema, 1000, true, ok);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.notEqual(cache.generation, generation);

  // A request that started before the clear finishes afterwards.
  cache.set('late', schema, 1000, true, ok, Date.now(), { generation });
  assert.equal(cache.get('late', schema, 1000, true), null);
  cache.set('fresh', schema, 1000, true, ok, Date.now(), { generation: cache.generation });
  assert.deepEqual(cache.get('fresh', schema, 1000, true), ok);
});
