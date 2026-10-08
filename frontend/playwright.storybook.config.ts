import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './story-tests',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results/storybook',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/storybook' }]],
  use: {
    baseURL: 'http://127.0.0.1:6006',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: 'vite preview --outDir storybook-static --port 6006 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:6006',
    reuseExistingServer: !process.env.CI,
  },
});
