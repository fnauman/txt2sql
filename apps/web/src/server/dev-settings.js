// Pure helpers for scripts/dev.mjs and vite.config.ts: derive what the two dev
// children need from the same settings, so `npm run web:dev` follows
// WEB_API_PORT, WEB_API_HOST and WEB_FRONTEND_PORT instead of hard-coded
// 8787/5173.

const DEFAULT_API_PORT = 8787;

// The origin a local client should dial to reach an API bound to host:port. A
// wildcard bind is reachable on loopback, so the proxy dials a real address.
function dialOrigin(host, port) {
  const dialHost = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host;
  const hostForUrl = dialHost.includes(':') && !dialHost.startsWith('[') ? `[${dialHost}]` : dialHost;
  return `http://${hostForUrl}:${port}`;
}

export function resolveDevSettings(config, env = process.env) {
  if (config.port === 0) {
    throw new Error('WEB_API_PORT=0 (random port) is not supported by web:dev: the Vite proxy needs a fixed API port.');
  }

  const apiOrigin = dialOrigin(config.host, config.port);

  return {
    apiOrigin,
    // An explicit VITE_API_PROXY still wins (e.g. an API on another machine).
    proxyTarget: env.VITE_API_PROXY || apiOrigin,
    // --port/--strictPort pin the configured frontend port, which the API's
    // default CORS allowlist is built from; failing beats silently moving.
    viteArgs: ['--port', String(config.frontendPort), '--strictPort'],
  };
}

// The /api proxy target vite.config.ts uses. web:dev always sets
// VITE_API_PROXY; when Vite is started directly it is usually unset, so fall
// back to the API's WEB_API_HOST / WEB_API_PORT from the environment, and to
// 127.0.0.1:8787 only when those are unset or not usable. (Vite does not load
// the repository .env into process.env, so only exported values apply here.)
export function resolveViteProxyTarget(env = process.env) {
  const explicit = String(env.VITE_API_PROXY || '').trim();
  if (explicit) {
    return explicit;
  }

  const rawPort = String(env.WEB_API_PORT ?? '').trim();
  const port = /^\d+$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535 ? Number(rawPort) : DEFAULT_API_PORT;
  const host = String(env.WEB_API_HOST || '').trim() || '127.0.0.1';
  return dialOrigin(host, port);
}
