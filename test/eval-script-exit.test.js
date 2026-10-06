import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELPER = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/eval/script-exit.js')).href;

// Runs `body` (the main function's source) through runScriptMain in a child process.
function runChild(mainSource, options = '{ label: "probe" }') {
  const source = `import { runScriptMain } from ${JSON.stringify(HELPER)};\nrunScriptMain(${mainSource}, ${options});\n`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', source], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('a main() that never settles (its event loop drained) exits 2 with a message, never 0', async () => {
  // A pending promise with nothing scheduled: what a database read that never
  // settles looks like to Node.
  const result = await runChild('() => new Promise(() => {})');
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /probe: stopped before finishing: work was still pending with nothing left to run/);
});

test('a settled main() sets its own exit code; a rejection goes through onError', async () => {
  assert.equal((await runChild('async () => 0')).code, 0);
  assert.equal((await runChild('async () => undefined')).code, 0);
  assert.equal((await runChild('async () => 1')).code, 1);
  assert.equal((await runChild('async () => { await new Promise((r) => setTimeout(r, 50)); return 0; }')).code, 0);
  const rejected = await runChild('async () => { throw new Error("boom"); }', '{ label: "probe", onError: (error) => { console.error("handled " + error.message); return 1; } }');
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /handled boom/);
  const unhandled = await runChild('async () => { throw new Error("boom"); }');
  assert.equal(unhandled.code, 2);
  assert.match(unhandled.stderr, /probe failed: boom/);
});
