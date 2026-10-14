import { defineConfig, devices } from '@playwright/test';

// UI_TEST_PORT starts a dev server of this checkout on that port and fails if the port
// is taken, instead of reusing whatever already listens on the default 5173.
const ownPort = process.env.UI_TEST_PORT;
const port = Number(ownPort ?? 5173);
const url = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Bound Chromium load on shared development machines; CI keeps Playwright's
  // default. Each test keeps an isolated browser context.
  workers: process.env.CI ? undefined : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: url,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: `VITE_ENABLE_DEMO=true npm run dev${ownPort ? ` -- --port ${port} --strictPort` : ''}`,
    url,
    reuseExistingServer: !process.env.CI && !ownPort,
  },
});
