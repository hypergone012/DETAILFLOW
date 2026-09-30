import {
  addDays,
  computeAvailability,
  findOfferedSlot,
  localToday,
  resolveVariant,
  type AvailabilityInput,
  type BookingPolicy,
  type VehicleClass,
} from '@detailflow/domain'
import { asService, type Sql } from './db.ts'
import { HttpError } from './http.ts'

interface InputsRow {
  timezone: string
  policy: { slot_step_min: number; min_notice_min: number; horizon_days: number }
  service: {
    id: string
    resource_type: string
    duration_min: number
    price_from_minor: number
    buffer_before_min: number
    buffer_after_min: number
    multi_day: boolean
    variants: Array<{ vehicle_class: VehicleClass; duration_min: number; price_from_minor: number }>
  }
  resources: string[]
  busy: Array<{ resource_id: string; start: string; end: string }>
  hours: Array<{ weekday: number; opens: string; closes: string }>
  exceptions: Array<{ date: string; closed: boolean; opens: string | null; closes: string | null }>
}

export interface EngineContext {
  input: Omit<AvailabilityInput, 'from' | 'to'>
  durationMin: number
  priceFromMinor: number
}

const DAY_MS = 86_400_000

/**
 * Loads everything the slot engine needs straight from Postgres and resolves
 * the vehicle-class variant server-side. `excludeBookingId` lets a booking be
 * moved onto time that overlaps its own current allocation.
 */
export async function loadEngineContext(
  sql: Sql,
  tenantId: string,
  serviceId: string,
  vehicleClass: VehicleClass,
  opts: { now: Date; excludeBookingId?: string; policyOverride?: Partial<BookingPolicy> },
): Promise<EngineContext> {
  // Busy intervals: look back one day and ahead over the horizon + multi-day span.
  const from = new Date(opts.now.getTime() - DAY_MS)
  const to = new Date(opts.now.getTime() + 400 * DAY_MS)
  const row = await asService(sql, async (tx) => {
    const [r] = await tx<{ v: InputsRow | null }[]>`
      select private.get_availability_inputs(${tenantId}, ${serviceId}, ${from}, ${to}) as v`
    let excluded: string[] = []
    if (opts.excludeBookingId) {
      excluded = (await tx<{ resource_id: string; lower: Date }[]>`
        select resource_id, lower(during) as lower from public.resource_allocations
        where booking_id = ${opts.excludeBookingId} and released_at is null`).map((a) => `${a.resource_id}|${a.lower.toISOString()}`)
    }
    return { inputs: r?.v ?? null, excluded }
  })
  if (!row.inputs) throw new HttpError(404, 'SERVICE_NOT_FOUND')
  const i = row.inputs
  const variant = resolveVariant(
    { durationMin: i.service.duration_min, priceFromMinor: i.service.price_from_minor },
    i.service.variants.map((v) => ({ vehicleClass: v.vehicle_class, durationMin: v.duration_min, priceFromMinor: v.price_from_minor })),
    vehicleClass,
  )
  const excluded = new Set(row.excluded)
  return {
    durationMin: variant.durationMin,
    priceFromMinor: variant.priceFromMinor,
    input: {
      timezone: i.timezone,
      hours: i.hours,
      exceptions: i.exceptions,
      service: {
        durationMin: variant.durationMin,
        bufferBeforeMin: i.service.buffer_before_min,
        bufferAfterMin: i.service.buffer_after_min,
        multiDay: i.service.multi_day,
      },
      policy: {
        slotStepMin: i.policy.slot_step_min,
        minNoticeMin: i.policy.min_notice_min,
        horizonDays: i.policy.horizon_days,
        ...opts.policyOverride,
      },
      resources: i.resources,
      busy: i.busy
        .map((b) => ({ resourceId: b.resource_id, start: new Date(b.start), end: new Date(b.end) }))
        .filter((b) => !excluded.has(`${b.resourceId}|${b.start.toISOString()}`)),
      now: opts.now,
    },
  }
}

export function availabilityDays(ctx: EngineContext, from: string, to: string) {
  const today = localToday(ctx.input.now, ctx.input.timezone)
  const start = from < today ? today : from
  if (start > to) return []
  return computeAvailability({ ...ctx.input, from: start, to }).map((d) => ({
    date: d.date,
    open: d.open,
    slots: d.slots.map((s) => ({ startAt: s.start.toISOString(), endAt: s.end.toISOString(), time: s.localTime })),
  }))
}

/** Server-side check that a requested start is actually offered; returns the server-computed end. */
export function requireOfferedSlot(ctx: EngineContext, startAt: string): { start: Date; end: Date } {
  const start = new Date(startAt)
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'VALIDATION_FAILED')
  const slot = findOfferedSlot(ctx.input, start)
  if (!slot) throw new HttpError(409, 'SLOT_NOT_OFFERED')
  return { start: slot.start, end: slot.end }
}

export { addDays }
