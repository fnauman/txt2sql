import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CLI flag that picks an explicit env file. It is deliberately NOT `--env-file`:
// Node.js (20.6+) reserves that name and scans the whole command line for it,
// even after the script path, so `node scripts/x.js --env-file=/missing` exits
// with `node: /missing: not found` before the script runs.
export const DOTENV_FLAG = '--dotenv';
const RESERVED_NODE_ENV_FLAG = '--env-file';

// Env-source flags that take a value. Scripts pass these to getPositionalArgs so
// a path is never mistaken for part of a natural-language question.
export const ENV_OPTIONS_WITH_VALUES = Object.freeze([DOTENV_FLAG, '--env-dir']);

export const ENV_USAGE =
  'Env source (pick one; default ./.env): --dotenv <path> | --env-dir <dir> | --use-home-env, ' +
  'or ENV_FILE / ENV_DIR / USE_HOME_ENV=1.';

function getOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = argv.indexOf(name);
  if (index !== -1 && argv[index + 1]) {
    return argv[index + 1];
  }

  return null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function resolvePathLike(value) {
  if (!value) {
    return null;
  }

  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return path.resolve(value);
}

function assertNoReservedNodeFlag(argv) {
  const used = argv.some((arg) => arg === RESERVED_NODE_ENV_FLAG || arg.startsWith(`${RESERVED_NODE_ENV_FLAG}=`));
  if (used) {
    throw new Error(
      `${RESERVED_NODE_ENV_FLAG} is reserved by Node.js and is intercepted before the script runs. ` +
        `Use ${DOTENV_FLAG} <path> (or ENV_FILE=<path>) instead.`
    );
  }
}

// Exactly one env source is used. Precedence: CLI flags (--dotenv, --env-dir,
// --use-home-env), then env vars (ENV_FILE, ENV_DIR, USE_HOME_ENV=1), then the
// caller's `defaultPath` (the web server uses the repo-root .env), then ./.env.
export function resolveEnvPath(argv = process.argv.slice(2), { env = process.env, defaultPath = null } = {}) {
  assertNoReservedNodeFlag(argv);

  const cliEnvFile = getOption(argv, DOTENV_FLAG);
  const cliEnvDir = getOption(argv, '--env-dir');
  const cliUseHomeEnv = hasFlag(argv, '--use-home-env');
  const envFile = env.ENV_FILE || null;
  const envDir = env.ENV_DIR || null;
  const useHomeEnv = env.USE_HOME_ENV === '1';

  if (cliEnvFile) {
    return resolvePathLike(cliEnvFile);
  }

  if (cliEnvDir) {
    return path.join(resolvePathLike(cliEnvDir), '.env');
  }

  if (cliUseHomeEnv) {
    return path.join(os.homedir(), '.env');
  }

  if (envFile) {
    return resolvePathLike(envFile);
  }

  if (envDir) {
    return path.join(resolvePathLike(envDir), '.env');
  }

  if (useHomeEnv) {
    return path.join(os.homedir(), '.env');
  }

  if (defaultPath) {
    return path.resolve(defaultPath);
  }

  return path.join(process.cwd(), '.env');
}

// Loads the selected env file into `env` (process.env by default) without
// overriding variables that are already set. Programmatic callers choose a
// fallback file with `defaultPath` instead of synthesizing CLI arguments.
export async function loadEnvironment(argv = process.argv.slice(2), { env = process.env, defaultPath = null } = {}) {
  const filePath = resolveEnvPath(argv, { env, defaultPath });
  if (!fs.existsSync(filePath)) {
    return {
      loaded: false,
      path: null,
      candidate: filePath,
    };
  }

  let dotenvConfig;
  try {
    ({ config: dotenvConfig } = await import('dotenv'));
  } catch (error) {
    throw new Error(`dotenv is required to load ${filePath}: ${error.message}`);
  }

  dotenvConfig({ path: filePath, override: false, processEnv: env });
  return {
    loaded: true,
    path: filePath,
    candidate: filePath,
  };
}

export function getOptionValue(argv, name) {
  return getOption(argv, name);
}

export function hasOptionFlag(argv, name) {
  return hasFlag(argv, name);
}

export function getPositionalArgs(argv, optionsWithValues = []) {
  const skipNextFor = new Set(optionsWithValues);
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (skipNextFor.has(arg)) {
      index += 1;
      continue;
    }

    if (optionsWithValues.some((option) => arg.startsWith(`${option}=`))) {
      continue;
    }

    if (arg.startsWith('--')) {
      continue;
    }

    positional.push(arg);
  }

  return positional;
}
