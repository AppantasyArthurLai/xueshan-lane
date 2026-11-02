// @ts-check
const { defineConfig, devices } = require('@playwright/test');

const PORT = 3411;

module.exports = defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/artifacts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'iphone13-chromium',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'node server/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
    env: { PORT: String(PORT), DATA_SOURCE: 'mock', TDX_CLIENT_ID: '', TDX_CLIENT_SECRET: '' },
  },
});
