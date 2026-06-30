import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getPositionalArgs, resolveEnvPath } from '../src/env.js';
import { mapColumnTypeToMariaDb } from '../src/mariadb-bootstrap.js';

function withEnv(overrides, fn) {
  const original = new Map();

  for (const key of Object.keys(overrides)) {
    original.set(key, process.env[key]);
    const value = overrides[key];
    if (value == null) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value == null) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  }
}

test('resolveEnvPath keeps CLI env-dir ahead of ENV_FILE', () => {
  withEnv(
    {
      ENV_FILE: '/tmp/ignored.env',
      ENV_DIR: '/tmp/also-ignored',
      USE_HOME_ENV: '1',
    },
    () => {
      assert.equal(resolveEnvPath(['--env-dir', './config']), path.resolve('config/.env'));
    }
  );
});

test('resolveEnvPath keeps CLI use-home-env ahead of environment defaults', () => {
  withEnv(
    {
      ENV_FILE: '/tmp/ignored.env',
      ENV_DIR: '/tmp/also-ignored',
    },
    () => {
      assert.equal(resolveEnvPath(['--use-home-env']), path.join(os.homedir(), '.env'));
    }
  );
});

test('getPositionalArgs skips option values for expected SQL style flags', () => {
  assert.deepEqual(
    getPositionalArgs(
      [
        'show',
        'customers',
        '--expected-sql',
        'SELECT * FROM Customer',
        '--dataset',
        'core-public',
        '--dataset-file',
        'datasets/core-public.json',
      ],
      ['--expected-sql', '--dataset', '--dataset-file']
    ),
    ['show', 'customers']
  );
});

test('mapColumnTypeToMariaDb preserves commas inside JSON-encoded enum values', () => {
  assert.equal(
    mapColumnTypeToMariaDb('ENUM("N/A, not applicable", "Ready")'),
    "ENUM('N/A, not applicable', 'Ready')"
  );
});

test('mapColumnTypeToMariaDb preserves commas inside SQL-quoted enum values', () => {
  assert.equal(
    mapColumnTypeToMariaDb("ENUM('N/A, not applicable', 'it''s ready')"),
    "ENUM('N/A, not applicable', 'it''s ready')"
  );
});

test('mapColumnTypeToMariaDb keeps INTEGER(1) as INT', () => {
  assert.equal(mapColumnTypeToMariaDb('INTEGER(1)'), 'INT');
});
