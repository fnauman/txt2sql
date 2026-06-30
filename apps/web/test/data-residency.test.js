import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDataResidency } from '../src/server/data-residency.js';

test("client-ok ONLY for the synthetic demo_retail DB + demo_readonly user", () => {
  const residency = resolveDataResidency({ DB_NAME: 'demo_retail', DB_USER: 'demo_readonly' });
  assert.equal(residency.engine, 'client-ok');
  assert.equal(residency.source, 'demo_readonly@demo_retail');
});

// This is the fail-closed contract: data egress must NEVER be enabled for a
// non-demo database, a privileged user, or an unknown source.
test('a non-demo database is never client-ok', () => {
  assert.equal(resolveDataResidency({ DB_NAME: 'internal_erp_db', DB_USER: 'demo_readonly' }).engine, 'server-only');
});

test('a non-SELECT-only user is never client-ok, even on demo_retail', () => {
  assert.equal(resolveDataResidency({ DB_NAME: 'demo_retail', DB_USER: 'root' }).engine, 'server-only');
});

test('missing/unknown source defaults to server-only', () => {
  assert.equal(resolveDataResidency({}).engine, 'server-only');
  assert.equal(resolveDataResidency({ DB_NAME: 'demo_retail' }).engine, 'server-only');
  assert.equal(resolveDataResidency({ DB_USER: 'demo_readonly' }).engine, 'server-only');
});
