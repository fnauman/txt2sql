import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getViteCommandCandidates, resolveViteCommand } from '../scripts/vite-command.mjs';

const appRoot = path.resolve('/repo/apps/web');

test('getViteCommandCandidates checks Windows command shims before selecting a fallback', () => {
  assert.deepEqual(getViteCommandCandidates(appRoot, 'win32'), [
    path.resolve(appRoot, 'node_modules/.bin/vite.cmd'),
    path.resolve(appRoot, '../../node_modules/.bin/vite.cmd'),
  ]);
});

test('getViteCommandCandidates checks extensionless shims outside Windows', () => {
  assert.deepEqual(getViteCommandCandidates(appRoot, 'linux'), [
    path.resolve(appRoot, 'node_modules/.bin/vite'),
    path.resolve(appRoot, '../../node_modules/.bin/vite'),
  ]);
});

test('resolveViteCommand finds a hoisted Windows command shim', () => {
  const hoistedViteCommand = path.resolve(appRoot, '../../node_modules/.bin/vite.cmd');
  const checked = [];

  const viteCommand = resolveViteCommand({
    appRoot,
    platform: 'win32',
    existsSync(candidate) {
      checked.push(candidate);
      return candidate === hoistedViteCommand;
    },
  });

  assert.equal(viteCommand, hoistedViteCommand);
  assert.deepEqual(checked, [
    path.resolve(appRoot, 'node_modules/.bin/vite.cmd'),
    hoistedViteCommand,
  ]);
});

test('resolveViteCommand keeps extensionless Vite shims outside Windows', () => {
  const hoistedVite = path.resolve(appRoot, '../../node_modules/.bin/vite');

  assert.equal(
    resolveViteCommand({
      appRoot,
      platform: 'linux',
      existsSync(candidate) {
        return candidate === hoistedVite;
      },
    }),
    hoistedVite
  );
});

test('resolveViteCommand defaults to the workspace shim for the active platform', () => {
  assert.equal(
    resolveViteCommand({
      appRoot,
      platform: 'win32',
      existsSync() {
        return false;
      },
    }),
    path.resolve(appRoot, 'node_modules/.bin/vite.cmd')
  );
});

test('resolveViteCommand requires an app root', () => {
  assert.throws(() => resolveViteCommand({}), {
    name: 'TypeError',
    message: 'appRoot is required to resolve the Vite command',
  });
});
