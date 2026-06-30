import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const viteBin = path.resolve(appRoot, 'node_modules/.bin/vite');
const viteCommand = process.platform === 'win32' ? `${viteBin}.cmd` : viteBin;

const children = [
  spawn(process.execPath, ['src/server/index.js'], {
    cwd: appRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'development',
    },
  }),
  // No --host override here: a CLI --host would beat vite.config.ts. Let the
  // config decide (loopback by default, WEB_FRONTEND_HOST to expose on a LAN).
  spawn(viteCommand, [], {
    cwd: appRoot,
    stdio: 'inherit',
    env: process.env,
  }),
];

let shuttingDown = false;
function stopAll(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal)) {
      stopAll(code || 1);
    }
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
