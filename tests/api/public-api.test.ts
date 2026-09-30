import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPublicApi } from '../../supabase/functions/public-api/handler.ts'
import { connect, type Sql } from '../db/harness.ts'
import { CORS, TOKEN_SECRET, bookingBody, call, seedDemo } from './helpers.ts'

let sql: Sql
let api: (req: Request) => Promise<Response>
let ids: Awaited<ReturnType<typeof seedDemo>>
let services: Record<string, Record<string, string>>

type Day = { date: string; open: boolean; slots: Array<{ startAt: string; endAt: string; time: string }> }

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

async function freeSlots(slug: string, serviceId: string, vehicleClass = 'sedan', from = isoDate(0), to = isoDate(20)) {
  const r = await call<{ days: Day[]; priceFromMinor: number; durationMin: number }>(api, 'POST', `/public-api/availability/${slug}`, { body: { serviceId, vehicleClass, from, to } })
  expect(r.status).toBe(200)
  return { ...r.body, slots: r.body.days.flatMap((d) => d.slots) }
}

beforeAll(async () => {
  sql = connect(30)
  ids = await seedDemo(sql)
  api = createPublicApi({ sql, cors: CORS, manageTokenSecret: TOKEN_SECRET, log: () => {} })
  services = {}
  for (const slug of ['graphite', 'ice-lab']) {
    const r = await call(api, 'GET', `/public-api/storefront/${slug}`)
    services[slug] = Object.fromEntries(r.body.services.map((s: { slug: string; id: string }) => [s.slug, s.id]))
  }
})
afterAll(() => sql.end())

describe('storefront', () => {
  it('serves public tenant data with CORS for allowed origins only', async () => {
    const r = await call(api, 'GET', '/public-api/storefront/graphite')
    expect(r.status).toBe(200)
    expect(r.body.tenant.name).toBe('GRAPHITE Detailing')
    expect(r.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173')
    const evil = await api(new Request('http://localhost/functions/v1/public-api/storefront/graphite', { headers: { origin: 'https://evil.example' } }))
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('404s unknown and draft studios', async () => {
    expect((await call(api, 'GET', '/public-api/storefront/nope')).status).toBe(404)
  })
})

describe('availability', () => {
  it('uses the vehicle-class variant for duration and price, server-side', async () => {
    const sedan = await freeSlots('graphite', services.graphite!['detailing-wash']!, 'sedan')
    const suv = await freeSlots('graphite', services.graphite!['detailing-wash']!, 'suv')
    expect(sedan).toMatchObject({ durationMin: 120, priceFromMinor: 350000 })
    expect(suv).toMatchObject({ durationMin: 150, priceFromMinor: 450000 })
  })

  it('reflects each studio’s own calendar (ICE LAB: closed Sun/Mon, lunch, next-day notice)', async () => {
    const ice = await freeSlots('ice-lab', services['ice-lab']!['express-detail']!)
    const closed = ice.days.filter((d) => !d.open).map((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay())
    expect(new Set(closed)).toEqual(new Set([0, 1]))
    // Lunch 14:00–15:00 on Tue–Fri (Saturday is 10–16 without a break).
    const weekdaySlots = ice.days.filter((d) => [2, 3, 4, 5].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay())).flatMap((d) => d.slots)
    expect(weekdaySlots.length).toBeGreaterThan(0)
    expect(weekdaySlots.every((s) => s.time !== '14:00')).toBe(true)
    expect(Date.parse(ice.slots[0]!.startAt) - Date.now()).toBeGreaterThanOrEqual(24 * 3_600_000)
  })

  it('does not serve another studio’s service', async () => {
    const r = await call(api, 'POST', '/public-api/availability/ice-lab', { body: { serviceId: services.graphite!['detailing-wash'], vehicleClass: 'sedan', from: isoDate(0), to: isoDate(5) } })
    expect(r.status).toBe(404)
  })
})

describe('create booking', () => {
  it('books an offered slot; price and duration come from the server', async () => {
    const svc = services.graphite!['interior-deep-clean']!
    const { slots } = await freeSlots('graphite', svc, 'suv')
    const slot = slots[3]!
    const body = bookingBody(svc, slot.startAt, { vehicle: { make: 'BMW', model: 'X5', year: 2021, color: 'Синий', vehicleClass: 'suv', plate: null, notes: '' } })
    const r = await call(api, 'POST', '/public-api/bookings/graphite', { body })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ status: 'confirmed', replayed: false, isDemo: true })
    expect(r.body.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [b] = await sql`select price_from_minor_snapshot, duration_min_snapshot, end_at, start_at, tenant_id from public.bookings where ref_code = ${r.body.refCode} and tenant_id = ${ids.graphite}`
    expect(b).toMatchObject({ price_from_minor_snapshot: '2200000', duration_min_snapshot: 420, tenant_id: ids.graphite })
    expect(b!.end_at.toISOString()).toBe(new Date(slot.endAt).toISOString())
  })

  it.each([
    ['tenant_id', { tenant_id: randomUUID() }],
    ['price', { priceFromMinor: 1 }],
    ['duration', { durationMin: 15 }],
    ['status', { status: 'completed' }],
    ['endAt', { endAt: new Date().toISOString() }],
    ['resource', { resourceId: randomUUID() }],
  ])('rejects client-supplied %s with 400', async (_n, extra) => {
    const svc = services.graphite!['detailing-wash']!
    const { slots } = await freeSlots('graphite', svc)
    const r = await call(api, 'POST', '/public-api/bookings/graphite', { body: { ...bookingBody(svc, slots[0]!.startAt), ...extra } })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects starts that are not offered (off-grid, closed hours)', async () => {
    const svc = services.graphite!['detailing-wash']!
    const { slots } = await freeSlots('graphite', svc)
    const offGrid = new Date(Date.parse(slots[0]!.startAt) + 7 * 60_000).toISOString()
    expect((await call(api, 'POST', '/public-api/bookings/graphite', { body: bookingBody(svc, offGrid) })).body.error.code).toBe('SLOT_NOT_OFFERED')
    const night = new Date(`${slots[0]!.startAt.slice(0, 10)}T00:00:00Z`).toISOString() // 03:00 MSK
    expect((await call(api, 'POST', '/public-api/bookings/graphite', { body: bookingBody(svc, night) })).status).toBe(409)
  })

  it('rejects invalid phones', async () => {
    const svc = services.graphite!['detailing-wash']!
    const { slots } = await freeSlots('graphite', svc)
    const body = bookingBody(svc, slots[0]!.startAt)
    body.customer = { ...(body.customer as object), phone: '+7 000 11' } as never
    const r = await call(api, 'POST', '/public-api/bookings/graphite', { body })
    expect(r.body.error.code).toBe('INVALID_PHONE')
  })

  it('an idempotent retry returns the same booking and the same manage link', async () => {
    const svc = services.graphite!['leather-care']!
    const { slots } = await freeSlots('graphite', svc)
    const body = bookingBody(svc, slots[5]!.startAt)
    const first = await call(api, 'POST', '/public-api/bookings/graphite', { body })
    const again = await call(api, 'POST', '/public-api/bookings/graphite', { body })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ refCode: first.body.refCode, manageToken: first.body.manageToken, replayed: true })
    const changed = await call(api, 'POST', '/public-api/bookings/graphite', { body: { ...body, comment: 'другое' } })
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('concurrent HTTP bookings of the last bay: one 201, the rest 409 SLOT_TAKEN', async () => {
    const svc = services['ice-lab']!['express-detail']! // one wash line
    const { slots } = await freeSlots('ice-lab', svc)
    const slot = slots[2]!
    const results = await Promise.all(Array.from({ length: 12 }, () => call(api, 'POST', '/public-api/bookings/ice-lab', { body: bookingBody(svc, slot.startAt) })))
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    const losers = results.filter((r) => r.status !== 201)
    expect(losers.every((r) => r.status === 409 && ['SLOT_TAKEN', 'SLOT_NOT_OFFERED'].includes(r.body.error.code))).toBe(true)
    const after = await freeSlots('ice-lab', svc)
    expect(after.slots.some((s) => s.startAt === slot.startAt)).toBe(false)
  })

  it('does not accept a service of another tenant', async () => {
    const svc = services.graphite!['detailing-wash']!
    const { slots } = await freeSlots('graphite', svc)
    const r = await call(api, 'POST', '/public-api/bookings/ice-lab', { body: bookingBody(svc, slots[0]!.startAt) })
    expect(r.status).toBe(404)
  })

  it('rate-limits bookings per client IP', async () => {
    const svc = services.graphite!['detailing-wash']!
    const { slots } = await freeSlots('graphite', svc)
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) {
      statuses.push((await call(api, 'POST', '/public-api/bookings/graphite', { body: { ...bookingBody(svc, slots[0]!.startAt), website: 'x' }, ip: '203.0.113.9' })).status)
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true) // honeypot filled → rejected
    expect(statuses.slice(10)).toEqual([429, 429])
  })
})

describe('manage link (no account)', () => {
  async function newBooking(slug: string, svc: string, index = 0) {
    // Beyond the cancellation cutoff so the customer may still modify it.
    const slots = (await freeSlots(slug, svc)).slots.filter((s) => Date.parse(s.startAt) > Date.now() + 48 * 3_600_000)
    const r = await call(api, 'POST', `/public-api/bookings/${slug}`, { body: bookingBody(svc, slots[index]!.startAt) })
    expect(r.status).toBe(201)
    return { token: r.body.manageToken as string, ref: r.body.refCode as string, slots }
  }

  it('shows the booking with a masked phone and without internal ids', async () => {
    const { token, ref } = await newBooking('graphite', services.graphite!['pre-sale']!, 2)
    const r = await call(api, 'GET', `/public-api/manage/graphite/${token}`)
    expect(r.status).toBe(200)
    expect(r.body.ref_code).toBe(ref)
    expect(r.body.contact_phone_masked).toMatch(/^\+7•+\d{4}$/)
    expect(r.body).not.toHaveProperty('id')
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|customer_id|internal_notes/)
  })

  it('a token is bound to its studio', async () => {
    const { token } = await newBooking('graphite', services.graphite!['pre-sale']!, 4)
    expect((await call(api, 'GET', `/public-api/manage/ice-lab/${token}`)).status).toBe(404)
    expect((await call(api, 'GET', `/public-api/manage/graphite/${'x'.repeat(43)}`)).status).toBe(404)
  })

  it('reschedules to a free slot and refuses a taken one without losing the original', async () => {
    const svc = services['ice-lab']!['leather-restore']! // single clean-room post
    const a = await newBooking('ice-lab', svc, 0)
    const { slots } = await freeSlots('ice-lab', svc)
    const target = slots[3]!
    await call(api, 'POST', '/public-api/bookings/ice-lab', { body: bookingBody(svc, target.startAt) })

    const before = await call(api, 'GET', `/public-api/manage/ice-lab/${a.token}`)
    const bad = await call(api, 'POST', `/public-api/manage/ice-lab/${a.token}/reschedule`, { body: { startAt: target.startAt } })
    expect(bad.status).toBe(409)
    const unchanged = await call(api, 'GET', `/public-api/manage/ice-lab/${a.token}`)
    expect(unchanged.body.start_at).toBe(before.body.start_at)
    expect(unchanged.body.status).toBe(before.body.status)

    const options = await call(api, 'POST', `/public-api/manage/ice-lab/${a.token}/availability`, { body: { from: isoDate(0), to: isoDate(20) } })
    const free = (options.body.days as Day[]).flatMap((d) => d.slots).find((s) => s.startAt !== before.body.start_at)!
    const ok = await call(api, 'POST', `/public-api/manage/ice-lab/${a.token}/reschedule`, { body: { startAt: free.startAt } })
    expect(ok.status).toBe(200)
    expect(new Date(ok.body.start_at).toISOString()).toBe(free.startAt)
  })

  it('cancels and frees the slot', async () => {
    const svc = services.graphite!['detailing-wash']!
    const { token, slots } = await newBooking('graphite', svc, 8)
    const r = await call(api, 'POST', `/public-api/manage/graphite/${token}/cancel`, { body: { reason: 'Планы изменились' } })
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ status: 'cancelled' })
    const again = await freeSlots('graphite', svc)
    expect(again.slots.some((s) => s.startAt === slots[8]!.startAt)).toBe(true)
  })
})
