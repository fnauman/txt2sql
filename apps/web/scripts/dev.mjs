import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvironment } from '../../../src/env.js';
import { loadWebConfig } from '../src/server/config.js';
import { resolveDevSettings } from '../src/server/dev-settings.js';
import { resolveViteCommand } from './vite-command.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');
// vite is often hoisted to the repo-root node_modules under npm workspaces, so the
// vite bin shim may live there rather than in apps/web/node_modules. Prefer the
// workspace copy, fall back to the hoisted root copy.
const viteCommand = resolveViteCommand({ appRoot, existsSync: fs.existsSync });

// Load the same env file the API server will use, so both children agree on the
// ports: the API listens on WEB_API_PORT, Vite serves WEB_FRONTEND_PORT and
// proxies /api to the API (VITE_API_PROXY overrides the target).
let envInfo;
let config;
try {
  envInfo = await loadEnvironment(process.argv.slice(2), { defaultPath: path.resolve(repoRoot, '.env') });
  config = loadWebConfig(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let devSettings;
try {
  devSettings = resolveDevSettings(config, process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Pin the server to the env file resolved here (it was already loaded into
  // childEnv; dotenv never overrides, so this only keeps reporting accurate).
  ...(envInfo.loaded ? { ENV_FILE: envInfo.path } : {}),
};

const children = [
  spawn(process.execPath, ['src/server/main.js'], {
    cwd: appRoot,
    stdio: 'inherit',
    env: childEnv,
  }),
  // No --host override here: a CLI --host would beat vite.config.ts. Let the
  // config decide (loopback by default, WEB_FRONTEND_HOST to expose on a LAN).
  // The port and the /api proxy target come from the loaded web config.
  spawn(viteCommand, devSettings.viteArgs, {
    cwd: appRoot,
    stdio: 'inherit',
    env: {
      ...childEnv,
      VITE_API_PROXY: devSettings.proxyTarget,
    },
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
