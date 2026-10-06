import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The experiment write-ups (docs/experiments/) quote numbers that commands
// reproduce; these checks keep the commands pointed at the right recording.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_SCOPE_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs/experiments/01-schema-scope.md'), 'utf8');

function section(markdown, heading) {
  const start = markdown.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `missing section ${heading}`);
  const rest = markdown.slice(start + heading.length + 2);
  // The next ## / ### heading (a "# " line is a comment in a bash block).
  const next = rest.search(/\n#{2,6} /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function reproduceCommands() {
  const block = /```bash\n([\s\S]*?)```/.exec(section(SCHEMA_SCOPE_DOC, '### Reproduce'));
  assert.ok(block, 'the Reproduce section has a bash block');
  return block[1].split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

test('experiment 01: the historical rescore arms rescore the previous (retrieved-scope) baseline, extracted from its commit', () => {
  const commands = reproduceCommands();
  const extract = commands.map((line) => /^git show ([0-9a-f]{7,40}):eval\/baselines\/gpt-4o-mini\.json > (\S+)$/.exec(line)).find(Boolean);
  assert.ok(extract, 'a command extracts the previous baseline with git show <commit>:eval/baselines/gpt-4o-mini.json > <file>');
  const [, commit, extracted] = extract;

  const rescores = commands.filter((line) => line.includes('--rescore'));
  assert.deepEqual(
    rescores.map((line) => line.replace(/ npm run eval -- --rescore .*$/, '')),
    ['SCHEMA_SCOPE=retrieved', 'SCHEMA_SCOPE=retrieved SCHEMA_WIDEN_ON_DEMAND=1', 'SCHEMA_SCOPE=full'],
    'one rescore per arm of the table'
  );
  for (const line of rescores) {
    assert.ok(line.endsWith(`--rescore ${extracted}`), `${line} rescores the extracted baseline`);
  }
  // The gate check of the current baseline stays, separately.
  assert.ok(commands.includes('npm run eval -- --offline --gate'));

  // The commit is the one the rescore section names, and (when the history is
  // available: CI clones shallowly) holds the retrieved-scope baseline the
  // live-results table compares with.
  assert.match(section(SCHEMA_SCOPE_DOC, '### Rescore of the committed baseline under each scope'), new RegExp(`at commit \`${commit}\``));
  let recorded;
  try {
    recorded = JSON.parse(
      execFileSync('git', ['show', `${commit}:eval/baselines/gpt-4o-mini.json`], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    );
  } catch {
    return;
  }
  const baselineRow = /\| Git sha \/ prompt version \| `([0-9a-f]+)` \/ `([0-9a-f]+)` \|/.exec(SCHEMA_SCOPE_DOC);
  assert.ok(baselineRow, 'the live-results table names the baseline git sha and prompt version');
  assert.ok(recorded.gitSha.startsWith(baselineRow[1]), `${commit} holds the baseline recorded at ${baselineRow[1]}`);
  assert.ok(String(recorded.provenance?.promptVersion).startsWith(baselineRow[2]));
});
