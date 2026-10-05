import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { request } from './helpers/server-harness.js';

// WEB-1 / EVAL-ENG-6 regression: settings that exist ONLY in the env file must
// take effect. The server is spawned with a minimal environment (env -i style:
// PATH, HOME and ENV_FILE only), so nothing can leak in from the shell, and no
// database or OpenAI key is configured: requests that need them must fail
// cleanly.

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForOutput(child, pattern, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; output so far:\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}:\n${output}`));
    });
  });
}

test('main.js applies WEB_* settings that exist only in the env file', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const token = 'only-in-env-file-token-123';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txt2sql-main-'));
  const envFile = path.join(dir, 'server.env');
  fs.writeFileSync(
    envFile,
    [`WEB_API_TOKEN=${token}`, `WEB_API_PORT=${port}`, 'WEB_MAX_QUESTION_LENGTH=12', 'WEB_RATE_LIMIT_MAX=3', ''].join('\n')
  );

  const child = spawn(process.execPath, ['src/server/main.js'], {
    cwd: appRoot,
    env: { PATH: process.env.PATH, HOME: dir, ENV_FILE: envFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  try {
    // The port from the env file is honored.
    await waitForOutput(child, /\[config\] env file:/);
    assert.match(output, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`));
    assert.match(output, new RegExp(`env file: ${envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /auth=on/);
    assert.match(output, /maxQuestionLength=12/);
    assert.match(output, /rateLimit=3\/60000ms/);

    const health = await request(port, { path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.authRequired, true);
    assert.equal(health.json.openAiConfigured, false);
    assert.ok(!('database' in health.json), 'no diagnostics for anonymous callers');
    assert.equal((await request(port, { path: '/api/health?deep=1' })).status, 401);

    const authorized = { authorization: `Bearer ${token}` };

    // Auth from the env file is enforced (no rate-limit slot is spent on 401s).
    const anonymous = await request(port, { method: 'POST', path: '/api/query', body: { question: 'hi' } });
    assert.equal(anonymous.status, 401);

    // The question-length limit from the env file applies (request 1 of 3).
    const tooLong = await request(port, { method: 'POST', path: '/api/query', headers: authorized, body: { question: 'thirteen chars' } });
    assert.equal(tooLong.status, 413);
    assert.equal(tooLong.json.error.code, 'QUESTION_TOO_LONG');

    // A request that needs OpenAI fails cleanly: typed infra error, no stack (2 of 3).
    const noKey = await request(port, { method: 'POST', path: '/api/query', headers: authorized, body: { question: 'hi' } });
    assert.equal(noKey.status, 503);
    assert.equal(noKey.json.errorStage, 'infra');
    assert.equal(noKey.json.errorCode, 'OPENAI_NOT_CONFIGURED');
    assert.doesNotMatch(noKey.text, /\bat .*\.js:\d+/);

    // The rate limit from the env file applies: the 4th counted request is 429.
    assert.equal((await request(port, { method: 'POST', path: '/api/query', headers: authorized, body: { question: 'hi' } })).status, 503);
    const limited = await request(port, { method: 'POST', path: '/api/query', headers: authorized, body: { question: 'hi' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'RATE_LIMITED');

    // Graceful shutdown on SIGTERM.
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /\[server\] received SIGTERM/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main.js refuses to start on an invalid setting with a clear one-shot error', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txt2sql-main-bad-'));
  const envFile = path.join(dir, 'bad.env');
  fs.writeFileSync(envFile, 'WEB_API_PORT=eighty\nWEB_RATE_LIMIT_MAX=-5\n');
  try {
    const child = spawn(process.execPath, ['src/server/main.js'], {
      cwd: appRoot,
      env: { PATH: process.env.PATH, HOME: dir, ENV_FILE: envFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /Invalid web server configuration/);
    assert.match(stderr, /WEB_API_PORT/);
    assert.match(stderr, /WEB_RATE_LIMIT_MAX/);
    assert.doesNotMatch(stderr, /\bat .*\.js:\d+/, 'no stack trace for a config error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
