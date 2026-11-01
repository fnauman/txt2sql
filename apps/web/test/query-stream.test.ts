import assert from 'node:assert/strict';
import test from 'node:test';

import { createQueryStream } from '../src/client/lib/query-stream.ts';
import { initialStreamState, streamReducer, type StreamAction } from '../src/client/lib/stream-protocol.ts';

const request = { question: 'private question', debug: false, includeInsights: true };
const encode = (event: string, data?: unknown) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(options: Parameters<typeof createQueryStream>[1]) {
  let state = initialStreamState();
  const actions: StreamAction[] = [];
  const stream = createQueryStream((action) => { actions.push(action); state = streamReducer(state, action); }, options);
  return { stream, actions, state: () => state };
}
function responseWithFrames(frames: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { frames.forEach((frame) => controller.enqueue(frame)); controller.close(); } }));
}

test('stream transport assembles results and a clear removes question, rows and debug data', async () => {
  const h = harness({ fetch: async () => responseWithFrames([
    encode('columns', { columns: [{ key: 'name', label: 'Name' }], rowCount: 1 }),
    encode('rows', { rows: [{ name: 'private row' }] }),
    encode('debug', { prompt: 'private prompt' }), encode('done'),
  ]) });
  assert.equal(await h.stream.run(request), true);
  assert.equal(h.state().status, 'done');
  assert.equal(h.state().result.rows.length, 1);
  h.stream.clear();
  assert.equal(h.state().status, 'idle');
  assert.equal(h.state().result.question, '');
  assert.deepEqual(h.state().result.rows, []);
  assert.equal(h.state().result.debug, null);
});

test('clear aborts an outstanding request and ignores a late response even when fetch ignores the abort', async () => {
  const pending = deferred<Response>();
  let signal: AbortSignal | undefined;
  const h = harness({ fetch: async (_url, init) => { signal = init?.signal as AbortSignal; return pending.promise; } });
  const done = h.stream.run(request);
  h.stream.clear();
  assert.equal(signal?.aborted, true);
  pending.resolve(responseWithFrames([encode('rows', { rows: [{ name: 'late private row' }] }), encode('done')]));
  assert.equal(await done, false);
  assert.equal(h.state().status, 'idle');
  assert.deepEqual(h.state().result.rows, []);
  assert.deepEqual(h.actions.map((a) => a.event), ['@start', '@reset']);
});

test('clear invalidates delayed transition callbacks and already queued reducer actions', async () => {
  const queued: (() => void)[] = [];
  const h = harness({
    fetch: async () => responseWithFrames([encode('rows', { rows: [{ name: 'queued private row' }] }), encode('done')]),
    transition: (work) => { queued.push(work); },
  });
  await h.stream.run(request);
  const oldRequestId = h.state().requestId;
  h.stream.clear();
  queued.forEach((work) => work());
  const reset = h.state();
  const late = streamReducer(reset, { event: 'rows', data: { rows: [{ name: 'late' }] }, requestId: oldRequestId });
  assert.equal(late, reset);
  assert.deepEqual(reset.result.rows, []);
  assert.equal(reset.status, 'idle');
});

test('a superseded request cannot overwrite a newer result or add its question to history', async () => {
  const first = deferred<Response>();
  let calls = 0;
  const h = harness({ fetch: async () => ++calls === 1 ? first.promise : responseWithFrames([encode('rows', { rows: [{ value: 'new' }] }), encode('done')]) });
  const old = h.stream.run(request);
  assert.equal(await h.stream.run({ ...request, question: 'new question' }), true);
  first.resolve(responseWithFrames([encode('rows', { rows: [{ value: 'old' }] }), encode('done')]));
  assert.equal(await old, false);
  assert.equal(h.state().result.question, 'new question');
  assert.deepEqual(h.state().result.rows, [{ value: 'new' }]);
});

test('cancelling preserves partial results while dispose ignores all late events', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const rowsArrived = deferred<void>();
  const h = harness({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    source = controller;
    controller.enqueue(encode('columns', { columns: [{ key: 'value' }] }));
    controller.enqueue(encode('rows', { rows: [{ value: 'partial' }] }));
  } })), transition: (work) => { work(); rowsArrived.resolve(); } });
  const done = h.stream.run(request);
  await rowsArrived.promise;
  h.stream.cancel();
  source.enqueue(encode('rows', { rows: [{ value: 'after cancel' }] }));
  source.close();
  assert.equal(await done, false);
  assert.equal(h.state().status, 'done');
  assert.deepEqual(h.state().result.rows, [{ value: 'partial' }]);
  h.stream.clear();
  const pending = deferred<Response>();
  const disposed = harness({ fetch: async () => pending.promise });
  const later = disposed.stream.run(request);
  disposed.stream.dispose();
  pending.resolve(responseWithFrames([encode('done')]));
  assert.equal(await later, false);
  assert.deepEqual(disposed.actions.map((a) => a.event), ['@start']);
});

test('HTTP errors preserve code/stage and incomplete streams fail visibly', async () => {
  const failed = harness({ fetch: async () => Response.json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED', stage: 'infra' } }, { status: 401 }) });
  assert.equal(await failed.stream.run(request), true);
  assert.equal(failed.state().result.errorCode, 'UNAUTHORIZED');
  assert.equal(failed.state().errorStage, 'infra');
  const incomplete = harness({ fetch: async () => responseWithFrames([encode('rows', { rows: [] })]) });
  assert.equal(await incomplete.stream.run(request), false);
  assert.equal(incomplete.state().status, 'error');
});
