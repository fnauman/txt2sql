import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeManager } from '../src/server/runtime-manager.js';

const silent = { warn() {}, log() {} };

function createFactory({ failFirst = false } = {}) {
  const created = [];
  let calls = 0;
  const factory = async (options) => {
    calls += 1;
    if (failFirst && calls === 1) {
      throw Object.assign(new Error('OPENAI_API_KEY is required.'), { code: 'OPENAI_NOT_CONFIGURED' });
    }
    const runtime = {
      id: created.length + 1,
      options,
      closed: 0,
      async close() {
        runtime.closed += 1;
      },
    };
    created.push(runtime);
    return runtime;
  };
  return { factory, created, calls: () => calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('concurrent acquires share one runtime load', async () => {
  const { factory, created } = createFactory();
  const manager = createRuntimeManager({ factory, logger: silent });
  const [a, b] = await Promise.all([manager.acquire(), manager.acquire()]);
  assert.equal(created.length, 1);
  assert.equal(a.runtime, b.runtime);
  assert.deepEqual(created[0].options, { refreshSchema: false });
  assert.equal(manager.status().inFlight, 2);
  a.release();
  a.release(); // idempotent
  b.release();
  assert.equal(manager.status().inFlight, 0);
  assert.equal(manager.status().ready, true);
});

test('a failed runtime load is not cached: the next acquire retries', async () => {
  const { factory, created, calls } = createFactory({ failFirst: true });
  const manager = createRuntimeManager({ factory, logger: silent });
  await assert.rejects(manager.acquire(), { code: 'OPENAI_NOT_CONFIGURED' });
  assert.equal(manager.status().ready, false);

  const lease = await manager.acquire();
  assert.equal(calls(), 2);
  assert.equal(lease.runtime, created[0]);
  lease.release();
});

test('refresh retires the old runtime only after its in-flight requests release it', async () => {
  const { factory, created } = createFactory();
  const manager = createRuntimeManager({ factory, logger: silent });
  const inFlight = await manager.acquire();
  const oldRuntime = inFlight.runtime;

  const fresh = await manager.refresh();
  assert.deepEqual(fresh.options, { refreshSchema: true });
  await tick();
  assert.equal(oldRuntime.closed, 0, 'still in use: not closed');
  assert.deepEqual(manager.status().retiring, [{ id: inFlight.id, inFlight: 1 }]);

  // New requests get the new runtime while the old one drains.
  const next = await manager.acquire();
  assert.equal(next.runtime, fresh);
  next.release();

  inFlight.release();
  await tick();
  assert.equal(oldRuntime.closed, 1, 'closed once the last request finished');
  assert.equal(fresh.closed, 0);
  assert.equal(created.length, 2);
});

test('an idle runtime is closed right away on refresh', async () => {
  const { factory, created } = createFactory();
  const manager = createRuntimeManager({ factory, logger: silent });
  (await manager.acquire()).release();
  await manager.refresh();
  await tick();
  assert.equal(created[0].closed, 1);
});

test('a retired runtime is force-closed after the grace period', async () => {
  const { factory, created } = createFactory();
  const timers = [];
  const manager = createRuntimeManager({
    factory,
    logger: silent,
    retireGraceMs: 1234,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  const stuck = await manager.acquire();
  await manager.refresh();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1234);
  timers[0].fn();
  await tick();
  assert.equal(created[0].closed, 1);
  stuck.release(); // a late release does not close twice
  await tick();
  assert.equal(created[0].closed, 1);
});

test('without a grace period a retired runtime waits for its last lease; shutdown still closes it', async () => {
  const { factory, created } = createFactory();
  const timers = [];
  const manager = createRuntimeManager({
    factory,
    logger: silent,
    retireGraceMs: null, // the web server's setting when WEB_REQUEST_TIMEOUT_MS=0
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  const longRunning = await manager.acquire();
  await manager.refresh();
  assert.equal(timers.length, 0, 'no forced close is scheduled');
  await tick();
  assert.equal(created[0].closed, 0, 'not closed under the running request');
  longRunning.release();
  await tick();
  assert.equal(created[0].closed, 1, 'closed once its last lease was released');

  // Shutdown is the one place a runtime is closed with a lease still held.
  const held = await manager.acquire();
  await manager.refresh();
  assert.equal(timers.length, 0);
  await manager.close();
  assert.equal(created[1].closed, 1);
  assert.equal(created[2].closed, 1);
  held.release();
});

test('concurrent refreshes coalesce, and a failed refresh keeps the current runtime', async () => {
  let fail = false;
  const created = [];
  const manager = createRuntimeManager({
    logger: silent,
    factory: async (options) => {
      if (fail) {
        throw new Error('models/ failed to compile');
      }
      const runtime = { options, close: async () => {} };
      created.push(runtime);
      return runtime;
    },
  });
  (await manager.acquire()).release();
  const [one, two] = await Promise.all([manager.refresh(), manager.refresh()]);
  assert.equal(one, two);
  assert.equal(created.length, 2);

  fail = true;
  await assert.rejects(manager.refresh(), /failed to compile/);
  const lease = await manager.acquire();
  assert.equal(lease.runtime, one, 'still serving the last good runtime');
  lease.release();
});

test('close() closes current and retiring runtimes and refuses new leases', async () => {
  const { factory, created } = createFactory();
  const manager = createRuntimeManager({ factory, logger: silent });
  const held = await manager.acquire();
  await manager.refresh();
  await manager.close();
  assert.deepEqual(
    created.map((runtime) => runtime.closed),
    [1, 1]
  );
  held.release();
  await assert.rejects(manager.acquire(), { code: 'SHUTTING_DOWN' });
  await assert.rejects(manager.refresh(), { code: 'SHUTTING_DOWN' });
});

// The lease must be counted BEFORE acquire() awaits the load: otherwise a
// refresh that finishes while runtime #1 is still loading retires #1 with an
// in-flight count of 0 and closes it under the request waiting on it.
test('a refresh that completes while the first runtime is loading never closes it under a waiting request', async () => {
  const loads = [];
  const manager = createRuntimeManager({
    logger: silent,
    factory: (options) => {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      const runtime = {
        id: loads.length + 1,
        options,
        closed: 0,
        async close() {
          runtime.closed += 1;
        },
      };
      loads.push({ runtime, resolve: () => resolve(runtime) });
      return promise;
    },
  });

  const waiting = manager.acquire(); // runtime #1 starts loading
  await tick();
  const refreshed = manager.refresh(); // runtime #2 starts loading
  await tick();
  assert.equal(loads.length, 2);

  loads[1].resolve(); // #2 is ready first and replaces #1
  assert.equal(await refreshed, loads[1].runtime);
  loads[0].resolve(); // #1 finishes loading afterwards

  const lease = await waiting;
  assert.equal(lease.runtime, loads[0].runtime, 'the waiting request keeps the runtime it started on');
  await tick();
  assert.equal(lease.runtime.closed, 0, 'not closed while the lease is held');
  assert.deepEqual(manager.status().retiring, [{ id: 1, inFlight: 1 }]);

  lease.release();
  await tick();
  assert.equal(loads[0].runtime.closed, 1, 'closed once the waiting request is done');
  assert.equal(loads[1].runtime.closed, 0);
});

// --- Shutdown is bounded and closes every runtime it knows about -------------

function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Loads that finish only when the test says so.
function createDeferredFactory() {
  const loads = [];
  const factory = (options) =>
    new Promise((resolve) => {
      const runtime = {
        id: loads.length + 1,
        options,
        closed: 0,
        async close() {
          runtime.closed += 1;
        },
      };
      loads.push({ runtime, resolve: () => resolve(runtime) });
    });
  return { factory, loads };
}

test('close() does not hang on a stalled runtime load; that runtime is closed as soon as it loads', async () => {
  const { factory, loads } = createDeferredFactory();
  const manager = createRuntimeManager({ factory, logger: silent, closeTimeoutMs: 20 });
  const waiting = manager.acquire(); // the load stalls (e.g. a schema compile or DB that hangs)
  await tick();

  assert.equal(await settlesWithin(manager.close().then(() => 'closed'), 500), 'closed');
  assert.equal(loads[0].runtime.closed, 0);

  loads[0].resolve(); // the load finishes after shutdown
  await assert.rejects(waiting, { code: 'SHUTTING_DOWN' }, 'no lease on a runtime that is being closed');
  await tick();
  assert.equal(loads[0].runtime.closed, 1, 'closed as soon as it finished loading');
});

test('close() waits for a refresh that is still loading and closes its new runtime', async () => {
  const { factory, loads } = createDeferredFactory();
  const manager = createRuntimeManager({ factory, logger: silent, closeTimeoutMs: 1000 });
  const first = manager.acquire();
  await tick();
  loads[0].resolve();
  (await first).release();

  const refreshed = manager.refresh(); // the new runtime is still loading
  await tick();
  let closedAll = false;
  const closing = manager.close().then(() => {
    closedAll = true;
  });
  await tick();
  assert.equal(closedAll, false, 'shutdown waits for the runtime the refresh is building');

  loads[1].resolve();
  await settlesWithin(closing, 500);
  assert.equal(loads[1].runtime.closed, 1, 'closed before close() resolved');
  assert.equal(loads[0].runtime.closed, 1);
  await assert.rejects(refreshed, { code: 'SHUTTING_DOWN' });
});
