import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOwnerApi } from '../../supabase/functions/owner-api/handler.ts'
import { createPublicApi } from '../../supabase/functions/public-api/handler.ts'
import { connect, type Sql } from '../db/harness.ts'
import { CORS, JWT_SECRET, TOKEN_SECRET, accessToken, bookingBody, call, seedDemo } from './helpers.ts'

let sql: Sql
let owner: (req: Request) => Promise<Response>
let pub: (req: Request) => Promise<Response>
let ids: Awaited<ReturnType<typeof seedDemo>>
let graphiteToken: string
let iceToken: string

type Slot = { startAt: string; endAt: string }

async function bookSomething(slug: string, serviceSlug: string, minHoursAhead = 30) {
  const store = await call(pub, 'GET', `/public-api/storefront/${slug}`)
  const svc = store.body.services.find((s: { slug: string }) => s.slug === serviceSlug).id as string
  const today = new Date().toISOString().slice(0, 10)
  const to = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
  const av = await call(pub, 'POST', `/public-api/availability/${slug}`, { body: { serviceId: svc, vehicleClass: 'sedan', from: today, to } })
  const slots: Slot[] = av.body.days.flatMap((d: { slots: Slot[] }) => d.slots).filter((s: Slot) => Date.parse(s.startAt) > Date.now() + minHoursAhead * 3_600_000)
  const r = await call(pub, 'POST', `/public-api/bookings/${slug}`, { body: bookingBody(svc, slots[0]!.startAt) })
  expect(r.status).toBe(201)
  const [b] = await sql<{ id: string }[]>`select id from public.bookings where ref_code = ${r.body.refCode}`
  return { id: b!.id, ref: r.body.refCode as string, slots, serviceId: svc }
}

beforeAll(async () => {
  sql = connect(20)
  ids = await seedDemo(sql)
  owner = createOwnerApi({ sql, cors: CORS, auth: { jwtSecret: JWT_SECRET }, log: () => {} })
  pub = createPublicApi({ sql, cors: CORS, manageTokenSecret: TOKEN_SECRET, log: () => {} })
  graphiteToken = await accessToken(ids.graphiteOwner)
  iceToken = await accessToken(ids.iceOwner)
})
afterAll(() => sql.end())

describe('authentication', () => {
  it('requires a valid Supabase access token', async () => {
    expect((await call(owner, 'GET', '/owner-api/me')).status).toBe(401)
    expect((await call(owner, 'GET', '/owner-api/me', { token: 'garbage' })).status).toBe(401)
    const forged = await accessToken(ids.graphiteOwner, 'another-secret-that-is-at-least-32-chars!!')
    expect((await call(owner, 'GET', '/owner-api/me', { token: forged })).status).toBe(401)
  })

  it('lists only the caller’s studios', async () => {
    const r = await call(owner, 'GET', '/owner-api/me', { token: graphiteToken })
    expect(r.body.memberships.map((m: { slug: string }) => m.slug)).toEqual(['graphite'])
  })
})

describe('tenant isolation through the API', () => {
  it('another studio is simply not found', async () => {
    const today = new Date().toISOString().slice(0, 10)
    expect((await call(owner, 'GET', `/owner-api/ice-lab/day?date=${today}`, { token: graphiteToken })).status).toBe(404)
    expect((await call(owner, 'GET', '/owner-api/ice-lab/bookings', { token: graphiteToken })).status).toBe(404)
    expect((await call(owner, 'GET', '/owner-api/ice-lab/customers', { token: graphiteToken })).status).toBe(404)
  })

  it('a foreign booking id under one’s own slug is not found and cannot be changed', async () => {
    const iceBooking = await bookSomething('ice-lab', 'express-detail')
    expect((await call(owner, 'GET', `/owner-api/graphite/bookings/${iceBooking.id}`, { token: graphiteToken })).status).toBe(404)
    const t = await call(owner, 'POST', `/owner-api/graphite/bookings/${iceBooking.id}/transition`, { token: graphiteToken, body: { to: 'cancelled' } })
    expect(t.status).toBe(404)
    const [row] = await sql`select status from public.bookings where id = ${iceBooking.id}`
    expect(row!.status).toBe('requested')
  })

  it('lists contain only own data', async () => {
    await bookSomething('graphite', 'detailing-wash')
    const r = await call(owner, 'GET', '/owner-api/graphite/bookings', { token: graphiteToken })
    const [{ n }] = await sql`select count(*)::int as n from public.bookings where tenant_id = ${ids.graphite}` as unknown as [{ n: number }]
    expect(r.body.bookings).toHaveLength(Math.min(n, 200))
    const ice = await call(owner, 'GET', '/owner-api/ice-lab/bookings', { token: iceToken })
    const graphiteRefs = new Set(r.body.bookings.map((b: { ref_code: string }) => b.ref_code))
    expect(ice.body.bookings.some((b: { ref_code: string }) => graphiteRefs.has(b.ref_code))).toBe(false)
  })
})

describe('booking operations', () => {
  it('day view returns bookings with bay assignment and real counters', async () => {
    const b = await bookSomething('graphite', 'leather-care')
    const [row] = await sql<{ d: string }[]>`select to_char(start_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as d from public.bookings where id = ${b.id}`
    const r = await call(owner, 'GET', `/owner-api/graphite/day?date=${row!.d}`, { token: graphiteToken })
    expect(r.status).toBe(200)
    const listed = r.body.bookings.find((x: { id: string }) => x.id === b.id)
    expect(listed.resource_name).toMatch(/Бокс/)
    expect(r.body.resources.map((x: { key: string }) => x.key)).toEqual(['wash-1', 'bay-1', 'bay-2', 'ppf-1'])
    expect(typeof r.body.counters.awaiting_confirmation).toBe('number')
  })

  it('walks a car through the workflow and records the history', async () => {
    const b = await bookSomething('graphite', 'detailing-wash')
    for (const to of ['checked_in', 'in_progress', 'ready', 'completed']) {
      const r = await call(owner, 'POST', `/owner-api/graphite/bookings/${b.id}/transition`, { token: graphiteToken, body: { to } })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
    const bad = await call(owner, 'POST', `/owner-api/graphite/bookings/${b.id}/transition`, { token: graphiteToken, body: { to: 'confirmed' } })
    expect(bad.body.error.code).toBe('INVALID_TRANSITION')
    const price = await call(owner, 'POST', `/owner-api/graphite/bookings/${b.id}/final-price`, { token: graphiteToken, body: { amountMinor: 420000 } })
    expect(price.status).toBe(200)
    const detail = await call(owner, 'GET', `/owner-api/graphite/bookings/${b.id}`, { token: graphiteToken })
    expect(detail.body.booking).toMatchObject({ status: 'completed', final_price_minor: '420000' })
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual(['created', 'status_changed', 'status_changed', 'status_changed', 'status_changed', 'final_price_set'])
  })

  it('reschedule: server computes the end; a failed move leaves the booking intact', async () => {
    const a = await bookSomething('ice-lab', 'leather-restore')
    const b = await bookSomething('ice-lab', 'leather-restore')
    const [bRow] = await sql<{ start_at: Date }[]>`select start_at from public.bookings where id = ${b.id}`
    const [before] = await sql`select start_at, end_at from public.bookings where id = ${a.id}`

    const fail = await call(owner, 'POST', `/owner-api/ice-lab/bookings/${a.id}/reschedule`, { token: iceToken, body: { startAt: bRow!.start_at.toISOString() } })
    expect(fail.status).toBe(409)
    const [after] = await sql`select start_at, end_at from public.bookings where id = ${a.id}`
    expect(after).toEqual(before)

    const from = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
    const options = await call(owner, 'POST', `/owner-api/ice-lab/bookings/${a.id}/availability`, { token: iceToken, body: { from, to } })
    const target = options.body.days.flatMap((d: { slots: Slot[] }) => d.slots).at(-1) as Slot
    const ok = await call(owner, 'POST', `/owner-api/ice-lab/bookings/${a.id}/reschedule`, { token: iceToken, body: { startAt: target.startAt, endAt: '2000-01-01T00:00:00Z' } })
    expect(ok.status).toBe(400) // endAt is not accepted from clients, even owners
    const ok2 = await call(owner, 'POST', `/owner-api/ice-lab/bookings/${a.id}/reschedule`, { token: iceToken, body: { startAt: target.startAt } })
    expect(ok2.status).toBe(200)
    const [moved] = await sql`select start_at, end_at from public.bookings where id = ${a.id}`
    expect(moved!.start_at.toISOString()).toBe(target.startAt)
    expect(moved!.end_at.toISOString()).toBe(target.endAt)
  })

  it('blocks a bay and the public availability reflects it', async () => {
    const [res] = await sql<{ id: string }[]>`select id from public.resources where tenant_id = ${ids.iceLab} and key = 'wash-line'`
    const store = await call(pub, 'GET', '/public-api/storefront/ice-lab')
    const svc = store.body.services.find((s: { slug: string }) => s.slug === 'express-detail').id
    const from = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
    const before = (await call(pub, 'POST', '/public-api/availability/ice-lab', { body: { serviceId: svc, vehicleClass: 'sedan', from, to } })).body.days.flatMap((d: { slots: Slot[] }) => d.slots) as Slot[]
    const victim = before.at(-1)!
    const block = await call(owner, 'POST', '/owner-api/ice-lab/blocks', { token: iceToken, body: { resourceId: res!.id, startsAt: victim.startAt, endsAt: victim.endAt, reason: 'Обслуживание оборудования' } })
    expect(block.status).toBe(201)
    const afterBlock = (await call(pub, 'POST', '/public-api/availability/ice-lab', { body: { serviceId: svc, vehicleClass: 'sedan', from, to } })).body.days.flatMap((d: { slots: Slot[] }) => d.slots) as Slot[]
    expect(afterBlock.some((s) => s.startAt === victim.startAt)).toBe(false)
    const foreign = await call(owner, 'POST', '/owner-api/graphite/blocks', { token: graphiteToken, body: { resourceId: res!.id, startsAt: victim.startAt, endsAt: victim.endAt, reason: 'x' } })
    expect(foreign.status).toBe(404)
    await call(owner, 'DELETE', `/owner-api/ice-lab/blocks/${block.body.id}`, { token: iceToken })
  })

  it('search by booking ref returns exactly that booking (regression: empty digit filter matched everyone)', async () => {
    const a = await bookSomething('graphite', 'detailing-wash')
    await bookSomething('graphite', 'detailing-wash')
    const r = await call(owner, 'GET', `/owner-api/graphite/bookings?q=${a.ref}`, { token: graphiteToken })
    expect(r.body.bookings.map((b: { ref_code: string }) => b.ref_code)).toEqual([a.ref])
    const letters = await call(owner, 'GET', '/owner-api/graphite/customers?q=zzzz', { token: graphiteToken })
    expect(letters.body.customers).toEqual([])
  })

  it('customer notes are editable only within the own studio', async () => {
    const b = await bookSomething('graphite', 'detailing-wash')
    const detail = await call(owner, 'GET', `/owner-api/graphite/bookings/${b.id}`, { token: graphiteToken })
    const customerId = detail.body.customer.id
    expect((await call(owner, 'PATCH', `/owner-api/graphite/customers/${customerId}`, { token: graphiteToken, body: { internalNotes: 'Постоянный клиент' } })).status).toBe(200)
    expect((await call(owner, 'PATCH', `/owner-api/ice-lab/customers/${customerId}`, { token: iceToken, body: { internalNotes: 'hijack' } })).status).toBe(404)
    const [c] = await sql`select internal_notes from public.customers where id = ${customerId}`
    expect(c!.internal_notes).toBe('Постоянный клиент')
  })
})
