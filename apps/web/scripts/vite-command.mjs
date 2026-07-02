import fs from 'node:fs';
import path from 'node:path';

export function getViteCommandCandidates(appRoot, platform = process.platform) {
  const viteShim = platform === 'win32' ? 'vite.cmd' : 'vite';

  return [
    path.resolve(appRoot, 'node_modules/.bin', viteShim),
    path.resolve(appRoot, '../../node_modules/.bin', viteShim),
  ];
}

export function resolveViteCommand({ appRoot, platform = process.platform, existsSync = fs.existsSync }) {
  if (!appRoot) {
    throw new TypeError('appRoot is required to resolve the Vite command');
  }

  const candidates = getViteCommandCandidates(appRoot, platform);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
