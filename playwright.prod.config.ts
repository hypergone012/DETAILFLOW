import { defineConfig, devices } from '@playwright/test'

/**
 * Production smoke. No web servers, no DB reset: runs against a deployed
 * environment described by env vars (docs/PRODUCTION.md, "Production smoke").
 *   PROD_APP_URL, PROD_SUPABASE_URL, PROD_SUPABASE_PUBLISHABLE_KEY,
 *   PROD_GRAPHITE_OWNER_EMAIL/PASSWORD, PROD_ICE_OWNER_EMAIL/PASSWORD,
 *   PROD_SMOKE_PHONE, SMOKE_LABEL
 */
const label = process.env.SMOKE_LABEL ?? 'production'
export default defineConfig({
  testDir: 'tests/prod',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: `docs/smoke/prod-e2e-${label}.json` }]],
  use: {
    ...devices['Pixel 7'],
    browserName: 'chromium',
    baseURL: process.env.PROD_APP_URL,
    locale: 'ru-RU',
    trace: 'retain-on-failure',
  },
})
