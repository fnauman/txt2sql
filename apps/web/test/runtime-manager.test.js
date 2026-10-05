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
