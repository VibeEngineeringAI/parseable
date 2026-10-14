import { defineConfig, devices } from '@playwright/test';

const artifacts = process.env.KEYSTONE_NATIVE_RUN_ARTIFACTS;
if (!artifacts || !process.env.KEYSTONE_NATIVE_URL || !process.env.KEYSTONE_NATIVE_ID) {
  throw new Error(
    'Use npm run test:keystone-native: the launcher owns the isolated fixture and build.',
  );
}
if (new URL(process.env.KEYSTONE_NATIVE_URL).hostname !== '127.0.0.1') {
  throw new Error('Native fixture URL must be loopback.');
}
export default defineConfig({
  testDir: './e2e-live',
  testMatch: 'keystone-native-readiness.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  outputDir: `${artifacts}/browser`,
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifacts}/results.json` }],
    ['html', { open: 'never', outputFolder: `${artifacts}/report` }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.KEYSTONE_NATIVE_URL,
    trace: 'on',
    video: 'on',
    screenshot: 'on',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
});
