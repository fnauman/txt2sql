// Retrospective artifact indexing never upgrades missing historical provenance.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/eval/provenance.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file)));
const sha = file => sha256Hex(fs.readFileSync(path.join(root, file)));
const commit = ref => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const base = commit('717ec52');
const registry = { formatVersion: 1, registeredAt: new Date().toISOString(), labelsAreGitTags: false,
  note: 'Logical experiment versions. A report hash identifies an artifact; it does not recover missing source at run time. Old reports remain unchanged.',
  experiments: [
    { id: '01', version: 'exp01-schema-scope-2026-10-06', protocol: 'docs/experiments/01-schema-scope.md', candidateCommit: commit('606e0ee94531'), referenceCommit: commit('f5e6ffef21c9'), sourceEvidence: 'Commit references recorded in the historical write-up; original holdout subsequently retired.' },
    { id: '02', version: 'exp02-hints-v2-2026-10-06', protocol: 'docs/experiments/02-hints-v2.md', candidateCommit: commit('4ff6ecb'), referenceCommit: commit('e42828b'), artifact: 'eval/baselines/gpt-4o-mini.json', artifactSha256: sha('eval/baselines/gpt-4o-mini.json') },
    { id: '03', version: 'exp03-models-2026-10-07', protocol: 'docs/experiments/03-models.md', candidateCommit: commit('a57fa44'), recordedClean: true, artifact: 'eval/baselines/gpt-6-luna.low.json', artifactSha256: sha('eval/baselines/gpt-6-luna.low.json'), limitation: 'Medium-arm full recording is not in the repository; rounded published results only.' },
  ] };
for (const config of [
  { id: '04', version: 'exp04-providers-2026-10-14', protocol: 'docs/experiments/04-provider-models.md', directory: 'generated/provider-benchmark-2026-10-14/full', summary: 'docs/experiments/results/04-provider-models-summary.json' },
  { id: '05', version: 'exp05-prompt-robustness-2026-10-14', protocol: 'docs/experiments/05-prompt-robustness.md', directory: 'generated/prompt-robustness-2026-10-14', summary: 'docs/experiments/results/05-prompt-robustness-summary.json' },
]) {
  const names = fs.readdirSync(path.join(root, config.directory)).filter(name => name.endsWith('.json') && !['summary.json', 'manifest.json'].includes(name));
  const artifacts = names.map(name => {
    const file = `${config.directory}/${name}`, report = read(file);
    return { path: file, sha256: sha(file), generatedAt: report.generatedAt, model: report.model, effort: report.provenance?.product?.reasoningEffort ?? report.effort,
      recordedGit: report.provenance?.git || null, recordedSourceVersion: report.provenance?.source?.sha256 || null,
      manifestHash: report.manifestHash || null };
  });
  registry.experiments.push({ ...config, referenceCommit: base, referenceCommitEvidence: config.id === '04' ? 'Recorded by each original report; dirty working tree.' : 'Retrospective session reference only; original robustness reports did not record Git.',
    exactRunSourceRecoverable: false, limitation: 'No run-time source snapshot exists for these historical runs. The current checkpoint must not be labeled as their exact source.',
    summarySha256: sha(config.summary), artifacts });
}
const auditFile = 'generated/evaluation-review-2026-10-14/final/luna-offline.json';
if (fs.existsSync(path.join(root, auditFile))) {
  const report = read(auditFile);
  registry.experiments.push({ id: '06', version: 'exp06-evaluation-review-2026-10-14', protocol: 'docs/experiments/06-evaluation-review.md', mode: 'offline-audit-zero-model-calls', artifact: auditFile, artifactSha256: sha(auditFile), recordedGit: report.provenance.git, recordedSourceVersion: report.provenance.source.sha256, sourceUnchangedDuringRun: report.provenance.sourceUnchangedDuringRun });
}
fs.writeFileSync(path.join(root, 'docs/experiments/registry.json'), JSON.stringify(registry, null, 2) + '\n');
console.log(JSON.stringify({ experiments: registry.experiments.length, base, file: 'docs/experiments/registry.json' }));
