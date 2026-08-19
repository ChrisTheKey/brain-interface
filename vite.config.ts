import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Brain Interface runs on port 3000. That is a hard requirement, so
// `strictPort` is on: if 3000 is occupied the server fails loudly instead of
// silently moving to another port. Override deliberately with `PORT=…`.
// ZERO (the app-server) runs on its own port and is never proxied through
// here: the browser talks to it directly over the WebSocket URL from the env.
const port = Number(process.env.PORT ?? 3000);
// `HOST=0.0.0.0` exposes the dev server to the local network (phone → laptop).
const host = process.env.HOST ?? '127.0.0.1';

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port,
    strictPort: true,
  },
  preview: {
    host,
    port,
    strictPort: true,
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
