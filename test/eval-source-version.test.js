import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSourceVersion } from '../src/eval/provenance.js';

test('source versions distinguish dirty trees at the same commit and ignore credentials and generated outputs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'generated'));
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const value = 1;');
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_VALUE=never-read-this');
  await fs.writeFile(path.join(root, 'src/.env.secret'), 'PRIVATE_VALUE=also-never-read');
  await fs.writeFile(path.join(root, 'generated/output.json'), '{"rows":[1]}');
  await fs.symlink(path.join(root, '.env'), path.join(root, 'src/link.js'));
  const run = async () => ({ stdout: ['src/a.js', '.env', 'src/.env.secret', 'src/link.js', 'generated/output.json'].join('\0') });
  const first = await resolveSourceVersion(root, { run });
  assert.equal(first.status, 'captured');
  assert.deepEqual(first.files.map(f => f.path), ['src/a.js']);
  assert.equal(first.sha256, (await resolveSourceVersion(root, { run })).sha256);
  await fs.writeFile(path.join(root, '.env'), 'PRIVATE_VALUE=changed');
  assert.equal(first.sha256, (await resolveSourceVersion(root, { run })).sha256);
  await fs.writeFile(path.join(root, 'src/a.js'), 'export const value = 2;');
  assert.notEqual(first.sha256, (await resolveSourceVersion(root, { run })).sha256);
  await fs.unlink(path.join(root, 'src/a.js'));
  const deleted = await resolveSourceVersion(root, { run });
  assert.equal(deleted.files[0].sha256, null);
  assert.notEqual(first.sha256, deleted.sha256);
});

test('source capture labels missing Git and empty input sets as unavailable', async () => {
  assert.equal((await resolveSourceVersion('/nonexistent', { run: async () => { throw new Error('no git'); } })).sha256, null);
  assert.equal((await resolveSourceVersion('/nonexistent', { run: async () => ({ stdout: '.env\0' }) })).status, 'unavailable');
});

test('completion records source drift and prevents promoting a changed run', async () => {
  const { finishProvenance } = await import('../src/eval/provenance.js');
  const { baselineRefusal } = await import('../scripts/eval.js');
  const start = { source: { sha256: 'before' } };
  const same = await finishProvenance(start, { sourceState: { sha256: 'before' } });
  assert.equal(same.sourceUnchangedDuringRun, true);
  const changed = await finishProvenance(start, { sourceState: { sha256: 'after' } });
  assert.equal(changed.sourceUnchangedDuringRun, false);
  assert.match(baselineRefusal({ provenance: changed }, { code: 0, reasons: [] }), /source tree changed/);
});
