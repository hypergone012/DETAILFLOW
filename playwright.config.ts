import { defineConfig, devices } from '@playwright/test'

/**
 * Full-stack E2E: PostgreSQL + Supabase Auth (GoTrue) from scripts/local/stack.sh,
 * the real Edge Function handlers on Deno (dev gateway) and the Vite app.
 * globalSetup recreates the database and seeds GRAPHITE + ICE LAB.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 860 } }, testMatch: /owner|isolation/ },
  ],
  webServer: [
    {
      command: 'mkdir -p .local && rm -f .local/e2e-bot-received.jsonl && node scripts/local/bot-api-contract-server.mjs .local/e2e-bot-received.jsonl',
      url: 'http://127.0.0.1:54399/',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // All E2E traffic comes from 127.0.0.1, so the per-IP booking limit is raised here only.
      // The platform bot talks to a local Bot API contract server (demo studios never reach it).
      command: 'DF_BOOKING_RATE_LIMIT=500 DF_DISPATCH_INTERVAL_MS=1000 TELEGRAM_BOT_TOKEN=1:e2e-local-token TELEGRAM_API_BASE=http://127.0.0.1:54399 pnpm -s functions:serve',
      url: 'http://127.0.0.1:54321/functions/v1/public-api/storefront/graphite',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm -s tenant:assets && pnpm --filter @detailflow/web exec vite --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
