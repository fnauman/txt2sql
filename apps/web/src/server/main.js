import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvironment } from '../../../../src/env.js';

// API server entrypoint. Order matters: load the .env file FIRST, then build the
// validated config from the now-complete environment, then create the app.
// (index.js used to read settings at import time, i.e. before .env was loaded,
// so .env-only values such as WEB_API_TOKEN were silently ignored.) The rest of
// the server is imported dynamically after the env is loaded as a second guard
// against any future module-level env read.
//
// Env source: --dotenv <path> | --env-dir <dir> | --use-home-env, or
// ENV_FILE / ENV_DIR / USE_HOME_ENV=1; default is the repository-root .env.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

async function main() {
  const envInfo = await loadEnvironment(process.argv.slice(2), { defaultPath: path.resolve(repoRoot, '.env') });

  const { describeWebConfig, loadWebConfig } = await import('./config.js');
  const { createApp } = await import('./index.js');
  const { formatListenUrl, installSignalHandlers, logQueryUserPrivileges, startServer } = await import('./lifecycle.js');

  const config = loadWebConfig(process.env);
  const { app, close } = createApp({ config, envInfo, logger: console });

  let lifecycle;
  try {
    lifecycle = await startServer({ app, config, onClose: close, logger: console });
  } catch (error) {
    await close();
    throw error;
  }

  console.log(`Text-to-SQL API listening on ${formatListenUrl(lifecycle.address)}`);
  console.log(`[config] ${describeWebConfig(config)}`);
  console.log(`[config] env file: ${envInfo.loaded ? envInfo.path : `none (looked for ${envInfo.candidate})`}`);

  if (!config.loopback) {
    // A non-loopback bind with no token silently exposes /api/query (LLM spend +
    // demo DB access) to the network.
    if (!config.authEnabled) {
      console.warn(
        `[security] WEB_API_HOST is "${config.host}" (non-loopback) but WEB_API_TOKEN is unset: ` +
          '/api/query (LLM cost + demo DB access) is exposed with NO authentication. ' +
          'Set WEB_API_TOKEN before exposing this server on a shared network.'
      );
    }
    if (!config.hostCheck) {
      console.warn(
        `[security] WEB_API_HOST is "${config.host}" and WEB_ALLOWED_HOSTS is empty, so the Host header is not checked ` +
          '(no DNS-rebinding protection) and browser requests are accepted only from WEB_ALLOWED_ORIGINS ' +
          '(the same-origin exemption needs a validated Host). List the names clients use in WEB_ALLOWED_HOSTS.'
      );
    }
    if (config.allowDebug) {
      console.warn('[security] WEB_ALLOW_DEBUG is on for a non-loopback bind: prompts, raw model output and stack traces are returned to clients.');
    }
  } else if (config.allowDebug && config.allowedHosts.length > 0 && !config.authEnabled) {
    // Extra Host names on a loopback bind usually mean a same-host reverse proxy
    // that publishes this server under another name.
    console.warn(
      `[security] WEB_ALLOWED_HOSTS (${config.allowedHosts.join(', ')}) lets other names reach this loopback server, and debug ` +
        'output (prompts, raw model output, stack traces) is allowed without a token. Set WEB_ALLOW_DEBUG=0 or WEB_API_TOKEN ' +
        'if those names are reachable by others.'
    );
  }

  installSignalHandlers({ shutdown: lifecycle.shutdown, logger: console });

  // Least-privilege check for the query user; logs only, never blocks startup.
  void logQueryUserPrivileges({ logger: console, database: config.database.name });
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
