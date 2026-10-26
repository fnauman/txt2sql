// Archive current source for a NEW run. Never use this to relabel an old run.
//
// The archive holds exactly the files resolveSourceVersion fingerprints. It is
// written to a temporary name and published only once it is complete and the
// source is unchanged, so a failed attempt never blocks a retry. Untracked
// files are listed and refused if they look like they hold a credential.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveGitState, resolveSourceVersion, sha256Hex } from '../src/eval/provenance.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_PATTERNS = [
  /sk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
];

const label = process.argv[2];
if (!label || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(label)) {
  throw new Error('Supply a short experiment label, e.g. exp06-local-model-pilot.');
}
const source = await resolveSourceVersion(root);
if (!source.sha256) throw new Error('Cannot identify the source tree.');
const git = await resolveGitState(root);

const untracked = new Set(
  (await exec('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout
    .split('\0')
    .filter(Boolean)
);
const archived = source.files.filter((file) => file.sha256 !== null).map((file) => file.path);
const untrackedArchived = archived.filter((name) => untracked.has(name));
for (const name of untrackedArchived) {
  const text = await fs.readFile(path.join(root, name), 'utf8');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`${name} (untracked) looks like it contains a credential; move the secret out before archiving.`);
  }
}
if (untrackedArchived.length) {
  console.error(`Archiving ${untrackedArchived.length} untracked file(s):\n  ${untrackedArchived.join('\n  ')}`);
}

const directory = path.join(root, 'generated/experiment-sources', label, source.sha256);
const destination = path.join(directory, 'source.tar.gz');
const manifestPath = path.join(directory, 'manifest.json');
await fs.mkdir(directory, { recursive: true });
for (const existing of [destination, manifestPath]) {
  try {
    await fs.access(existing);
    throw new Error(`This immutable snapshot already exists: ${existing}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-source-list-'));
const partialArchive = `${destination}.partial-${process.pid}`;
const partialManifest = `${manifestPath}.partial-${process.pid}`;
let published = false;
try {
  const list = path.join(temporary, 'files');
  await fs.writeFile(list, archived.join('\0') + '\0');
  await exec('tar', ['--create', '--gzip', '--file', partialArchive, '--directory', root, '--null', '--no-recursion', '--files-from', list]);
  const after = await resolveSourceVersion(root);
  if (after.sha256 !== source.sha256) {
    throw new Error('Source changed while archiving; no snapshot was saved.');
  }
  const manifest = {
    capturedAt: new Date().toISOString(),
    label,
    kind: 'current-source-checkpoint',
    historicalRunIdentity: false,
    git,
    source,
    untrackedFiles: untrackedArchived,
    archiveSha256: sha256Hex(await fs.readFile(partialArchive)),
  };
  await fs.writeFile(partialManifest, JSON.stringify(manifest, null, 2));
  // The manifest is published last: its presence means a complete snapshot.
  await fs.rename(partialArchive, destination);
  await fs.rename(partialManifest, manifestPath);
  published = true;
  console.log(JSON.stringify({ directory, label, git, sourceVersion: source.sha256, archiveSha256: manifest.archiveSha256 }));
} catch (error) {
  // Both paths were absent at the start, so anything there now is this attempt's.
  for (const leftover of [partialArchive, partialManifest, ...(published ? [] : [destination])]) {
    await fs.rm(leftover, { force: true });
  }
  throw error;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
