import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5055',
    browserName: 'chromium',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    geolocation: { latitude: 33.91, longitude: -117.89, accuracy: 10 },
    permissions: ['geolocation', 'camera'],
  },
  webServer: {
    command: 'node test/browser-server.js',
    url: 'http://127.0.0.1:5055',
    reuseExistingServer: false,
  },
  reporter: 'list',
});
