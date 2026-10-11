import { defineConfig, devices } from '@playwright/test';

// The production build behind a small server that mounts it like Parseable does.
export default defineConfig({
  testDir: './e2e-prod',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results/prod',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/prod' }]],
  use: {
    baseURL: 'http://127.0.0.1:4180',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    // Demo data lets pages render without a Parseable server behind them.
    command:
      'VITE_ENABLE_DEMO=true vite build --base=./ --outDir dist-e2e --emptyOutDir --logLevel warn && node e2e-prod/server.mjs',
    url: 'http://127.0.0.1:4180',
    // Always rebuild, so the run never tests a stale bundle.
    reuseExistingServer: false,
  },
});
