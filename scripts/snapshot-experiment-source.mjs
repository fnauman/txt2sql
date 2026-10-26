// Archive current source for a NEW run. Never use this to relabel an old run.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveGitState, resolveSourceVersion, sha256Hex } from '../src/eval/provenance.js';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2];
if (!label || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(label)) throw new Error('Supply a short experiment label, e.g. exp06-local-model-pilot.');
const source = await resolveSourceVersion(root);
if (!source.sha256) throw new Error('Cannot identify the source tree.');
const git = await resolveGitState(root);
const directory = path.join(root, 'generated/experiment-sources', label, source.sha256);
await fs.mkdir(directory, { recursive: true });
const destination = path.join(directory, 'source.tar.gz');
try { await fs.access(destination); throw new Error('This immutable snapshot already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2sql-source-list-'));
try {
  const list = path.join(temporary, 'files');
  await fs.writeFile(list, source.files.filter(file => file.sha256 !== null).map(file => file.path).join('\0') + '\0');
  await exec('tar', ['--create', '--gzip', '--file', destination, '--directory', root, '--null', '--no-recursion', '--files-from', list]);
  const after = await resolveSourceVersion(root);
  if (after.sha256 !== source.sha256) {
    await fs.unlink(destination);
    throw new Error('Source changed while archiving; no valid snapshot was saved.');
  }
  const manifest = { capturedAt: new Date().toISOString(), label, kind: 'current-source-checkpoint', historicalRunIdentity: false, git, source, archiveSha256: sha256Hex(await fs.readFile(destination)) };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ directory, label, git, sourceVersion: source.sha256, archiveSha256: manifest.archiveSha256 }));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
