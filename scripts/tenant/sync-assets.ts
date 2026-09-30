/** Copies tenants/{slug}/assets into apps/web/public/tenants/{slug} (static hosting). */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TENANTS_DIR, tenantSlugs } from './load.ts'

const OUT = join(import.meta.dirname, '../../apps/web/public/tenants')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const slug of tenantSlugs()) {
  const src = join(TENANTS_DIR, slug, 'assets')
  if (existsSync(src)) cpSync(src, join(OUT, slug), { recursive: true })
}
console.log(`synced assets for ${tenantSlugs().join(', ')}`)
