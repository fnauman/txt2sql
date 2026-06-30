import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveGitSha(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}
