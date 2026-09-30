import { defineConfig, devices } from '@playwright/test'

/**
 * Production build served by the Cloudflare Pages runtime (wrangler pages dev
 * / workerd): SPA fallback, generated _headers (CSP, caching), service worker.
 * Backend: the local stack, as in playwright.config.ts.
 */
export default defineConfig({
  testDir: 'tests/pages',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { ...devices['Pixel 7'], browserName: 'chromium', baseURL: 'http://127.0.0.1:8788', locale: 'ru-RU' },
  webServer: [
    {
      command: 'DF_ALLOWED_ORIGINS=http://127.0.0.1:8788 DF_DISPATCH_INTERVAL_MS=0 pnpm -s functions:serve',
      url: 'http://127.0.0.1:54321/functions/v1/public-api/storefront/graphite',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm -s build && WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler pages dev apps/web/dist --port 8788 --ip 127.0.0.1',
      url: 'http://127.0.0.1:8788',
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
})
