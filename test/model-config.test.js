import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_MODEL, resolveModelName } from '../src/model-config.js';
import { parseEvalArgs } from '../scripts/eval.js';
import { DEFAULT_WEB_CONFIG, loadWebConfig } from '../apps/web/src/server/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relative));
    } else if (/\.(?:c|m)?[jt]s$/.test(entry.name)) {
      files.push(relative);
    }
  }
  return files;
}

// Where the default model's id may appear outside a comment: the one
// definition, and its price row (a price, not a default).
const ALLOWED_DEFAULT_LITERALS = {
  'src/model-config.js': /^export const DEFAULT_MODEL = 'gpt-4o-mini';$/,
  'src/pricing.js': /^ {2}'gpt-4o-mini': Object\.freeze\(\{$/,
};

test('DEFAULT_MODEL is the one default model: no other gpt-4o-mini literal in src/, scripts/, the web server or CI', () => {
  const offenders = [];
  const files = [...listSourceFiles('src'), ...listSourceFiles('scripts'), ...listSourceFiles('apps/web/src/server')];
  for (const file of files) {
    for (const [index, line] of fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').entries()) {
      if (!line.includes(DEFAULT_MODEL)) {
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      if (ALLOWED_DEFAULT_LITERALS[file]?.test(line)) {
        continue;
      }
      offenders.push(`${file}:${index + 1}: ${trimmed}`);
    }
  }
  // The CI workflow asks the runner for the default baseline instead of
  // repeating the default in shell (${MODEL_NAME:-...}).
  for (const [index, line] of fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n').entries()) {
    if (line.includes(DEFAULT_MODEL) && !line.trim().startsWith('#')) {
      offenders.push(`.github/workflows/ci.yml:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'use DEFAULT_MODEL (src/model-config.js) instead of repeating the default model');
  // The allow-list entries still exist (a stale entry would hide nothing).
  for (const [file, pattern] of Object.entries(ALLOWED_DEFAULT_LITERALS)) {
    assert.ok(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').some((line) => pattern.test(line)), `${file} still has its allowed line`);
  }
});

test('resolveModelName: --model, then MODEL_NAME, then DEFAULT_MODEL, each with its source', () => {
  assert.deepEqual(resolveModelName({}), { model: DEFAULT_MODEL, source: 'default' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: '  ' }), { model: DEFAULT_MODEL, source: 'default' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: ' gpt-6-luna ' }), { model: 'gpt-6-luna', source: 'MODEL_NAME' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: 'gpt-6-luna' }, { flag: 'openai/gpt-6-luna' }), { model: 'openai/gpt-6-luna', source: '--model' });
  assert.deepEqual(resolveModelName({ MODEL_NAME: 'gpt-6-luna' }, { flag: null }), { model: 'gpt-6-luna', source: 'MODEL_NAME' });
});

test('every entry point falls back to the same DEFAULT_MODEL', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-4o-mini');
  assert.equal(parseEvalArgs([], { env: {} }).model, DEFAULT_MODEL);
  assert.equal(DEFAULT_WEB_CONFIG.model, DEFAULT_MODEL);
  assert.equal(loadWebConfig({}).model, DEFAULT_MODEL);
});
