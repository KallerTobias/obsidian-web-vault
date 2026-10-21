import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const alias = { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        // Server and shared code: plain Node.
        resolve: { alias },
        test: { name: 'node', include: ['tests/server/**/*.test.ts', 'tests/shared/**/*.test.ts'] },
      },
      {
        // Frontend: stores and Svelte components in jsdom, compiled for the browser
        // (the `browser` condition makes `svelte` resolve to its client runtime, so `mount` works).
        plugins: [svelte({ configFile: false })],
        resolve: { alias, conditions: ['browser'] },
        test: { name: 'web', include: ['tests/web/**/*.test.ts'], environment: 'jsdom', setupFiles: ['tests/web/setup.ts'] },
      },
      {
        // Timing tests against the dependencies' production builds (as in the bundle): without
        // `development` among the conditions, micromark & co. skip their dev-only assertions.
        resolve: { alias },
        ssr: { resolve: { conditions: ['module', 'node'] } },
        // One file at a time: wall-clock budgets must not compete with each other.
        test: { name: 'perf', include: ['tests/perf/**/*.test.ts'], fileParallelism: false },
      },
    ],
  },
});
