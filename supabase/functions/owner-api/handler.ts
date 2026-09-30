import {
  ownerBlockRequestSchema,
  ownerCustomerNotesRequestSchema,
  ownerFinalPriceRequestSchema,
  ownerTransitionRequestSchema,
  rescheduleRequestSchema,
  type VehicleClass,
} from '@detailflow/domain'
import { z } from 'zod'
import { verifyAccessToken, type AuthConfig, type UserClaims } from '../_shared/auth.ts'
import { availabilityDays, loadEngineContext, requireOfferedSlot } from '../_shared/booking-core.ts'
import { asRole, type Sql, type Tx } from '../_shared/db.ts'
import { HttpError, corsHeaders, errorResponse, json, readJson, routeSegments, type CorsConfig } from '../_shared/http.ts'

export interface OwnerApiDeps {
  sql: Sql
  cors: CorsConfig
  auth: AuthConfig
  now?: () => Date
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const rangeSchema = z.strictObject({ from: dateParam, to: dateParam })
const uuid = z.uuid()

/** Search terms. The phone clause only applies with ≥ 4 digits, otherwise '%%' would match everyone. */
function searchTerms(raw: string | null): { text: string; digits: string | null; plate: string } {
  const text = (raw ?? '').trim().slice(0, 60)
  const digits = text.replace(/\D/g, '')
  return { text, digits: digits.length >= 4 ? digits : null, plate: text.replace(/\s/g, '') }
}

/**
 * Owner dashboard API. Every query runs as role `authenticated` with the
 * caller's verified JWT claims, so Postgres RLS decides what is visible.
 * Mutations go through owner_* RPCs that re-check membership and role.
 */
export function createOwnerApi(deps: OwnerApiDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((msg, extra) => console.error(JSON.stringify({ fn: 'owner-api', msg, ...extra })))
  const { sql } = deps

  const asUser = <T>(claims: UserClaims, fn: (tx: Tx) => Promise<T>) => asRole(sql, 'authenticated', claims, fn)

  /** Tenant visible to this user (RLS: members only). 404 otherwise — never 403, to avoid leaking existence. */
  async function tenantFor(claims: UserClaims, slug: string): Promise<{ id: string; slug: string; name: string; status: string; timezone: string; role: string }> {
    const [t] = await asUser(claims, (tx) => tx<{ id: string; slug: string; name: string; status: string; timezone: string; role: string }[]>`
      select t.id, t.slug, t.name, t.status, t.timezone, m.role
      from public.tenants t join public.tenant_members m on m.tenant_id = t.id and m.user_id = ${claims.sub}
      where t.slug = ${slug}`)
    if (!t) throw new HttpError(404, 'NOT_FOUND')
    return t
  }

  function id(value: string | undefined): string {
    const parsed = uuid.safeParse(value)
    if (!parsed.success) throw new HttpError(404, 'NOT_FOUND')
    return parsed.data
  }

  const BOOKING_LIST_COLUMNS = (tx: Tx) => tx`
    b.id, b.ref_code, b.status, b.start_at, b.end_at, b.service_name_snapshot as service_name,
    b.vehicle_class_snapshot as vehicle_class, b.multi_day_snapshot as multi_day,
    b.price_from_minor_snapshot as price_from_minor, b.final_price_minor, b.contact_name, b.contact_phone_e164,
    b.vehicle_snapshot as vehicle, b.is_demo, b.source, b.created_at,
    a.resource_id, r.name as resource_name`

  async function route(req: Request): Promise<Response> {
    const claims = await verifyAccessToken(req, deps.auth)
    const seg = routeSegments(req, 'owner-api')
    const url = new URL(req.url)

    // GET /me
    if (req.method === 'GET' && seg[0] === 'me') {
      const memberships = await asUser(claims, (tx) => tx`
        select t.slug, t.name, t.status, m.role from public.tenant_members m
        join public.tenants t on t.id = m.tenant_id where m.user_id = ${claims.sub} order by t.name`)
      return json({ userId: claims.sub, email: claims.email ?? null, memberships })
    }

    const slug = seg[0]
    if (!slug) throw new HttpError(404, 'NOT_FOUND')
    const tenant = await tenantFor(claims, slug)
    const [resource, rid, action] = seg.slice(1)

    // GET /:slug/day?date=YYYY-MM-DD  — schedule for one local day
    if (req.method === 'GET' && resource === 'day') {
      const date = dateParam.parse(url.searchParams.get('date'))
      const data = await asUser(claims, async (tx) => {
        const resources = await tx`select id, key, name, type from public.resources where tenant_id = ${tenant.id} and active order by sort, key`
        const bookings = await tx`
          select ${BOOKING_LIST_COLUMNS(tx)}
          from public.bookings b
          left join public.resource_allocations a on a.booking_id = b.id and a.released_at is null
          left join public.resources r on r.id = a.resource_id
          where b.tenant_id = ${tenant.id}
            and b.start_at < ((${date}::date + 1)::timestamp at time zone ${tenant.timezone})
            and b.end_at > (${date}::date::timestamp at time zone ${tenant.timezone})
          order by b.start_at`
        const blocks = await tx`
          select k.id, k.resource_id, k.starts_at, k.ends_at, k.reason from public.resource_blocks k
          where k.tenant_id = ${tenant.id} and k.removed_at is null
            and k.starts_at < ((${date}::date + 1)::timestamp at time zone ${tenant.timezone})
            and k.ends_at > (${date}::date::timestamp at time zone ${tenant.timezone})
          order by k.starts_at`
        const [counters] = await tx`
          select
            count(*) filter (where status = 'requested')::int as awaiting_confirmation,
            count(*) filter (where status in ('checked_in', 'in_progress'))::int as in_work,
            count(*) filter (where status = 'ready')::int as ready_for_pickup
          from public.bookings where tenant_id = ${tenant.id}`
        const [notifications] = await tx`
          select count(*) filter (where status = 'pending')::int as pending,
                 count(*) filter (where status = 'failed')::int as failed,
                 count(*) filter (where status = 'not_configured')::int as not_configured
          from public.notification_outbox where tenant_id = ${tenant.id} and created_at > now() - interval '7 days'`
        return { resources, bookings, blocks, counters, notifications }
      })
      return json({ tenant, date, ...data })
    }

    // GET /:slug/bookings?status=&q=
    if (req.method === 'GET' && resource === 'bookings' && !rid) {
      const status = url.searchParams.get('status')
      const q = searchTerms(url.searchParams.get('q'))
      const rows = await asUser(claims, (tx) => tx`
        select ${BOOKING_LIST_COLUMNS(tx)}
        from public.bookings b
        left join public.resource_allocations a on a.booking_id = b.id and a.released_at is null
        left join public.resources r on r.id = a.resource_id
        where b.tenant_id = ${tenant.id}
          ${status ? tx`and b.status = ${status}::public.booking_status` : tx``}
          ${q.text ? tx`and (b.ref_code ilike ${'%' + q.text + '%'} or b.contact_name ilike ${'%' + q.text + '%'}
                        ${q.digits ? tx`or b.contact_phone_e164 like ${'%' + q.digits + '%'}` : tx``}
                        or b.vehicle_snapshot->>'plate' ilike ${'%' + q.plate + '%'})` : tx``}
        order by b.start_at desc limit 200`)
      return json({ bookings: rows })
    }

    // GET /:slug/bookings/:id
    if (req.method === 'GET' && resource === 'bookings' && rid && !action) {
      const bookingId = id(rid)
      const data = await asUser(claims, async (tx) => {
        const [booking] = await tx`
          select ${BOOKING_LIST_COLUMNS(tx)}, b.customer_id, b.vehicle_id, b.service_id, b.customer_comment, b.contact_email,
                 b.duration_min_snapshot, b.cancelled_at, b.cancelled_by, b.cancel_reason
          from public.bookings b
          left join public.resource_allocations a on a.booking_id = b.id and a.released_at is null
          left join public.resources r on r.id = a.resource_id
          where b.tenant_id = ${tenant.id} and b.id = ${bookingId}`
        if (!booking) return null
        const [customer] = await tx`
          select c.id, c.name, c.phone_e164, c.email, c.internal_notes,
                 (select count(*)::int from public.bookings x where x.customer_id = c.id and x.status = 'completed') as completed_visits
          from public.customers c where c.id = ${booking.customer_id as string}`
        const [vehicle] = await tx`select * from public.vehicles where id = ${booking.vehicle_id as string}`
        const events = await tx`select at, actor, type, from_status, to_status, data from public.booking_events where booking_id = ${bookingId} order by id`
        const notifications = await tx`select event, status, attempts, last_error, created_at from public.notification_outbox where booking_id = ${bookingId} order by created_at`
        return { booking, customer, vehicle, events, notifications }
      })
      if (!data) throw new HttpError(404, 'NOT_FOUND')
      return json(data)
    }

    // POST /:slug/bookings/:id/transition
    if (req.method === 'POST' && resource === 'bookings' && action === 'transition') {
      const bookingId = id(rid)
      const body = await readJson(req, ownerTransitionRequestSchema)
      const [r] = await asUser(claims, (tx) => tx`select public.owner_transition_booking(${bookingId}, ${body.to}::public.booking_status, ${body.reason ?? null}) as r`)
      return json(r!.r)
    }

    // POST /:slug/bookings/:id/final-price
    if (req.method === 'POST' && resource === 'bookings' && action === 'final-price') {
      const bookingId = id(rid)
      const body = await readJson(req, ownerFinalPriceRequestSchema)
      await asUser(claims, (tx) => tx`select public.owner_set_final_price(${bookingId}, ${body.amountMinor})`)
      return json({ ok: true })
    }

    // POST /:slug/bookings/:id/availability  {from,to}  — slots for rescheduling
    // POST /:slug/bookings/:id/reschedule    {startAt}
    if (req.method === 'POST' && resource === 'bookings' && (action === 'availability' || action === 'reschedule')) {
      const bookingId = id(rid)
      const [b] = await asUser(claims, (tx) => tx<{ service_id: string; vehicle_class: VehicleClass }[]>`
        select service_id, vehicle_class_snapshot as vehicle_class from public.bookings where tenant_id = ${tenant.id} and id = ${bookingId}`)
      if (!b) throw new HttpError(404, 'NOT_FOUND')
      // Studio staff are not bound by the customer notice window/horizon.
      const ctx = await loadEngineContext(sql, tenant.id, b.service_id, b.vehicle_class, {
        now: now(), excludeBookingId: bookingId, policyOverride: { minNoticeMin: 0, horizonDays: 365 },
      })
      if (action === 'availability') {
        const body = await readJson(req, rangeSchema)
        return json({ timezone: ctx.input.timezone, durationMin: ctx.durationMin, days: availabilityDays(ctx, body.from, body.to) })
      }
      const body = await readJson(req, rescheduleRequestSchema)
      const { start, end } = requireOfferedSlot(ctx, body.startAt)
      const [r] = await asUser(claims, (tx) => tx`select public.owner_reschedule_booking(${bookingId}, ${start}, ${end}) as r`)
      return json(r!.r)
    }

    // GET /:slug/customers?q=
    if (req.method === 'GET' && resource === 'customers' && !rid) {
      const q = searchTerms(url.searchParams.get('q'))
      const rows = await asUser(claims, (tx) => tx`
        select c.id, c.name, c.phone_e164, c.email, c.created_at,
               (select count(*)::int from public.bookings b where b.customer_id = c.id) as bookings,
               (select max(b.start_at) from public.bookings b where b.customer_id = c.id) as last_visit,
               (select string_agg(v.make || ' ' || v.model, ', ') from public.vehicles v where v.customer_id = c.id) as vehicles
        from public.customers c
        where c.tenant_id = ${tenant.id}
          ${q.text ? tx`and (c.name ilike ${'%' + q.text + '%'}
                        ${q.digits ? tx`or c.phone_e164 like ${'%' + q.digits + '%'}` : tx``}
                        or exists (select 1 from public.vehicles v where v.customer_id = c.id and v.plate ilike ${'%' + q.plate + '%'}))` : tx``}
        order by last_visit desc nulls last limit 200`)
      return json({ customers: rows })
    }

    // GET /:slug/customers/:id
    if (req.method === 'GET' && resource === 'customers' && rid) {
      const customerId = id(rid)
      const data = await asUser(claims, async (tx) => {
        const [customer] = await tx`select id, name, phone_e164, email, internal_notes, created_at from public.customers where tenant_id = ${tenant.id} and id = ${customerId}`
        if (!customer) return null
        const vehicles = await tx`select * from public.vehicles where customer_id = ${customerId} order by created_at desc`
        const bookings = await tx`
          select id, ref_code, status, start_at, end_at, service_name_snapshot as service_name, price_from_minor_snapshot as price_from_minor,
                 final_price_minor, vehicle_snapshot as vehicle
          from public.bookings where customer_id = ${customerId} order by start_at desc`
        return { customer, vehicles, bookings }
      })
      if (!data) throw new HttpError(404, 'NOT_FOUND')
      return json(data)
    }

    // PATCH /:slug/customers/:id  {internalNotes}
    if (req.method === 'PATCH' && resource === 'customers' && rid) {
      const customerId = id(rid)
      const body = await readJson(req, ownerCustomerNotesRequestSchema)
      const rows = await asUser(claims, (tx) => tx`
        update public.customers set internal_notes = ${body.internalNotes} where tenant_id = ${tenant.id} and id = ${customerId} returning id`)
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND')
      return json({ ok: true })
    }

    // POST /:slug/blocks ; DELETE /:slug/blocks/:id
    if (req.method === 'POST' && resource === 'blocks' && !rid) {
      const body = await readJson(req, ownerBlockRequestSchema)
      const [r] = await asUser(claims, (tx) => tx`select public.owner_create_block(${body.resourceId}, ${body.startsAt}, ${body.endsAt}, ${body.reason}) as id`)
      return json({ id: r!.id }, 201)
    }
    if (req.method === 'DELETE' && resource === 'blocks' && rid) {
      await asUser(claims, (tx) => tx`select public.owner_remove_block(${id(rid)})`)
      return json({ ok: true })
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
      res = errorResponse(err instanceof z.ZodError ? new HttpError(400, 'VALIDATION_FAILED') : err, log)
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }
}
