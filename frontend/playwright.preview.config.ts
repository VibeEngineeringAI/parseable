import { defineConfig, devices } from '@playwright/test';

// Behaviour that exists only in a production build, such as Vite's stylesheet
// preloading for lazy pages. Builds with the `/next/` base into dist-preview,
// so the dist that is packaged is left alone, and serves it with vite preview.
export default defineConfig({
  testDir: './e2e-preview',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results/preview',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/preview' }]],
  use: {
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command:
      'vite build --base=/next/ --outDir dist-preview --emptyOutDir --logLevel warn && vite preview --base=/next/ --outDir dist-preview --port 4317 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4317/next/',
    // Always the current source, never a server left from an earlier build.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
