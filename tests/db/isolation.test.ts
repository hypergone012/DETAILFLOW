import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMinutes, book, createTenant, hoursFromNow, type TenantFixture } from './fixtures.ts'
import { asUser, connect, errorOf, type Sql } from './harness.ts'

let sql: Sql
let a: TenantFixture
let b: TenantFixture
let bookingA: string
let bookingB: string

beforeAll(async () => {
  sql = connect()
  a = await createTenant(sql)
  b = await createTenant(sql)
  const start = hoursFromNow(72)
  bookingA = (await book(sql, { tenantId: a.id, serviceId: a.serviceId, start, end: addMinutes(start, 120), phone: '+79991110000' })).booking_id
  bookingB = (await book(sql, { tenantId: b.id, serviceId: b.serviceId, start, end: addMinutes(start, 120), phone: '+79991110000' })).booking_id
})
afterAll(() => sql.end())

const TENANT_TABLES = [
  'tenant_profiles', 'tenant_settings', 'services', 'service_variants', 'resources', 'working_hours',
  'customers', 'vehicles', 'bookings', 'resource_allocations', 'booking_events', 'notification_outbox',
  'tenant_notification_settings',
]

describe('tenant isolation under RLS', () => {
  it.each(TENANT_TABLES)('owner of A sees only A rows in %s', async (table) => {
    const rows = await asUser(sql, a.ownerId, (tx) => tx.unsafe(`select distinct tenant_id from public.${table}`))
    expect(rows.map((r) => r.tenant_id)).toEqual([a.id])
  })

  it('owner of A sees only tenant A', async () => {
    const rows = await asUser(sql, a.ownerId, (tx) => tx`select id from public.tenants`)
    expect(rows.map((r) => r.id)).toEqual([a.id])
  })

  it('same phone in two studios yields two independent customers', async () => {
    const all = await sql`select tenant_id from public.customers where phone_e164 = '+79991110000'`
    expect(all).toHaveLength(2)
    const visible = await asUser(sql, b.ownerId, (tx) => tx`select tenant_id from public.customers where phone_e164 = '+79991110000'`)
    expect(visible.map((r) => r.tenant_id)).toEqual([b.id])
  })

  it('owner of A cannot read a B booking by id', async () => {
    const rows = await asUser(sql, a.ownerId, (tx) => tx`select id from public.bookings where id = ${bookingB}`)
    expect(rows).toEqual([])
  })

  it('owner of A cannot transition, reschedule or price a B booking', async () => {
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`select public.owner_transition_booking(${bookingB}, 'cancelled')`))).toBe('NOT_FOUND')
    const s = hoursFromNow(100)
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`select public.owner_reschedule_booking(${bookingB}, ${s}, ${addMinutes(s, 120)})`))).toBe('NOT_FOUND')
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`select public.owner_set_final_price(${bookingB}, 1)`))).toBe('NOT_FOUND')
    const [row] = await sql`select status, final_price_minor from public.bookings where id = ${bookingB}`
    expect(row).toMatchObject({ status: 'confirmed', final_price_minor: null })
  })

  it('owner of A cannot block a B resource', async () => {
    const s = hoursFromNow(200)
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`select public.owner_create_block(${b.resourceIds[0]!}, ${s}, ${addMinutes(s, 60)}, 'x')`))).toBe('NOT_FOUND')
  })

  it('owner of A cannot update B customers (0 rows) and cannot touch bookings at all', async () => {
    const updated = await asUser(sql, a.ownerId, (tx) => tx`update public.customers set internal_notes = 'pwned' where tenant_id = ${b.id} returning id`)
    expect(updated).toEqual([])
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`update public.bookings set price_from_minor_snapshot = 1 where id = ${bookingA}`))).toMatch(/permission denied/)
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`insert into public.bookings (tenant_id) values (${a.id})`))).toMatch(/permission denied/)
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`delete from public.resource_allocations where tenant_id = ${a.id}`))).toMatch(/permission denied/)
  })

  it('owner can edit own customer notes but not move a customer to another tenant', async () => {
    const rows = await asUser(sql, a.ownerId, (tx) => tx`update public.customers set internal_notes = 'VIP' where tenant_id = ${a.id} returning id`)
    expect(rows.length).toBeGreaterThan(0)
    expect(await errorOf(asUser(sql, a.ownerId, (tx) => tx`update public.customers set tenant_id = ${b.id} where tenant_id = ${a.id}`))).toMatch(/permission denied/)
  })

  it('staff can move the car through the workflow but cannot cancel', async () => {
    expect(await errorOf(asUser(sql, a.staffId, (tx) => tx`select public.owner_transition_booking(${bookingA}, 'cancelled')`))).toBe('NOT_FOUND')
    await asUser(sql, a.staffId, (tx) => tx`select public.owner_transition_booking(${bookingA}, 'checked_in')`)
    const [row] = await sql`select status from public.bookings where id = ${bookingA}`
    expect(row!.status).toBe('checked_in')
  })

  it('Telegram destination is not readable across tenants', async () => {
    await sql`update public.tenant_notification_settings set telegram_chat_id = '12345' where tenant_id = ${b.id}`
    const rows = await asUser(sql, a.ownerId, (tx) => tx`select telegram_chat_id from public.tenant_notification_settings where tenant_id = ${b.id}`)
    expect(rows).toEqual([])
  })
})
