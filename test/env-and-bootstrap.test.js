import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ENV_OPTIONS_WITH_VALUES,
  getPositionalArgs,
  loadEnvironment,
  resolveEnvPath,
} from '../src/env.js';
import { mapColumnTypeToMariaDb } from '../src/mariadb-bootstrap.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('resolveEnvPath accepts --dotenv <path> and --dotenv=<path> ahead of env vars', () => {
  const env = { ENV_FILE: '/tmp/ignored.env', ENV_DIR: '/tmp/also-ignored', USE_HOME_ENV: '1' };
  assert.equal(resolveEnvPath(['--dotenv', './config/dev.env'], { env }), path.resolve('config/dev.env'));
  assert.equal(resolveEnvPath(['--dotenv=./config/dev.env'], { env }), path.resolve('config/dev.env'));
  assert.equal(resolveEnvPath(['--dotenv=~/x.env'], { env }), path.join(os.homedir(), 'x.env'));
});

test('resolveEnvPath falls back to ENV_FILE / ENV_DIR / USE_HOME_ENV, then defaultPath, then ./.env', () => {
  assert.equal(resolveEnvPath([], { env: { ENV_FILE: './a.env', ENV_DIR: '/tmp/b' } }), path.resolve('a.env'));
  assert.equal(resolveEnvPath([], { env: { ENV_DIR: '/tmp/b' } }), path.join('/tmp/b', '.env'));
  assert.equal(resolveEnvPath([], { env: { USE_HOME_ENV: '1' } }), path.join(os.homedir(), '.env'));
  // The web server passes the repo-root .env as its default; env vars still win.
  assert.equal(resolveEnvPath([], { env: {}, defaultPath: '/srv/app/.env' }), '/srv/app/.env');
  assert.equal(resolveEnvPath([], { env: { ENV_FILE: '/x/y.env' }, defaultPath: '/srv/app/.env' }), '/x/y.env');
  assert.equal(resolveEnvPath([], { env: {} }), path.join(process.cwd(), '.env'));
});

test('resolveEnvPath rejects the Node-reserved --env-file flag with a pointer to --dotenv', () => {
  for (const argv of [['--env-file', 'x.env'], ['--env-file=x.env']]) {
    assert.throws(() => resolveEnvPath(argv, { env: {} }), /reserved by Node\.js.*--dotenv/);
  }
});

test('loadEnvironment loads the selected file without overriding existing values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txt2sql-env-'));
  const file = path.join(dir, 'app.env');
  fs.writeFileSync(file, 'FROM_FILE=1\nALREADY_SET=from-file\n');
  try {
    const env = { ALREADY_SET: 'from-shell' };
    const info = await loadEnvironment([`--dotenv=${file}`], { env });
    assert.deepEqual(info, { loaded: true, path: file, candidate: file });
    assert.equal(env.FROM_FILE, '1');
    assert.equal(env.ALREADY_SET, 'from-shell');

    const missing = await loadEnvironment([], { env: {}, defaultPath: path.join(dir, 'missing.env') });
    assert.equal(missing.loaded, false);
    assert.equal(missing.candidate, path.join(dir, 'missing.env'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: Node (20.6+) scans the whole command line for --env-file, even
// after the script path, and exits "node: <path>: not found" before the script
// runs. --dotenv must reach the script untouched.
test('a CLI script receives --dotenv=<missing path> instead of Node intercepting it', () => {
  const missing = path.join(os.tmpdir(), 'txt2sql-definitely-missing', 'none.env');
  const result = spawnSync(process.execPath, ['scripts/resolve-master-data.js', `--dotenv=${missing}`], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: os.tmpdir() },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /node: .*not found/);
  // The script itself ran: no question was given, so it prints its usage.
  assert.match(result.stderr, /Pass a question to resolve/);
  assert.match(result.stderr, /--dotenv <path>/);
});

test('CLI usage strings document --dotenv', () => {
  for (const script of ['scripts/basic.js', 'scripts/optimized.js']) {
    const result = spawnSync(process.execPath, [script, '--help'], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, HOME: os.tmpdir() },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, `${script} --help failed: ${result.stderr}`);
    assert.match(result.stdout, /--dotenv <path>/);
    assert.match(result.stdout, /QUERY_STATEMENT_TIMEOUT_MS/);
  }
});

test('getPositionalArgs skips env-source option values', () => {
  assert.deepEqual(
    getPositionalArgs(['top', '--dotenv', '/x/y.env', 'customers', '--env-dir=/cfg'], [...ENV_OPTIONS_WITH_VALUES]),
    ['top', 'customers']
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
