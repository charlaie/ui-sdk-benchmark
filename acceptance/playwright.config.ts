import { defineConfig } from '@playwright/test'

// Hidden acceptance suites. BASE_URL points at a built app served under a subpath, e.g.
// http://127.0.0.1:4173/app/ (runner/evaluate.mjs and scripts/test-template.mjs set it).
export default defineConfig({
  testDir: '.',
  testIgnore: ['_selfcheck/**'],
  fullyParallel: true,
  workers: Number(process.env.PW_WORKERS ?? 4),
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.BASE_URL,
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
})
