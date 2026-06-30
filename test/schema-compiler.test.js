import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileSchemaFromModelsDir,
  ensureCompiledSchema,
  isCompiledSchemaStale,
} from '../src/schema-compiler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../models');

async function modelFileNames() {
  const files = await fs.readdir(MODELS_DIR);
  return files.filter((file) => file.endsWith('.js'));
}

test('isCompiledSchemaStale flags a cache built from a different model-file set', async () => {
  const stale = await isCompiledSchemaStale({ tables: [{ file: 'Customer.js' }] }, MODELS_DIR);
  assert.equal(stale, true);
});

test('isCompiledSchemaStale accepts a cache matching the current model files', async () => {
  const files = await modelFileNames();
  const cached = { tables: files.map((file) => ({ file })) };
  assert.equal(await isCompiledSchemaStale(cached, MODELS_DIR), false);
});

test('isCompiledSchemaStale treats null/empty caches as stale', async () => {
  assert.equal(await isCompiledSchemaStale(null, MODELS_DIR), true);
  assert.equal(await isCompiledSchemaStale({}, MODELS_DIR), true);
});

test('isCompiledSchemaStale trusts the cache when the models dir is unreadable', async () => {
  const cached = { tables: [{ file: 'Customer.js' }] };
  assert.equal(await isCompiledSchemaStale(cached, path.join(os.tmpdir(), 'does-not-exist-xyz')), false);
});

test('compileSchemaFromModelsDir includes every in-scope model (13 tables)', async () => {
  const schema = await compileSchemaFromModelsDir(MODELS_DIR);
  const names = schema.tables.map((table) => table.name);
  for (const expected of ['Brand', 'ProductCategory', 'Campaign', 'ProductBrand']) {
    assert.ok(names.includes(expected), `expected ${expected} in compiled schema`);
  }
  assert.equal(schema.tableCount, (await modelFileNames()).length);
});

test('isCompiledSchemaStale uses the content signature to catch in-place edits', async () => {
  const fresh = await compileSchemaFromModelsDir(MODELS_DIR);
  assert.equal(typeof fresh.sourceSignature, 'string');
  // A cache whose signature matches the current model sources is not stale...
  assert.equal(await isCompiledSchemaStale(fresh, MODELS_DIR), false);
  // ...but a changed signature (e.g. an edited model column/comment) is stale
  // even though the set of files is identical.
  assert.equal(await isCompiledSchemaStale({ ...fresh, sourceSignature: 'deadbeef' }, MODELS_DIR), true);
});

test('ensureCompiledSchema rebuilds when the cached schema is stale', async () => {
  const tmpSchemaPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'schema-')), 'schema.json');
  // Seed a deliberately-stale cache (the /mnt/data 10-table footgun).
  await fs.writeFile(
    tmpSchemaPath,
    JSON.stringify({ modelsDir: '/mnt/data/work/repo/models', tables: [{ name: 'Customer', file: 'Customer.js' }] }),
    'utf8'
  );

  const schema = await ensureCompiledSchema({ modelsDir: MODELS_DIR, schemaPath: tmpSchemaPath, force: false });
  assert.ok(schema.tables.length > 1, 'stale cache should have been rebuilt from models/');
  assert.ok(schema.tables.map((table) => table.name).includes('Brand'));
});
