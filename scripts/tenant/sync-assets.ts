/**
 * Copies tenants/{slug}/assets into apps/web/public/tenants/{slug} (static
 * hosting on Cloudflare Pages) and writes each studio's web app manifest.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TENANTS_DIR, loadTenant, tenantSlugs } from './load.ts'
import { buildManifest } from './manifest.ts'

const OUT = join(import.meta.dirname, '../../apps/web/public/tenants')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const slug of tenantSlugs()) {
  const src = join(TENANTS_DIR, slug, 'assets')
  const dest = join(OUT, slug)
  if (existsSync(src)) cpSync(src, dest, { recursive: true })
  const loaded = loadTenant(slug)
  if (!loaded.business) throw new Error(`tenants/${slug}/business.json is invalid:\n  ${loaded.errors.join('\n  ')}`)
  mkdirSync(dest, { recursive: true })
  const manifest = buildManifest(loaded.business, { hasIcons: existsSync(join(src, 'icons', 'icon-512.png')) })
  writeFileSync(join(dest, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2))
}
console.log(`synced assets + manifests for ${tenantSlugs().join(', ')}`)
