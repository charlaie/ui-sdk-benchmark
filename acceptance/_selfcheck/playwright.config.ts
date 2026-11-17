import { defineConfig } from '@playwright/test'

// Unit checks for acceptance/helpers.ts on hand-written pages: npx playwright test --config acceptance/_selfcheck/playwright.config.ts
export default defineConfig({ testDir: '.', reporter: 'list', use: { browserName: 'chromium' } })
