import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The basic and optimized CLIs print the model configuration's notices under
// their `Model:` header line, as the eval header and the web startup log do.
// The scripts run for real, offline: a preload swaps the database connection
// and the LLM client for fakes (test/fixtures/offline-pipeline-preload.mjs).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preload = pathToFileURL(path.join(repoRoot, 'test/fixtures/offline-pipeline-preload.mjs')).href;
const BOTH_KEYS_NOTE =
  '  note: OPENAI_API_KEY and OPENROUTER_API_KEY are both set: OPENAI_API_KEY is the key sent to openrouter.ai (unset OPENAI_API_KEY to use OPENROUTER_API_KEY).';

function runCli(script, extraEnv) {
  const result = spawnSync(process.execPath, ['--import', preload, script, 'How many customers are there?'], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      // Load no env file: only what the test sets.
      ENV_FILE: path.join(os.tmpdir(), 'txt2sql-definitely-missing', 'none.env'),
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `${script}: ${result.error?.message}`);
  return result;
}

function headerLines(stdout) {
  const lines = stdout.split('\n');
  const index = lines.findIndex((line) => line.startsWith('Model: '));
  assert.notEqual(index, -1, `no Model: line in\n${stdout}`);
  return lines.slice(index, index + 2);
}

for (const script of ['scripts/basic.js', 'scripts/optimized.js']) {
  test(`${script} prints the model notices beside its header`, () => {
    const both = runCli(script, { OPENAI_API_KEY: 'sk-test-not-a-key', OPENROUTER_API_KEY: 'sk-or-test-not-a-key' });
    const [model, note] = headerLines(both.stdout);
    assert.equal(model, 'Model: model gpt-4o-mini (default); reasoning effort unset (default); endpoint openrouter.ai (OpenRouter, require_parameters on)');
    assert.equal(note, BOTH_KEYS_NOTE);
    assert.match(both.stdout, /offline test client/, 'the question ran into the fake client');

    // No notice: the header is the Model: line alone, as before.
    const one = runCli(script, { OPENROUTER_API_KEY: 'sk-or-test-not-a-key' });
    const [, next] = headerLines(one.stdout);
    assert.equal(next, `Schema file: ${path.join(repoRoot, 'generated/schema.json')}`);
    assert.doesNotMatch(one.stdout, /note:/);
  });
}
