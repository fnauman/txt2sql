import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearSemanticLayerCache, loadSemanticLayerSync, reloadSemanticLayerSync } from '../src/semantic-layer.js';

test('semantic layer cache can be cleared and reloaded for long-running processes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'text-to-sql-semantic-layer-'));
  const semanticLayerPath = path.join(tmpDir, 'semantic-layer.json');

  await fs.writeFile(
    semanticLayerPath,
    JSON.stringify({
      version: 1,
      entities: [{ name: 'product', synonyms: ['sku'], preferred_tables: ['Product'] }],
    }),
    'utf8'
  );

  clearSemanticLayerCache(semanticLayerPath);
  const first = loadSemanticLayerSync({ filePath: semanticLayerPath });
  assert.equal(first.version, 1);
  assert.deepEqual(first.entities[0].synonyms, ['sku']);

  await fs.writeFile(
    semanticLayerPath,
    JSON.stringify({
      version: 2,
      entities: [{ name: 'product', synonyms: ['product'], preferred_tables: ['Product'] }],
    }),
    'utf8'
  );

  const cached = loadSemanticLayerSync({ filePath: semanticLayerPath });
  assert.equal(cached.version, 1);
  assert.deepEqual(cached.entities[0].synonyms, ['sku']);

  const reloaded = reloadSemanticLayerSync({ filePath: semanticLayerPath });
  assert.equal(reloaded.version, 2);
  assert.deepEqual(reloaded.entities[0].synonyms, ['product']);
});
