import { defineConfig, devices } from '@playwright/test';

// Opt in explicitly. This suite writes a sample dataset to the supplied server.
export default defineConfig({
  testDir: './e2e-live',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  outputDir: 'test-results/live',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/live' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PARSEABLE_LIVE_URL || 'http://127.0.0.1:8270',
    trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
});
