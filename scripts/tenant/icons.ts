/**
 * Rasterises each tenant's logo into PWA icons (192/512 "any" + 512 maskable)
 * with Chromium. Output is committed: tenants/{slug}/assets/icons/*.png
 *   pnpm tenant:icons [slug…]
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { BACKGROUND_HEX } from '@detailflow/config'
import { TENANTS_DIR, loadTenant, tenantSlugs } from './load.ts'

const slugs = process.argv.slice(2).length ? process.argv.slice(2) : tenantSlugs()
const browser = await chromium.launch()
try {
  for (const slug of slugs) {
    const b = loadTenant(slug).business
    if (!b?.branding.logo) continue
    const svg = readFileSync(join(TENANTS_DIR, slug, b.branding.logo), 'utf8')
    const out = join(TENANTS_DIR, slug, 'assets', 'icons')
    mkdirSync(out, { recursive: true })
    for (const [name, size, logoShare] of [['icon-192.png', 192, 0.62], ['icon-512.png', 512, 0.62], ['maskable-512.png', 512, 0.5]] as const) {
      const page = await browser.newPage({ viewport: { width: size, height: size } })
      await page.setContent(`<html><body style="margin:0;background:${BACKGROUND_HEX};display:grid;place-items:center;width:${size}px;height:${size}px">
        <div style="width:${Math.round(size * logoShare)}px;height:${Math.round(size * logoShare)}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`)
      await page.screenshot({ path: join(out, name), omitBackground: false })
      await page.close()
    }
    console.log(`icons: ${slug}`)
  }
} finally {
  await browser.close()
}
