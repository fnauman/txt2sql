// Owns the lifecycle of the query runtime (compiled schema + OpenAI client +
// MariaDB pool).
//
// - Requests acquire() a lease and release() it when done, so every runtime
//   knows how many requests are using it.
// - refresh() (the admin schema refresh) builds a new runtime and swaps it in;
//   the old one is retired and its pool closed only when its in-flight count
//   reaches zero, or after `retireGraceMs` (longer than the request deadline).
//   A refresh therefore never closes a pool under a running query. A
//   non-finite `retireGraceMs` (null: requests have no deadline) means no
//   forced close at all; only close() (shutdown) closes a runtime still in use.
// - A runtime that fails to load is not cached: the next acquire() retries.
// - close() (shutdown) closes every runtime but waits at most `closeTimeoutMs`
//   (WEB_SHUTDOWN_TIMEOUT_MS): a load cannot be aborted, so one that is stalled
//   is not waited for past that; its runtime is closed as soon as it loads.
//
// Each runtime also carries a `memo` object for per-runtime caches (e.g. the
// DB schema readiness check), which disappear with the runtime.

export function createRuntimeManager({
  factory,
  retireGraceMs = 330_000,
  closeTimeoutMs = 10_000,
  logger = console,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof factory !== 'function') {
    throw new TypeError('createRuntimeManager requires a runtime factory function.');
  }

  let current = null;
  let refreshing = null;
  let closed = false;
  let nextId = 1;
  const retiring = new Set();

  function createEntry(options) {
    const entry = {
      id: nextId,
      inFlight: 0,
      retired: false,
      ready: false,
      runtime: null,
      memo: {},
      timer: null,
      closing: null,
      promise: null,
    };
    nextId += 1;
    entry.promise = Promise.resolve()
      .then(() => factory(options))
      .then((runtime) => {
        entry.runtime = runtime;
        entry.ready = true;
        return runtime;
      });
    // Failures surface through acquire()/refresh(); never as unhandled rejections.
    entry.promise.catch(() => {});
    return entry;
  }

  function shuttingDownError() {
    const error = new Error('The server is shutting down.');
    error.code = 'SHUTTING_DOWN';
    return error;
  }

  function closeEntry(entry) {
    if (entry.closing) {
      return entry.closing;
    }
    if (entry.timer) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
    entry.closing = entry.promise
      .then(
        (runtime) => runtime?.close?.(),
        () => undefined // never loaded: nothing to close
      )
      .catch((error) => {
        logger.warn?.(`[runtime] closing runtime #${entry.id} failed: ${error?.message || error}`);
      })
      .finally(() => {
        retiring.delete(entry);
      });
    return entry.closing;
  }

  function retire(entry) {
    if (entry.retired) {
      return;
    }
    entry.retired = true;
    retiring.add(entry);
    if (entry.inFlight === 0) {
      closeEntry(entry);
      return;
    }
    if (!Number.isFinite(retireGraceMs)) {
      return; // no grace limit: closed by the last release()
    }
    entry.timer = setTimer(() => {
      entry.timer = null;
      logger.warn?.(
        `[runtime] closing retired runtime #${entry.id} after the ${retireGraceMs} ms grace period with ` +
          `${entry.inFlight} request(s) still in flight.`
      );
      closeEntry(entry);
    }, retireGraceMs);
    entry.timer?.unref?.();
  }

  function currentEntry() {
    if (!current) {
      const entry = createEntry({ refreshSchema: false });
      current = entry;
      entry.promise.catch(() => {
        // Do not cache a failed load (missing key, DB down, ...): the next
        // request retries instead of replaying the failure until restart.
        if (current === entry) {
          current = null;
        }
      });
    }
    return current;
  }

  async function acquire() {
    if (closed) {
      throw shuttingDownError();
    }

    const entry = currentEntry();
    // Count the lease before awaiting, so a refresh that completes while this
    // runtime is still loading cannot close it under us.
    entry.inFlight += 1;
    let runtime;
    try {
      runtime = await entry.promise;
    } catch (error) {
      entry.inFlight -= 1;
      throw error;
    }
    if (closed) {
      // Shutdown started while this runtime was loading; it is being closed.
      entry.inFlight -= 1;
      throw shuttingDownError();
    }

    let released = false;
    return {
      runtime,
      id: entry.id,
      memo: entry.memo,
      release() {
        if (released) {
          return;
        }
        released = true;
        entry.inFlight -= 1;
        if (entry.retired && entry.inFlight === 0) {
          closeEntry(entry);
        }
      },
    };
  }

  function refresh() {
    if (closed) {
      return Promise.reject(shuttingDownError());
    }
    if (refreshing) {
      return refreshing; // coalesce concurrent refreshes
    }

    const next = createEntry({ refreshSchema: true });
    refreshing = next.promise
      .then((runtime) => {
        if (closed) {
          // Shutdown started while the new runtime was loading.
          closeEntry(next);
          throw shuttingDownError();
        }
        const previous = current;
        current = next;
        if (previous && previous !== next) {
          retire(previous);
        }
        return runtime;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function close() {
    closed = true;
    const entries = new Set(retiring);
    if (current) {
      entries.add(current);
    }
    current = null;
    // closeEntry() waits for a runtime that is still loading and then closes
    // it, so stopping the wait here never leaks it.
    const closing = Promise.all([...entries].map((entry) => closeEntry(entry)));
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimer(() => resolve(true), closeTimeoutMs);
    });
    const late = await Promise.race([closing.then(() => false), timedOut]);
    clearTimer(timer);
    if (late) {
      logger.warn?.(
        `[runtime] stopped waiting after ${closeTimeoutMs} ms for runtimes that are still loading or closing; ` +
          'each is closed as soon as it is ready.'
      );
    }
  }

  function status() {
    return {
      ready: Boolean(current?.ready),
      currentId: current?.id ?? null,
      inFlight: current?.inFlight ?? 0,
      retiring: [...retiring].map((entry) => ({ id: entry.id, inFlight: entry.inFlight })),
    };
  }

  return { acquire, refresh, close, status };
}
