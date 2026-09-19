import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const webPort = Number.parseInt(process.env.EGE_WEB_PORT ?? '5173', 10);
const apiPort = Number.parseInt(process.env.EGE_PORT ?? '4317', 10);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    restoreMocks: true,
    // The interaction-heavy suites (App, ProviderSettings, TracePanel) drive
    // userEvent against a full jsdom render. Run alone they finish in well
    // under a second each, but 28 files sharing the machine starve them past
    // vitest's 5s default and they fail as timeouts rather than assertions.
    // Budget for the contended case; fast machines are unaffected.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
