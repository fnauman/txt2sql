import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthCheck, HEALTH_TIMEOUT_MS, type HealthSnapshot } from '../src/client/hooks/healthCheck.ts';
import type { HealthResponse } from '../src/client/types.ts';

const ok = { openAiConfigured: true, dbConfigured: true, model: 'gpt-6-luna' } as unknown as HealthResponse;

// A load whose requests the test answers by hand; an aborted request rejects.
function controllableLoad() {
  const pending: { signal: AbortSignal; resolve: (value: HealthResponse) => void; reject: (error: Error) => void }[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<HealthResponse>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
      pending.push({ signal, resolve, reject });
    });
  return { load, pending };
}

function manualTimers() {
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
}

test('a health request that never answers becomes unavailable at the deadline', async () => {
  const { load, pending } = controllableLoad();
  const { timers, setTimer, clearTimer } = manualTimers();
  const snapshots: HealthSnapshot[] = [];
  const check = createHealthCheck(load, (snapshot) => snapshots.push(snapshot), { setTimer, clearTimer });

  const done = check.refresh();
  assert.deepEqual(snapshots.at(-1), { health: null, status: 'checking' });
  assert.equal(timers[0].ms, HEALTH_TIMEOUT_MS);
  timers[0].callback();
  await done;
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(snapshots.at(-1), { health: null, status: 'unavailable' });
  assert.equal(timers[0].cleared, true);
});

test('a failed response is unavailable and a retry that succeeds is connected', async () => {
  const { load, pending } = controllableLoad();
  const { setTimer, clearTimer } = manualTimers();
  const snapshots: HealthSnapshot[] = [];
  const check = createHealthCheck(load, (snapshot) => snapshots.push(snapshot), { setTimer, clearTimer });

  const first = check.refresh();
  pending[0].reject(new Error('Health request failed.'));
  await first;
  assert.equal(snapshots.at(-1)?.status, 'unavailable');

  const retry = check.refresh();
  assert.equal(snapshots.at(-1)?.status, 'checking');
  pending[1].resolve(ok);
  await retry;
  assert.deepEqual(snapshots.at(-1), { health: ok, status: 'connected' });
});

test('a superseded request cannot overwrite the newer result', async () => {
  const { load, pending } = controllableLoad();
  const { setTimer, clearTimer } = manualTimers();
  const snapshots: HealthSnapshot[] = [];
  const check = createHealthCheck(load, (snapshot) => snapshots.push(snapshot), { setTimer, clearTimer });

  const first = check.refresh();
  const second = check.refresh();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(ok);
  await Promise.all([first, second]);
  // The first request's abort rejection arrived after the retry started and is ignored.
  assert.deepEqual(snapshots.at(-1), { health: ok, status: 'connected' });
  assert.equal(snapshots.some((snapshot) => snapshot.status === 'unavailable'), false);
});

test('dispose aborts the request in flight and leaves the snapshot alone', async () => {
  const { load, pending } = controllableLoad();
  const { setTimer, clearTimer } = manualTimers();
  const snapshots: HealthSnapshot[] = [];
  const check = createHealthCheck(load, (snapshot) => snapshots.push(snapshot), { setTimer, clearTimer });

  const done = check.refresh();
  check.dispose();
  await done;
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(snapshots, [{ health: null, status: 'checking' }]);
});
