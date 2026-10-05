import { checkQueryUserPrivileges, createMariaDbConnection } from '../../../../src/pipeline.js';

// Process-level plumbing for the API server, kept apart from main.js so it can
// be tested in-process: listening with readable startup errors, graceful
// shutdown that drains in-flight requests, and the startup privilege check.

export function formatListenUrl(address) {
  if (!address || typeof address === 'string') {
    return String(address || '');
  }
  const host = address.family === 'IPv6' || address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

function describeListenError(error, config) {
  if (error?.code === 'EADDRINUSE') {
    return `Port ${config.port} on ${config.host} is already in use. Stop the other process or set WEB_API_PORT.`;
  }
  if (error?.code === 'EACCES') {
    return `Not allowed to listen on ${config.host}:${config.port}. Choose a port above 1024 with WEB_API_PORT.`;
  }
  if (error?.code === 'EADDRNOTAVAIL') {
    return `WEB_API_HOST "${config.host}" is not an address of this machine.`;
  }
  return `Could not start the API server: ${error?.message || error}`;
}

// Starts listening and returns { server, address, shutdown }. shutdown() stops
// accepting connections, lets in-flight requests (including SSE streams) finish,
// force-closes whatever is left after `timeoutMs`, then runs onClose() (which
// closes the DB pools). It resolves to { forced } and is idempotent.
export function startServer({ app, config, onClose = async () => {}, logger = console }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host);
    let inFlight = 0;
    let draining = false;

    server.on('request', (_req, res) => {
      inFlight += 1;
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          inFlight -= 1;
          if (draining) {
            // A keep-alive socket whose last request just finished would
            // otherwise hold close() open until its idle timeout.
            setImmediate(() => server.closeIdleConnections?.());
          }
        }
      };
      res.on('finish', finish);
      res.on('close', finish);
    });

    server.once('error', (error) => {
      const startupError = new Error(describeListenError(error, config), { cause: error });
      startupError.code = error?.code || 'LISTEN_FAILED';
      reject(startupError);
    });

    let shutdownPromise = null;
    function shutdown({ timeoutMs = config.shutdownTimeoutMs, reason = 'shutdown' } = {}) {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      draining = true;
      shutdownPromise = (async () => {
        logger.log?.(`[server] ${reason}: draining ${inFlight} in-flight request(s) (up to ${timeoutMs} ms)...`);
        let forced = false;
        await new Promise((resolveClose) => {
          let timer = null;
          // close() stops accepting connections and (Node >= 19) drops idle
          // keep-alive sockets; its callback fires once active requests end.
          server.close(() => {
            if (timer) {
              clearTimeout(timer);
            }
            resolveClose();
          });
          timer = setTimeout(() => {
            forced = true;
            logger.warn?.(`[server] ${inFlight} request(s) still running after ${timeoutMs} ms; closing their connections.`);
            // Destroying the sockets fires each response's 'close', which aborts
            // the request's LLM call and kills its database query.
            server.closeAllConnections?.();
          }, timeoutMs);
          timer.unref?.();
        });

        if (forced) {
          // Let the destroyed responses emit 'close' (which aborts their LLM
          // calls and kills their queries) before the pools are closed.
          const deadline = Date.now() + 1000;
          while (inFlight > 0 && Date.now() < deadline) {
            await new Promise((resolveTick) => setTimeout(resolveTick, 10));
          }
        }

        try {
          await onClose();
        } catch (error) {
          logger.warn?.(`[server] cleanup after shutdown failed: ${error?.message || error}`);
        }
        logger.log?.('[server] stopped.');
        return { forced };
      })();
      return shutdownPromise;
    }

    server.once('listening', () => {
      server.removeAllListeners('error');
      server.on('error', (error) => logger.error?.(`[server] ${error?.message || error}`));
      resolve({ server, address: server.address(), shutdown, inFlight: () => inFlight });
    });
  });
}

// SIGTERM/SIGINT drain gracefully; a second signal exits immediately. A second
// signal within `duplicateWindowMs` of the first is treated as the same request:
// Ctrl+C under `npm run web:dev` delivers SIGINT to the whole process group and
// dev.mjs then forwards SIGTERM, which must not cut the drain short.
export function installSignalHandlers({
  shutdown,
  logger = console,
  exit = (code) => process.exit(code),
  signals = ['SIGTERM', 'SIGINT'],
  target = process,
  duplicateWindowMs = 1000,
  now = Date.now,
}) {
  let receivedAt = null;
  const handler = (signal) => {
    if (receivedAt !== null) {
      if (now() - receivedAt < duplicateWindowMs) {
        logger.log?.(`[server] received ${signal} while already draining; send it again to exit immediately.`);
        return;
      }
      logger.warn?.(`[server] received ${signal} again; exiting immediately.`);
      exit(1);
      return;
    }
    receivedAt = now();
    shutdown({ reason: `received ${signal}` })
      .then(({ forced }) => exit(forced ? 1 : 0))
      .catch(() => exit(1));
  };

  for (const signal of signals) {
    target.on(signal, handler);
  }
  return () => {
    for (const signal of signals) {
      target.off(signal, handler);
    }
  };
}

// Startup check that the query user is least-privilege (the real boundary for
// model-authored SQL). Best effort and OpenAI-independent: if the database is
// not configured or reachable yet, it logs why and moves on.
export async function logQueryUserPrivileges({ logger = console, connect = () => createMariaDbConnection() } = {}) {
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    logger.warn?.(`[db] query-user privilege check skipped: ${error?.message || error}`);
    return null;
  }

  try {
    const report = await checkQueryUserPrivileges(connection);
    if (report.ok) {
      logger.log?.('[db] query user privileges: SELECT-only (ok).');
    } else {
      for (const warning of report.warnings) {
        logger.warn?.(`[db] warning: ${warning}`);
      }
    }
    return report;
  } catch (error) {
    logger.warn?.(`[db] query-user privilege check failed: ${error?.message || error}`);
    return null;
  } finally {
    await Promise.resolve(connection.end?.()).catch(() => {});
  }
}
