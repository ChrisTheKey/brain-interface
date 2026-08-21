import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Brain Interface runs on port 3000. That is a hard requirement, so
// `strictPort` is on: if 3000 is occupied the server fails loudly instead of
// silently moving to another port. Override deliberately with `PORT=…`.
const port = Number(process.env.PORT ?? 3000);
// `HOST=0.0.0.0` exposes the dev server to the local network (phone → laptop).
const host = process.env.HOST ?? '127.0.0.1';

// Dev mode proxies exactly what the gateway proxies in production, so the
// browser stays same-origin in both. Without this, `npm run dev` would be the
// one situation where the bundle needs a backend address of its own — which is
// precisely the mistake this whole change removes. These values are read by
// the *dev server*, never by the browser: nothing here reaches the bundle.
const zeroApi = process.env.ZERO_API_URL ?? 'http://127.0.0.1:8000';
const zeroRuntimeWs = process.env.ZERO_RUNTIME_WS_URL ?? 'ws://127.0.0.1:8787';

const proxy = {
  '/api': { target: zeroApi, changeOrigin: true },
  // Order matters: `/ws/events` is a prefix of `/ws`, and Vite matches the
  // longest key first only if it is declared — so both are declared.
  '/ws/events': { target: zeroApi, ws: true, changeOrigin: true },
  '/ws': {
    target: zeroRuntimeWs,
    ws: true,
    changeOrigin: true,
    // The public name is `/ws`; the runtime app-server listens at its own root.
    rewrite: (path: string) => path.replace(/^\/ws\/?$/, '/'),
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port,
    strictPort: true,
    proxy,
  },
  preview: {
    host,
    port,
    strictPort: true,
    proxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
