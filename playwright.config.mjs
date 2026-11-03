import { defineConfig } from '@playwright/test'
import { makeMicrophoneFixture } from './tests/fixture-audio.mjs'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  timeout: 30000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5180',
    viewport: { width: 1366, height: 1024 },
    permissions: ['microphone'],
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${makeMicrophoneFixture()}`],
    },
    trace: 'retain-on-failure',
  },
  webServer: { command: 'pnpm dev', url: 'http://localhost:5180', reuseExistingServer: true },
})
