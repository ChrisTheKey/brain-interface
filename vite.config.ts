import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Brain Interface runs on port 3000. That is a hard requirement, so
// `strictPort` is on: if 3000 is occupied the server fails loudly instead of
// silently moving to another port. Override deliberately with `PORT=…`.
//
// In development Vite serves the bundle and proxies the operator's endpoints
// to the gateway, so the app is same-origin here exactly as it is in
// production: `/api`, `/ws/events` and `/ws/voice` all leave through one host.
const port = Number(process.env.PORT ?? 3000);
// `HOST=0.0.0.0` exposes the dev server to the local network (phone → laptop).
const host = process.env.HOST ?? '127.0.0.1';
// Where the dev server forwards /api and /ws. Defaults to the gateway's own
// port, so a single `npm run gateway` in another shell is all it takes.
const gateway = process.env.ZERO_GATEWAY ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      // `npm run dev` on 3000 while the gateway runs on 3001:
      //   ZERO_UI_PORT=3001 npm run gateway  &&  ZERO_GATEWAY=http://127.0.0.1:3001 npm run dev
      '/api': { target: gateway, changeOrigin: true },
      '/ws': { target: gateway.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: {
    host,
    port,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // three.js and react-three-fiber change far less often than the
          // interface does, so they get their own long-lived chunk.
          'brain-3d': ['three', '@react-three/fiber'],
        },
      },
    },
    // The 3D chunk is genuinely ~1 MB of engine and is loaded lazily; the
    // interface chunk itself stays small.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
  },
});
