import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Brain Interface dev server defaults to port 3000. ZERO (the Codex
// app-server) runs on its own port and is never proxied through here: the
// browser talks to it directly over the WebSocket URL from the environment.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
    strictPort: false,
  },
  preview: {
    port: Number(process.env.PORT ?? 3000),
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
