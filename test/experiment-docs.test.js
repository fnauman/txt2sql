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

test('experiment status: the index and each write-up agree, and a write-up with a decision is not pending', () => {
  const index = fs.readFileSync(path.join(REPO_ROOT, 'docs/experiments/README.md'), 'utf8');
  const rows = [...index.matchAll(/^\| (\d+) \| \[[^\]]+\]\(([^)]+)\) \| [^|]+ \| ([^|]+) \|$/gm)];
  assert.ok(rows.length > 0, 'the index lists the experiments');
  for (const [, number, file, indexStatus] of rows) {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/experiments', file), 'utf8');
    const status = /^\*\*Status:\*\* ([^\n]+)/m.exec(doc);
    assert.ok(status, `${file} states its status`);
    assert.ok(status[1].startsWith(indexStatus.trim()), `experiment ${number}: index "${indexStatus.trim()}" vs write-up "${status[1]}"`);
    // Every write-up has a Decision section (the protocol's sections); it
    // holds a decision unless it still says the decision is pending.
    if (/^## Decision$/m.test(doc) && !/^\W*pending\b/i.test(section(doc, '## Decision').trim())) {
      assert.doesNotMatch(indexStatus, /pending/, `experiment ${number} has a decision`);
      assert.doesNotMatch(status[1], /pending/, `experiment ${number} has a decision`);
    }
  }
});

// Prose (with source comments reduced to their text) split into sentences; a
// heading or a blank line also ends one.
function sentences(text) {
  const prose = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/|\/\*\*?|\*\/?)\s?/, ''))
    .join('\n');
  return prose
    .split(/\n\s*\n|\n(?=#)|(?<=\.)\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

test('the committed baseline is described as what it recorded: its schema scope and its cost', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/baselines/gpt-4o-mini.json'), 'utf8'));
  const recordedScope = baseline.provenance.product.schemaScope;
  assert.ok(recordedScope?.effective, 'the baseline records its schema scope');

  // A sentence that ties the retrieved scope to the committed baseline is only
  // right while the baseline ran the retrieved scope; otherwise it must point
  // at the previous (retrieved-scope) baseline instead.
  if (recordedScope.effective !== 'retrieved') {
    for (const file of ['README.md', 'src/schema-scope.js', 'src/pipeline.js', 'docs/evaluation-dataset.md', 'docs/experiments/01-schema-scope.md']) {
      const stale = sentences(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')).filter(
        (sentence) => /retrieved/.test(sentence) && /committed\s+baseline/.test(sentence) && !/previous|before this experiment|1aa30a3/.test(sentence)
      );
      assert.deepEqual(stale, [], `${file} calls the retrieved scope the committed baseline, which ran ${recordedScope.effective}`);
    }
  }

  // Quoted costs of the committed baseline are its own.
  const spent = baseline.budget.spentUsd;
  const repetitions = baseline.stats.repetitions.total;
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const readmeCost = /\(the committed baseline: \$(\d+\.\d+) for (\d+) repetitions\)/.exec(readme);
  assert.ok(readmeCost, 'README quotes the committed baseline cost');
  assert.equal(readmeCost[1], spent.toFixed(2));
  assert.equal(Number(readmeCost[2]), baseline.runner.repeat);

  const guide = fs.readFileSync(path.join(REPO_ROOT, 'docs/evaluation-dataset.md'), 'utf8').replace(/\s+/g, ' ');
  const perQuestion = /committed gpt-4o-mini baseline cost \$(\d+\.\d+) per question/.exec(guide);
  assert.ok(perQuestion, 'docs/evaluation-dataset.md quotes the per-question cost');
  assert.equal(perQuestion[1], (spent / repetitions).toFixed(5));
  const measured = /`--repeat 3` about (\d+) cents \(measured: \$(\d+\.\d+)[;)]/.exec(guide);
  assert.ok(measured, 'docs/evaluation-dataset.md quotes the measured --repeat 3 cost');
  assert.equal(measured[2], spent.toFixed(4));
  assert.equal(Number(measured[1]), Math.round(spent * 100));
});
