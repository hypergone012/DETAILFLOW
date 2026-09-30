import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMinutes, book, createTenant, hoursFromNow } from './fixtures.ts'
import { asService, asUser, connect, errorOf, type Sql } from './harness.ts'

let sql: Sql

beforeAll(() => {
  sql = connect(40)
})
afterAll(() => sql.end())

async function activeAllocations(bookingId: string) {
  return sql<{ resource_id: string; lower: Date; upper: Date }[]>`
    select resource_id, lower(during) as lower, upper(during) as upper
    from public.resource_allocations where booking_id = ${bookingId} and released_at is null`
}

describe('server-side price and duration', () => {
  it('snapshots the variant price/duration for the vehicle class, not client input', async () => {
    const t = await createTenant(sql)
    const start = hoursFromNow(30)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, vehicleClass: 'suv', start, end: addMinutes(start, 180) })
    const [b] = await sql`select price_from_minor_snapshot, duration_min_snapshot, service_name_snapshot, currency
                          from public.bookings where id = ${r.booking_id}`
    expect(b).toMatchObject({ price_from_minor_snapshot: '450000', duration_min_snapshot: 180, currency: 'RUB' })
  })

  it('falls back to the base service when no variant exists', async () => {
    const t = await createTenant(sql)
    const start = hoursFromNow(30)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, vehicleClass: 'compact', start, end: addMinutes(start, 120) })
    const [b] = await sql`select price_from_minor_snapshot, duration_min_snapshot from public.bookings where id = ${r.booking_id}`
    expect(b).toMatchObject({ price_from_minor_snapshot: '350000', duration_min_snapshot: 120 })
  })

  it('rejects a window that does not match the server duration (cannot shorten a service)', async () => {
    const t = await createTenant(sql)
    const start = hoursFromNow(30)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, vehicleClass: 'suv', start, end: addMinutes(start, 120) }))).toBe('INVALID_WINDOW')
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.multiDayServiceId, start, end: addMinutes(start, 600) }))).toBe('INVALID_WINDOW')
  })

  it('rejects services of another tenant', async () => {
    const a = await createTenant(sql)
    const b = await createTenant(sql)
    const start = hoursFromNow(30)
    expect(await errorOf(book(sql, { tenantId: a.id, serviceId: b.serviceId, start, end: addMinutes(start, 120) }))).toBe('SERVICE_NOT_FOUND')
  })

  it('enforces min notice and horizon', async () => {
    const t = await createTenant(sql)
    await sql`update public.tenant_settings set min_notice_min = 240, horizon_days = 10 where tenant_id = ${t.id}`
    const soon = hoursFromNow(2)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start: soon, end: addMinutes(soon, 120) }))).toBe('OUTSIDE_BOOKING_WINDOW')
    const far = hoursFromNow(24 * 11)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start: far, end: addMinutes(far, 120) }))).toBe('OUTSIDE_BOOKING_WINDOW')
  })

  it('refuses bookings for suspended tenants and flags demo bookings', async () => {
    const s = await createTenant(sql, { status: 'suspended' })
    const start = hoursFromNow(30)
    expect(await errorOf(book(sql, { tenantId: s.id, serviceId: s.serviceId, start, end: addMinutes(start, 120) }))).toBe('TENANT_UNAVAILABLE')
    const d = await createTenant(sql, { status: 'demo' })
    const r = await book(sql, { tenantId: d.id, serviceId: d.serviceId, start, end: addMinutes(start, 120) })
    const [b] = await sql`select is_demo from public.bookings where id = ${r.booking_id}`
    expect(b!.is_demo).toBe(true)
    const outbox = await sql`select event, status from public.notification_outbox where booking_id = ${r.booking_id}`
    expect(outbox).toEqual([{ event: 'booking.created', status: 'pending' }])
  })
})

describe('idempotency', () => {
  it('replays the same booking for the same key and payload', async () => {
    const t = await createTenant(sql)
    const start = hoursFromNow(40)
    const key = randomUUID()
    const first = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120), idempotencyKey: key, requestHash: 'abc', phone: '+79990001122' })
    const again = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120), idempotencyKey: key, requestHash: 'abc', phone: '+79990001122' })
    expect(again).toMatchObject({ booking_id: first.booking_id, ref_code: first.ref_code, replayed: true })
    const [{ n }] = await sql`select count(*)::int as n from public.bookings where tenant_id = ${t.id}` as unknown as [{ n: number }]
    expect(n).toBe(1)
  })

  it('rejects the same key with a different payload', async () => {
    const t = await createTenant(sql)
    const start = hoursFromNow(40)
    const key = randomUUID()
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120), idempotencyKey: key, requestHash: 'one' })
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120), idempotencyKey: key, requestHash: 'two' }))).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('10 concurrent retries with one key create exactly one booking', async () => {
    const t = await createTenant(sql)
    const start = hoursFromNow(50)
    const key = randomUUID()
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120), idempotencyKey: key, requestHash: 'same', phone: '+79990003344' })),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ booking_id: string }>).value)
    expect(ok).toHaveLength(10)
    expect(new Set(ok.map((r) => r.booking_id)).size).toBe(1)
    const [{ n }] = await sql`select count(*)::int as n from public.bookings where tenant_id = ${t.id}` as unknown as [{ n: number }]
    expect(n).toBe(1)
  })
})

describe('atomic occupancy', () => {
  it('20 concurrent customers for the last bay: exactly one wins', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const start = hoursFromNow(60)
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120) })),
    )
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(19)
    expect(new Set(lost.map((r) => (r.reason as Error).message))).toEqual(new Set(['SLOT_TAKEN']))
    // Losers leave nothing behind: no orphan customers, vehicles or bookings.
    const [{ c }] = await sql`select count(*)::int as c from public.customers where tenant_id = ${t.id}` as unknown as [{ c: number }]
    expect(c).toBe(1)
  })

  it('with 3 bays exactly 3 of 12 overlapping requests win, one per bay', async () => {
    const t = await createTenant(sql, { bays: 3 })
    const start = hoursFromNow(60)
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => book(sql, { tenantId: t.id, serviceId: t.serviceId, start: addMinutes(start, (i % 3) * 30), end: addMinutes(start, (i % 3) * 30 + 120) })),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    const rows = await sql`select resource_id from public.resource_allocations where tenant_id = ${t.id} and released_at is null`
    expect(new Set(rows.map((r) => r.resource_id)).size).toBe(3)
  })

  it('regression: contention never surfaces as deadlock or spurious unavailability', async () => {
    // Before per-resource serialization ~11% of losers got "deadlock detected"
    // and some rounds ended with fewer winners than free bays.
    for (let round = 0; round < 10; round++) {
      const t = await createTenant(sql, { bays: 3 })
      const start = hoursFromNow(60)
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120) })),
      )
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
      const messages = new Set((results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]).map((r) => (r.reason as Error).message))
      expect(messages).toEqual(new Set(['SLOT_TAKEN']))
    }
  })

  it('buffers are part of occupancy', async () => {
    const t = await createTenant(sql, { bays: 1, bufferAfter: 30 })
    const start = hoursFromNow(80)
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120) })
    const tooSoon = addMinutes(start, 135)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start: tooSoon, end: addMinutes(tooSoon, 120) }))).toBe('SLOT_TAKEN')
    const ok = addMinutes(start, 150)
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: ok, end: addMinutes(ok, 120) })
  })

  it('a multi-day booking blocks the bay continuously, overnight included', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const start = hoursFromNow(100)
    await book(sql, { tenantId: t.id, serviceId: t.multiDayServiceId, start, end: addMinutes(start, 60 * 40) })
    const night = addMinutes(start, 60 * 20)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start: night, end: addMinutes(night, 120) }))).toBe('SLOT_TAKEN')
  })

  it('owner blocks participate in the same constraint', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const start = hoursFromNow(120)
    await asUser(sql, t.ownerId, (tx) => tx`select public.owner_create_block(${t.resourceIds[0]!}, ${start}, ${addMinutes(start, 240)}, 'Обслуживание')`)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start: addMinutes(start, 60), end: addMinutes(start, 180) }))).toBe('SLOT_TAKEN')
    const s2 = addMinutes(start, 600)
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s2, end: addMinutes(s2, 120) })
    expect(await errorOf(asUser(sql, t.ownerId, (tx) => tx`select public.owner_create_block(${t.resourceIds[0]!}, ${s2}, ${addMinutes(s2, 30)}, 'x')`))).toBe('SLOT_TAKEN')
  })

  it('limits active bookings per phone', async () => {
    const t = await createTenant(sql, { bays: 5, maxActive: 2 })
    const phone = '+79995556677'
    for (const h of [30, 40]) {
      const s = hoursFromNow(h)
      await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120), phone })
    }
    const s = hoursFromNow(50)
    expect(await errorOf(book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120), phone }))).toBe('TOO_MANY_ACTIVE_BOOKINGS')
  })

  it('does not overwrite an existing customer name from a public form', async () => {
    const t = await createTenant(sql, { bays: 2 })
    const s = hoursFromNow(30)
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120), phone: '+79997778899', name: 'Анна' })
    const s2 = hoursFromNow(60)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s2, end: addMinutes(s2, 120), phone: '+79997778899', name: 'Злоумышленник' })
    const [c] = await sql`select name from public.customers where tenant_id = ${t.id}`
    expect(c!.name).toBe('Анна')
    const [b] = await sql`select contact_name from public.bookings where id = ${r.booking_id}`
    expect(b!.contact_name).toBe('Злоумышленник')
  })
})

describe('reschedule', () => {
  it('failed reschedule keeps the original booking and allocation intact', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const s1 = hoursFromNow(48)
    const s2 = hoursFromNow(72)
    const first = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s1, end: addMinutes(s1, 120) })
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s2, end: addMinutes(s2, 120) })
    const before = await activeAllocations(first.booking_id)

    const msg = await errorOf(asUser(sql, t.ownerId, (tx) => tx`select public.owner_reschedule_booking(${first.booking_id}, ${s2}, ${addMinutes(s2, 120)})`))
    expect(msg).toBe('SLOT_TAKEN')

    expect(await activeAllocations(first.booking_id)).toEqual(before)
    const [b] = await sql`select start_at, status from public.bookings where id = ${first.booking_id}`
    expect(b!.start_at.getTime()).toBe(s1.getTime())
    expect(b!.status).toBe('confirmed')
    const events = await sql`select type from public.booking_events where booking_id = ${first.booking_id}`
    expect(events.map((e) => e.type)).toEqual(['created'])
  })

  it('successful reschedule moves occupancy and frees the old slot (overlapping itself is fine)', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const s1 = hoursFromNow(48)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s1, end: addMinutes(s1, 120) })
    const s2 = addMinutes(s1, 60)
    await asUser(sql, t.ownerId, (tx) => tx`select public.owner_reschedule_booking(${r.booking_id}, ${s2}, ${addMinutes(s2, 120)})`)
    const alloc = await activeAllocations(r.booking_id)
    expect(alloc).toHaveLength(1)
    expect(alloc[0]!.lower.getTime()).toBe(s2.getTime())
    const released = await sql`select count(*)::int as n from public.resource_allocations where booking_id = ${r.booking_id} and released_at is not null`
    expect(released[0]!.n).toBe(1)
  })

  it('customer reschedule respects the cancellation cutoff', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const s1 = hoursFromNow(10) // cutoff is 24h
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s1, end: addMinutes(s1, 120) })
    const s2 = hoursFromNow(60)
    const msg = await errorOf(asService(sql, (tx) => tx`select private.reschedule_booking(${t.id}, ${r.booking_id}, ${s2}, ${addMinutes(s2, 120)}, 'customer', null)`))
    expect(msg).toBe('CUTOFF_PASSED')
  })
})

describe('status machine', () => {
  it('walks the happy path and frees the bay on early completion', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const s = hoursFromNow(30)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120) })
    for (const to of ['checked_in', 'in_progress', 'ready', 'completed']) {
      await asUser(sql, t.ownerId, (tx) => tx`select public.owner_transition_booking(${r.booking_id}, ${to}::public.booking_status)`)
    }
    const [a] = await activeAllocations(r.booking_id)
    expect(a!.upper.getTime()).toBeLessThan(s.getTime() + 60_000 * 2)
    const events = await sql`select from_status, to_status from public.booking_events where booking_id = ${r.booking_id} and type = 'status_changed' order by id`
    expect(events.map((e) => e.to_status)).toEqual(['checked_in', 'in_progress', 'ready', 'completed'])
  })

  it('rejects illegal transitions', async () => {
    const t = await createTenant(sql)
    const s = hoursFromNow(30)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120) })
    expect(await errorOf(asUser(sql, t.ownerId, (tx) => tx`select public.owner_transition_booking(${r.booking_id}, 'completed')`))).toBe('INVALID_TRANSITION')
    expect(await errorOf(asUser(sql, t.ownerId, (tx) => tx`select public.owner_transition_booking(${r.booking_id}, 'requested')`))).toBe('INVALID_TRANSITION')
  })

  it('cancel releases the slot so it can be booked again', async () => {
    const t = await createTenant(sql, { bays: 1 })
    const s = hoursFromNow(30)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120) })
    await asUser(sql, t.ownerId, (tx) => tx`select public.owner_transition_booking(${r.booking_id}, 'cancelled', 'Клиент попросил')`)
    expect(await activeAllocations(r.booking_id)).toEqual([])
    await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120) })
    const [b] = await sql`select cancelled_by, cancel_reason from public.bookings where id = ${r.booking_id}`
    expect(b).toMatchObject({ cancelled_by: 'owner', cancel_reason: 'Клиент попросил' })
  })

  it('customer can only cancel, and only before the cutoff', async () => {
    const t = await createTenant(sql, { bays: 2 })
    const late = hoursFromNow(5)
    const r1 = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: late, end: addMinutes(late, 120) })
    expect(await errorOf(asService(sql, (tx) => tx`select private.transition_booking(${t.id}, ${r1.booking_id}, 'cancelled', 'customer', null, null)`))).toBe('CUTOFF_PASSED')
    const early = hoursFromNow(48)
    const r2 = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: early, end: addMinutes(early, 120) })
    expect(await errorOf(asService(sql, (tx) => tx`select private.transition_booking(${t.id}, ${r2.booking_id}, 'checked_in', 'customer', null, null)`))).toBe('FORBIDDEN')
    await asService(sql, (tx) => tx`select private.transition_booking(${t.id}, ${r2.booking_id}, 'cancelled', 'customer', null, null)`)
  })

  it('requires confirmation when the service says so', async () => {
    const t = await createTenant(sql)
    await sql`update public.services set requires_confirmation = true where id = ${t.serviceId}`
    const s = hoursFromNow(30)
    const r = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120) })
    expect(r.status).toBe('requested')
  })
})
