import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { resolveViteProxyTarget } from './src/server/dev-settings.js';

export default defineConfig({
  plugins: [react()],
  server: {
    // Default to loopback, matching the API server (WEB_API_HOST) and the docs'
    // 127.0.0.1-only posture. Set WEB_FRONTEND_HOST=0.0.0.0 (or a LAN IP) to
    // opt into network exposure for container/remote dev.
    host: process.env.WEB_FRONTEND_HOST || '127.0.0.1',
    port: 5173,
    // Allow importing the shared pure helpers from the repo-root src/ (e.g.
    // result-intelligence.js, re-run client-side for live cross-filtering).
    fs: {
      allow: ['../..'],
    },
    proxy: {
      '/api': {
        // VITE_API_PROXY (set by web:dev), else WEB_API_HOST/WEB_API_PORT,
        // else http://127.0.0.1:8787.
        target: resolveViteProxyTarget(process.env),
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
