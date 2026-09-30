import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateBusiness, type Business } from '@detailflow/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activate, activationCheck, createTenantFromTemplate, exportTenant } from '../../scripts/tenant/pipeline.ts'
import { loadTenant } from '../../scripts/tenant/load.ts'
import { seedTenant } from '../../scripts/tenant/seed.ts'
import { connect, createAuthUser, type Sql } from './harness.ts'

const TENANTS = join(import.meta.dirname, '../../tenants')
let sql: Sql
let dir: string

beforeAll(() => {
  sql = connect()
  dir = mkdtempSync(join(tmpdir(), 'df-tenants-'))
  cpSync(join(TENANTS, '_template'), join(dir, '_template'), { recursive: true })
})
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await sql.end()
})

const read = (slug: string) => JSON.parse(readFileSync(join(dir, slug, 'business.json'), 'utf8')) as Business
const write = (slug: string, b: Business) => writeFileSync(join(dir, slug, 'business.json'), JSON.stringify(b, null, 2))

describe('tenant pipeline', () => {
  it('new: clones the template into a valid draft config', () => {
    createTenantFromTemplate({ slug: 'north-shine', name: 'North Shine', timezone: 'Asia/Novosibirsk', accent: '#7fd18b', dir })
    const r = loadTenant('north-shine', dir)
    expect(r.errors).toEqual([])
    expect(r.business).toMatchObject({ slug: 'north-shine', name: 'North Shine', status: 'draft', timezone: 'Asia/Novosibirsk' })
    expect(() => createTenantFromTemplate({ slug: 'north-shine', name: 'x', dir })).toThrow(/already exists/)
    expect(() => createTenantFromTemplate({ slug: 'Bad Slug', name: 'x', dir })).toThrow(/invalid slug/)
    expect(() => createTenantFromTemplate({ slug: 'low-contrast', name: 'x', accent: '#222222', dir })).toThrow(/contrast/)
  })

  it('activate: blocked by demo artwork, missing phone and missing owner; then goes live', async () => {
    const b = read('north-shine')
    await seedTenant(sql, { ...b, status: 'demo' })
    const blocked = await activationCheck(sql, 'north-shine', b)
    expect(blocked.ok).toBe(false)
    expect(blocked.problems.join('\n')).toMatch(/demoArtwork/)
    expect(blocked.problems.join('\n')).toMatch(/contacts.phone/)
    expect(blocked.problems.join('\n')).toMatch(/no owner/)

    write('north-shine', { ...b, branding: { ...b.branding, demoArtwork: false }, contacts: { ...b.contacts, phone: '+73832000000' } })
    const [t] = await sql<{ id: string }[]>`select id from public.tenants where slug = 'north-shine'`
    const owner = await createAuthUser(sql, 'owner@north-shine.test')
    await sql`insert into public.tenant_members (tenant_id, user_id, role) values (${t!.id}, ${owner}, 'owner')`

    const live = await activate(sql, 'north-shine', dir)
    expect(live.problems).toEqual([])
    expect(live.warnings.join()).toMatch(/Telegram/)
    const [row] = await sql`select status from public.tenants where slug = 'north-shine'`
    expect(row!.status).toBe('active')
    expect(read('north-shine').status).toBe('active')
  })

  it('export: DB -> business.json round-trips, including edits made in the DB', async () => {
    const b = loadTenant('north-shine', dir).business!
    await sql`update public.services set price_from_minor = 777700 where slug = 'detailing-wash' and tenant_id = (select id from public.tenants where slug = 'north-shine')`
    const out = await exportTenant(sql, 'north-shine', b)
    expect(validateBusiness(out, { assetExists: () => true }).errors).toEqual([])
    expect(out.services.find((s) => s.slug === 'detailing-wash')!.priceFrom).toBe(7777)
    const { services: _a, ...restOut } = out
    const { services: _b, ...restIn } = b
    expect(restOut).toEqual(restIn)
    expect(out.services.map((s) => s.slug)).toEqual(b.services.map((s) => s.slug))
  })
})
