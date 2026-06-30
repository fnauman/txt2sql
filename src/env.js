import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function resolveEnvPath(argv = process.argv.slice(2)) {
  const cliEnvFile = getOption(argv, '--env-file');
  const cliEnvDir = getOption(argv, '--env-dir');
  const cliUseHomeEnv = hasFlag(argv, '--use-home-env');
  const envFile = process.env.ENV_FILE || null;
  const envDir = process.env.ENV_DIR || null;
  const useHomeEnv = process.env.USE_HOME_ENV === '1';

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

  return path.join(process.cwd(), '.env');
}

export async function loadEnvironment(argv = process.argv.slice(2)) {
  const filePath = resolveEnvPath(argv);
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

  dotenvConfig({ path: filePath, override: false });
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
