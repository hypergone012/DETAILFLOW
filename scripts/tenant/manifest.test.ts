import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateBusiness } from '@detailflow/config'
import { describe, expect, it } from 'vitest'
import { buildManifest } from './manifest.ts'

const TENANTS = join(import.meta.dirname, '../../tenants')
const load = (slug: string) => validateBusiness(JSON.parse(readFileSync(join(TENANTS, slug, 'business.json'), 'utf8')), { assetExists: () => true }).business!

describe('per-studio web app manifest', () => {
  it.each(['graphite', 'ice-lab'])('%s installs as its own app with committed icons', (slug) => {
    const m = buildManifest(load(slug), { hasIcons: true })
    expect(m).toMatchObject({ id: `/s/${slug}/`, scope: `/s/${slug}/`, start_url: `/s/${slug}/`, display: 'standalone', lang: 'ru' })
    expect(m.short_name.length).toBeLessThanOrEqual(12)
    const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`)
    expect(sizes).toEqual(['192x192:any', '512x512:any', '512x512:maskable'])
    for (const icon of m.icons) expect(existsSync(join(TENANTS, slug, 'assets', icon.src.replace(`/tenants/${slug}/`, '')))).toBe(true)
  })

  it('two studios never share an app identity', () => {
    expect(buildManifest(load('graphite'), { hasIcons: true }).id).not.toBe(buildManifest(load('ice-lab'), { hasIcons: true }).id)
  })
})
