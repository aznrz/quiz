// Playwright config for exams-quiz e2e tests.
// Static site served by python http.server on port 8000.

const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.PORT || 8000;
const baseURL = process.env.BASE_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 1000,
  expect: { timeout: 5 * 1000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `python -m http.server ${PORT}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30 * 1000,
  },
});
