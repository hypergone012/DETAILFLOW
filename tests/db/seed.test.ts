import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateBusiness } from '@detailflow/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedTenant } from '../../scripts/tenant/seed.ts'
import { asService, connect, type Sql } from './harness.ts'

const TENANTS = join(import.meta.dirname, '../../tenants')
const business = (slug: string) =>
  validateBusiness(JSON.parse(readFileSync(join(TENANTS, slug, 'business.json'), 'utf8')), {
    assetExists: (p) => existsSync(join(TENANTS, slug, p)),
  }).business!

let sql: Sql
beforeAll(() => {
  sql = connect()
})
afterAll(() => sql.end())

interface StorefrontRow {
  tenant: { slug: string; status: string; timezone: string; currency: string }
  services: Array<{ slug: string; price_from_minor: number; variants: Array<{ vehicle_class: string; price_from_minor: number }> }>
}

describe('seed', () => {
  it('seeds both demo tenants idempotently', async () => {
    const g1 = await seedTenant(sql, business('graphite'))
    const i1 = await seedTenant(sql, business('ice-lab'))
    const g2 = await seedTenant(sql, business('graphite'))
    expect(g2).toBe(g1)
    const count = async (id: string) => (await sql<{ n: number }[]>`select count(*)::int as n from public.services where tenant_id = ${id}`)[0]!.n
    expect(await count(g1)).toBe(7)
    expect(await count(i1)).toBe(4)
  })

  it('storefront exposes only public data, prices in kopecks from config', async () => {
    const [row] = await asService(sql, (tx) => tx<{ s: StorefrontRow }[]>`select private.get_storefront('graphite') as s`)
    const s = row!.s
    expect(s.tenant).toMatchObject({ slug: 'graphite', status: 'demo', timezone: 'Europe/Moscow', currency: 'RUB' })
    const wash = s.services.find((x) => x.slug === 'detailing-wash')!
    expect(wash.price_from_minor).toBe(350000)
    expect(wash.variants.find((v) => v.vehicle_class === 'suv')!.price_from_minor).toBe(450000)
    expect(JSON.stringify(s)).not.toMatch(/telegram_chat_id|tenant_id|internal_notes|max_active/)
    const [none] = await asService(sql, (tx) => tx<{ s: unknown }[]>`select private.get_storefront('does-not-exist') as s`)
    expect(none!.s).toBeNull()
  })

  it('removing a service from the config deactivates it instead of deleting', async () => {
    const b = business('ice-lab')
    const id = await seedTenant(sql, { ...b, services: b.services.slice(1) })
    const rows = await sql<{ slug: string; active: boolean }[]>`select slug, active from public.services where tenant_id = ${id}`
    expect(rows.find((r) => r.slug === b.services[0]!.slug)!.active).toBe(false)
    await seedTenant(sql, b)
  })
})
