import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Port of the API server in `npm run dev` (same variable the server reads). */
const apiPort = process.env.PORT ?? '8080';

export default defineConfig({
  root: dir('.'),
  plugins: [svelte()],
  resolve: {
    alias: { '@shared': dir('../shared') },
  },
  // Pre-bundle dayjs and its German locale together, so the locale registers on the same dayjs instance.
  optimizeDeps: { include: ['dayjs', 'dayjs/locale/de.js'] },
  build: {
    outDir: dir('../dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    // CSP `script-src 'self'`: no inline scripts in index.html (the polyfill is not needed by modern browsers).
    modulePreload: { polyfill: false },
    // Small assets as files, never as data: URIs inside scripts.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // SSE (`/api/events`) streams through http-proxy unbuffered; Origin is passed on unchanged,
      // so PUBLIC_URL must be the Vite URL (http://localhost:5173) in development.
      '/api': { target: `http://127.0.0.1:${apiPort}` },
    },
  },
});
