import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionList, LEGACY_SENSITIVE_KEYS, purgeLegacySessionData } from '../src/client/storage.ts';

function withStorage(t: { after: (callback: () => void) => void }, storage: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
}

test('legacy query text and pinned rows are removed without reading them or touching theme', (t) => {
  const values = new Map<string, string>([
    [LEGACY_SENSITIVE_KEYS[0], '["private question"]'],
    [LEGACY_SENSITIVE_KEYS[1], '[{"rows":[{"customer":"private"}]}]'],
    ['text-to-sql.theme', 'dark'],
    ['another-app', 'keep'],
  ]);
  withStorage(t, {
    getItem: () => assert.fail('sensitive legacy values must never be read'),
    setItem: () => assert.fail('session data must never be persisted'),
    removeItem: (key: string) => values.delete(key),
  });
  const session = createSessionList<string>();
  assert.deepEqual(session.getSnapshot(), []);
  session.update(() => ['new private question']);
  assert.deepEqual(session.getSnapshot(), ['new private question']);
  assert.deepEqual([...values], [['text-to-sql.theme', 'dark'], ['another-app', 'keep']]);
});

test('each page-owned session starts empty, stays in memory and clears its own data', (t) => {
  withStorage(t, {
    getItem: () => assert.fail('no persistent reads'),
    setItem: () => assert.fail('no persistent writes'),
    removeItem: () => {},
  });
  const first = createSessionList<{ rows: { value: string }[] }>();
  const second = createSessionList<{ rows: { value: string }[] }>();
  let changes = 0;
  const unsubscribe = first.subscribe(() => changes++);
  first.update(() => [{ rows: [{ value: 'sensitive result' }] }]);
  assert.equal(changes, 1);
  assert.deepEqual(second.getSnapshot(), []);
  first.clear();
  assert.deepEqual(first.getSnapshot(), []);
  assert.equal(changes, 2);
  unsubscribe();
  first.clear();
  assert.equal(changes, 2);
});

test('blocked storage never prevents session use and a failed deletion does not skip the other key', (t) => {
  const attempted: string[] = [];
  withStorage(t, {
    removeItem: (key: string) => {
      attempted.push(key);
      if (key === LEGACY_SENSITIVE_KEYS[0]) throw new Error('storage blocked');
    },
  });
  const session = createSessionList<string>();
  assert.deepEqual(attempted, [...LEGACY_SENSITIVE_KEYS]);
  session.update(() => ['works without storage']);
  session.clear();
  assert.deepEqual(session.getSnapshot(), []);
  assert.deepEqual(attempted.slice(2), [...LEGACY_SENSITIVE_KEYS]);
});

test('an unavailable localStorage getter and a non-browser environment are harmless', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { throw new Error('blocked'); } } });
  assert.doesNotThrow(purgeLegacySessionData);
  Reflect.deleteProperty(globalThis, 'window');
  assert.doesNotThrow(purgeLegacySessionData);
  const session = createSessionList<string>();
  session.update(() => ['works']);
  assert.deepEqual(session.getSnapshot(), ['works']);
});
