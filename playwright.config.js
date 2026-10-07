import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: false,
  use: { baseURL: 'http://localhost:3100', browserName: 'chromium' },
  webServer: {
    command: 'node src/index.js',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: '3100',
      OPENAI_API_KEY: '',
      ELEVENLABS_API_KEY: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
    },
  },
});
