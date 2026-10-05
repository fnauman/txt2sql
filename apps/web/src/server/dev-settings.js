// Pure helper for scripts/dev.mjs: derive what the two dev children need from
// the same loaded web config, so `npm run web:dev` follows WEB_API_PORT,
// WEB_API_HOST and WEB_FRONTEND_PORT instead of hard-coded 8787/5173.

export function resolveDevSettings(config, env = process.env) {
  if (config.port === 0) {
    throw new Error('WEB_API_PORT=0 (random port) is not supported by web:dev: the Vite proxy needs a fixed API port.');
  }

  // A wildcard bind is reachable on loopback; the proxy must dial a real address.
  const dialHost = ['0.0.0.0', '::', '[::]'].includes(config.host) ? '127.0.0.1' : config.host;
  const hostForUrl = dialHost.includes(':') && !dialHost.startsWith('[') ? `[${dialHost}]` : dialHost;
  const apiOrigin = `http://${hostForUrl}:${config.port}`;

  return {
    apiOrigin,
    // An explicit VITE_API_PROXY still wins (e.g. an API on another machine).
    proxyTarget: env.VITE_API_PROXY || apiOrigin,
    // --port/--strictPort pin the configured frontend port, which the API's
    // default CORS allowlist is built from; failing beats silently moving.
    viteArgs: ['--port', String(config.frontendPort), '--strictPort'],
  };
}
