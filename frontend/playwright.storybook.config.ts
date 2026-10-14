import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.STORYBOOK_TEST_PORT ?? 6006);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './story-tests',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  // Missing baselines must fail, including in CI; updates are an explicit review step.
  updateSnapshots: 'none',
  // Playwright's default with the project name left out, so the checked-in
  // baselines keep their names under the projects below.
  snapshotPathTemplate:
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}',
  retries: process.env.CI ? 1 : 0,
  outputDir: 'test-results/storybook',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/storybook' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  // The Keystone specs stay in this CI run, at the viewport and timeout of their
  // focused config (`playwright.keystone.config.ts`), which also records artifacts.
  projects: [
    { name: 'stories', testIgnore: 'keystone*.spec.ts' },
    {
      name: 'keystone',
      testMatch: 'keystone*.spec.ts',
      timeout: 60_000,
      use: { viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    command: `vite preview --outDir storybook-static --port ${port} --strictPort --host 127.0.0.1`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
