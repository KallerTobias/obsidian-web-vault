import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the built app (`npm run build`). Every test file starts its own server
 * (see `e2e/fixtures.ts`) on a copy of `e2e/fixture-vault`. `npm run e2e` runs this in the Playwright
 * Docker image (browsers + system libraries), `npm run e2e:local` directly.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    // Full Chromium (new headless) instead of the headless shell: it has the PDF viewer and WebGL.
    channel: 'chromium',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
