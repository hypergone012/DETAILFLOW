import {
  availabilityRequestSchema,
  cancelRequestSchema,
  createBookingRequestSchema,
  normalizePhone,
  normalizePlate,
  rescheduleRequestSchema,
  type VehicleClass,
} from '@detailflow/domain'
import { z } from 'zod'
import { availabilityDays, loadEngineContext, requireOfferedSlot } from '../_shared/booking-core.ts'
import { canonicalJson, isWellFormedToken, manageToken, sha256, sha256Hex } from '../_shared/crypto.ts'
import { asService, type Sql } from '../_shared/db.ts'
import { HttpError, clientIp, corsHeaders, errorResponse, json, readJson, routeSegments, type CorsConfig } from '../_shared/http.ts'

export interface PublicApiDeps {
  sql: Sql
  cors: CorsConfig
  manageTokenSecret: string
  /** Booking attempts per client IP per 10 minutes (default 10). */
  bookingsPerIpPer10Min?: number
  now?: () => Date
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

interface TenantRow {
  id: string
  status: 'demo' | 'active' | 'suspended'
}

const manageAvailabilitySchema = z.strictObject({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

/**
 * Public, account-less API for the customer PWA.
 * tenant_id is always resolved server-side from the slug; price, duration,
 * status and resource are never accepted from the client.
 */
export function createPublicApi(deps: PublicApiDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((msg, extra) => console.error(JSON.stringify({ fn: 'public-api', msg, ...extra })))
  const { sql } = deps

  async function tenantBySlug(slug: string): Promise<TenantRow> {
    const rows = await asService(sql, (tx) => tx<TenantRow[]>`
      select id, status from public.tenants where slug = ${slug} and status in ('demo', 'active', 'suspended')`)
    if (!rows[0]) throw new HttpError(404, 'NOT_FOUND')
    return rows[0]
  }

  async function rateLimit(key: string, windowSeconds: number, max: number): Promise<void> {
    const [row] = await asService(sql, (tx) => tx<{ ok: boolean }[]>`select private.hit_rate_limit(${key}, ${windowSeconds}, ${max}) as ok`)
    if (!row?.ok) throw new HttpError(429, 'RATE_LIMITED')
  }

  async function bookingByToken(tenantId: string, token: string) {
    if (!isWellFormedToken(token)) throw new HttpError(404, 'BOOKING_NOT_FOUND')
    const hash = await sha256(token)
    const [row] = await asService(sql, (tx) => tx<{ b: Record<string, unknown> | null }[]>`
      select private.get_booking_by_token(${tenantId}, ${hash}) as b`)
    if (!row?.b) throw new HttpError(404, 'BOOKING_NOT_FOUND')
    return row.b as Record<string, unknown> & { id: string; service_id: string; vehicle_class: VehicleClass; can_modify: boolean }
  }

  function publicBooking(b: Record<string, unknown>) {
    const { id: _id, ...rest } = b
    return rest
  }

  async function route(req: Request): Promise<Response> {
    const seg = routeSegments(req, 'public-api')
    const ipKey = await sha256Hex(clientIp(req))

    // GET /storefront/:slug
    if (req.method === 'GET' && seg[0] === 'storefront' && seg.length === 2) {
      const [row] = await asService(sql, (tx) => tx<{ s: unknown }[]>`select private.get_storefront(${seg[1]!}) as s`)
      if (!row?.s) throw new HttpError(404, 'NOT_FOUND')
      return json(row.s, 200, { 'cache-control': 'public, max-age=60' })
    }

    // POST /availability/:slug
    if (req.method === 'POST' && seg[0] === 'availability' && seg.length === 2) {
      await rateLimit(`avail:${ipKey}`, 60, 120)
      const tenant = await tenantBySlug(seg[1]!)
      if (tenant.status === 'suspended') throw new HttpError(403, 'TENANT_UNAVAILABLE')
      const body = await readJson(req, availabilityRequestSchema)
      const ctx = await loadEngineContext(sql, tenant.id, body.serviceId, body.vehicleClass, { now: now() })
      return json({ timezone: ctx.input.timezone, durationMin: ctx.durationMin, priceFromMinor: ctx.priceFromMinor, days: availabilityDays(ctx, body.from, body.to) })
    }

    // POST /bookings/:slug
    if (req.method === 'POST' && seg[0] === 'bookings' && seg.length === 2) {
      await rateLimit(`book:${ipKey}`, 600, deps.bookingsPerIpPer10Min ?? 10)
      const tenant = await tenantBySlug(seg[1]!)
      if (tenant.status === 'suspended') throw new HttpError(403, 'TENANT_UNAVAILABLE')
      const body = await readJson(req, createBookingRequestSchema)
      const phone = normalizePhone(body.customer.phone)
      if (!phone) throw new HttpError(422, 'INVALID_PHONE')
      await rateLimit(`book:${tenant.id}:${await sha256Hex(phone)}`, 3600, 10)

      const vehicle = {
        make: body.vehicle.make,
        model: body.vehicle.model,
        year: body.vehicle.year,
        color: body.vehicle.color,
        plate: normalizePlate(body.vehicle.plate),
        notes: body.vehicle.notes,
      }
      const customer = { name: body.customer.name, phone_e164: phone, email: body.customer.email }
      const requestHash = await sha256Hex(canonicalJson({ serviceId: body.serviceId, startAt: new Date(body.startAt).toISOString(), vehicle, vehicleClass: body.vehicle.vehicleClass, customer, comment: body.comment }))

      // Replays skip slot validation: the original request was already validated and booked.
      const existing = await asService(sql, (tx) => tx<{ id: string }[]>`
        select id from public.bookings where tenant_id = ${tenant.id} and idempotency_key = ${body.idempotencyKey}`)
      let start = new Date(body.startAt)
      let end: Date
      if (existing[0]) {
        end = start // ignored by create_booking on replay
      } else {
        const ctx = await loadEngineContext(sql, tenant.id, body.serviceId, body.vehicle.vehicleClass, { now: now() })
        ;({ start, end } = requireOfferedSlot(ctx, body.startAt))
      }

      const bookingId = existing[0]?.id ?? crypto.randomUUID()
      const token = await manageToken(deps.manageTokenSecret, bookingId)
      const tokenHash = await sha256(token)
      const [row] = await asService(sql, (tx) => tx<{ r: { booking_id: string; ref_code: string; status: string; replayed: boolean } }[]>`
        select private.create_booking(
          ${tenant.id}, ${bookingId}, ${body.idempotencyKey}, ${requestHash}, ${tokenHash},
          ${body.serviceId}, ${body.vehicle.vehicleClass}::public.vehicle_class, ${start}, ${end},
          ${tx.json(customer)}, ${tx.json(vehicle)}, ${body.comment}, 'customer') as r`)
      const r = row!.r
      const finalToken = r.booking_id === bookingId ? token : await manageToken(deps.manageTokenSecret, r.booking_id)
      return json({ refCode: r.ref_code, status: r.status, manageToken: finalToken, replayed: r.replayed, isDemo: tenant.status === 'demo' }, r.replayed ? 200 : 201)
    }

    // /manage/:slug/:token[/action]
    if (seg[0] === 'manage' && seg.length >= 3) {
      await rateLimit(`manage:${ipKey}`, 60, 60)
      const tenant = await tenantBySlug(seg[1]!)
      const booking = await bookingByToken(tenant.id, seg[2]!)
      const action = seg[3]

      if (req.method === 'GET' && !action) return json(publicBooking(booking))

      if (req.method === 'POST' && action === 'cancel') {
        const body = await readJson(req, cancelRequestSchema)
        await asService(sql, (tx) => tx`
          select private.transition_booking(${tenant.id}, ${booking.id}, 'cancelled', 'customer', null, ${body.reason ?? null})`)
        return json(publicBooking(await bookingByToken(tenant.id, seg[2]!)))
      }

      if (req.method === 'POST' && action === 'availability') {
        const body = await readJson(req, manageAvailabilitySchema)
        const ctx = await loadEngineContext(sql, tenant.id, booking.service_id, booking.vehicle_class, { now: now(), excludeBookingId: booking.id })
        return json({ timezone: ctx.input.timezone, durationMin: ctx.durationMin, priceFromMinor: ctx.priceFromMinor, days: availabilityDays(ctx, body.from, body.to) })
      }

      if (req.method === 'POST' && action === 'reschedule') {
        if (!booking.can_modify) throw new HttpError(409, 'CUTOFF_PASSED')
        const body = await readJson(req, rescheduleRequestSchema)
        const ctx = await loadEngineContext(sql, tenant.id, booking.service_id, booking.vehicle_class, { now: now(), excludeBookingId: booking.id })
        const { start, end } = requireOfferedSlot(ctx, body.startAt)
        await asService(sql, (tx) => tx`
          select private.reschedule_booking(${tenant.id}, ${booking.id}, ${start}, ${end}, 'customer', null)`)
        return json(publicBooking(await bookingByToken(tenant.id, seg[2]!)))
      }
    }

    throw new HttpError(404, 'NOT_FOUND')
  }

  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req, deps.cors)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await route(req)
    } catch (err) {
      res = errorResponse(err, log)
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }
}
