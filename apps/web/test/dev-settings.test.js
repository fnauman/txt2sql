import assert from 'node:assert/strict';
import test from 'node:test';

import { loadWebConfig } from '../src/server/config.js';
import { resolveDevSettings, resolveViteProxyTarget } from '../src/server/dev-settings.js';

test('web:dev follows the configured API and frontend ports instead of 8787/5173', () => {
  const settings = resolveDevSettings(loadWebConfig({ WEB_API_PORT: '9100', WEB_FRONTEND_PORT: '5300' }), {});
  assert.equal(settings.apiOrigin, 'http://127.0.0.1:9100');
  assert.equal(settings.proxyTarget, 'http://127.0.0.1:9100');
  assert.deepEqual(settings.viteArgs, ['--port', '5300', '--strictPort']);
});

test('web:dev dials loopback for a wildcard bind and brackets IPv6 hosts', () => {
  assert.equal(resolveDevSettings(loadWebConfig({ WEB_API_HOST: '0.0.0.0' }), {}).apiOrigin, 'http://127.0.0.1:8787');
  assert.equal(resolveDevSettings(loadWebConfig({ WEB_API_HOST: '::1' }), {}).apiOrigin, 'http://[::1]:8787');
});

test('an explicit VITE_API_PROXY still wins, and a random API port is rejected', () => {
  const config = loadWebConfig({});
  assert.equal(resolveDevSettings(config, { VITE_API_PROXY: 'http://10.0.0.5:8787' }).proxyTarget, 'http://10.0.0.5:8787');
  assert.throws(() => resolveDevSettings(loadWebConfig({ WEB_API_PORT: '0' }), {}), /WEB_API_PORT=0/);
});

test('vite.config proxy fallback follows WEB_API_PORT when VITE_API_PROXY is unset', () => {
  assert.equal(resolveViteProxyTarget({ WEB_API_PORT: '9100' }), 'http://127.0.0.1:9100');
  assert.equal(resolveViteProxyTarget({ WEB_API_PORT: '9100', WEB_API_HOST: '0.0.0.0' }), 'http://127.0.0.1:9100');
  assert.equal(resolveViteProxyTarget({ WEB_API_PORT: '9100', WEB_API_HOST: '::1' }), 'http://[::1]:9100');
  // VITE_API_PROXY wins; 8787 is the last resort for unset or unusable ports.
  assert.equal(resolveViteProxyTarget({ VITE_API_PROXY: 'http://10.0.0.5:9000', WEB_API_PORT: '9100' }), 'http://10.0.0.5:9000');
  assert.equal(resolveViteProxyTarget({}), 'http://127.0.0.1:8787');
  assert.equal(resolveViteProxyTarget({ WEB_API_PORT: '0' }), 'http://127.0.0.1:8787');
  assert.equal(resolveViteProxyTarget({ WEB_API_PORT: '8e3' }), 'http://127.0.0.1:8787');
});
