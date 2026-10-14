import { defineConfig, devices } from '@playwright/test';

// Workers inherit this value, keeping reports and artifacts in the same run folder.
const runId = (process.env.KEYSTONE_RUN_ID ??= new Date().toISOString().replaceAll(':', '-'));
const artifacts = `test-results/keystone/${runId}`;

// By default the run serves this checkout's `storybook-static` on its own port and
// fails if anything already listens there, so it never tests another build.
// KEYSTONE_STORY_URL explicitly opts into a server someone else started.
const external = process.env.KEYSTONE_STORY_URL;
const port = Number(process.env.KEYSTONE_STORY_PORT ?? 6046);
const owned = `http://127.0.0.1:${port}`;

// A focused, reproducible harness run keeps successful traces and videos too.
export default defineConfig({
  testDir: './story-tests',
  testMatch: 'keystone*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  outputDir: artifacts,
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifacts}/results.json` }],
    ['html', { open: 'never', outputFolder: 'playwright-report/keystone' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    baseURL: external ?? owned,
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: external
    ? undefined
    : {
        command: `npx vite preview --outDir storybook-static --port ${port} --strictPort --host 127.0.0.1`,
        url: owned,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
