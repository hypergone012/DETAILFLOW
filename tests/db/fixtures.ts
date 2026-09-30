import { createHash, randomUUID } from 'node:crypto'
import type { Sql } from './harness.ts'
import { asService, createAuthUser } from './harness.ts'

export interface TenantFixture {
  id: string
  slug: string
  ownerId: string
  staffId: string
  serviceId: string
  multiDayServiceId: string
  resourceIds: string[]
}

let counter = 0

/**
 * A tenant with open hours every day 00:00–23:59 (the slot engine is tested
 * separately; DB tests exercise occupancy, isolation and atomicity).
 */
export async function createTenant(
  sql: Sql,
  opts: { status?: 'demo' | 'active' | 'suspended'; bays?: number; bufferAfter?: number; maxActive?: number } = {},
): Promise<TenantFixture> {
  counter += 1
  const slug = `t${counter}-${randomUUID().slice(0, 8)}`
  const [tenant] = await sql<{ id: string }[]>`
    insert into public.tenants (slug, name, status, timezone)
    values (${slug}, ${'Studio ' + slug}, ${opts.status ?? 'active'}, 'Europe/Moscow') returning id`
  const id = tenant!.id
  await sql`insert into public.tenant_profiles (tenant_id, accent_hex) values (${id}, '#d6a84a')`
  await sql`insert into public.tenant_settings (tenant_id, min_notice_min, horizon_days, cancel_cutoff_hours,
                                                requires_confirmation_default, max_active_bookings_per_phone)
            values (${id}, 0, 60, 24, false, ${opts.maxActive ?? 50})`
  for (let d = 1; d <= 7; d++) {
    await sql`insert into public.working_hours (tenant_id, weekday, opens, closes) values (${id}, ${d}, '00:00', '23:59')`
  }
  const [svc] = await sql<{ id: string }[]>`
    insert into public.services (tenant_id, slug, category, name, resource_type, duration_min, price_from_minor,
                                 buffer_after_min)
    values (${id}, 'wash', 'detailing_wash', 'Детейлинг-мойка', 'wash_bay', 120, 350000, ${opts.bufferAfter ?? 0})
    returning id`
  await sql`insert into public.service_variants (tenant_id, service_id, vehicle_class, duration_min, price_from_minor)
            values (${id}, ${svc!.id}, 'suv', 180, 450000)`
  const [md] = await sql<{ id: string }[]>`
    insert into public.services (tenant_id, slug, category, name, resource_type, duration_min, price_from_minor, multi_day)
    values (${id}, 'ceramic', 'ceramic_coating', 'Керамика', 'wash_bay', 960, 4500000, true) returning id`
  const resourceIds: string[] = []
  for (let i = 1; i <= (opts.bays ?? 1); i++) {
    const [r] = await sql<{ id: string }[]>`
      insert into public.resources (tenant_id, key, type, name, sort)
      values (${id}, ${'bay-' + i}, 'wash_bay', ${'Бокс ' + i}, ${i}) returning id`
    resourceIds.push(r!.id)
  }
  const ownerId = await createAuthUser(sql, `owner-${slug}@example.test`)
  const staffId = await createAuthUser(sql, `staff-${slug}@example.test`)
  await sql`insert into public.tenant_members (tenant_id, user_id, role) values (${id}, ${ownerId}, 'owner'), (${id}, ${staffId}, 'staff')`
  return { id, slug, ownerId, staffId, serviceId: svc!.id, multiDayServiceId: md!.id, resourceIds }
}

export interface BookingInput {
  tenantId: string
  serviceId: string
  start: Date
  end: Date
  vehicleClass?: string
  phone?: string
  name?: string
  idempotencyKey?: string
  requestHash?: string
  bookingId?: string
  plate?: string | null
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

export async function book(sql: Sql, b: BookingInput): Promise<{ booking_id: string; ref_code: string; status: string; replayed: boolean }> {
  const bookingId = b.bookingId ?? randomUUID()
  return asService(sql, async (tx) => {
    const [row] = await tx<{ r: { booking_id: string; ref_code: string; status: string; replayed: boolean } }[]>`
      select private.create_booking(
        ${b.tenantId}, ${bookingId}, ${b.idempotencyKey ?? randomUUID()}, ${b.requestHash ?? 'h'},
        ${hashToken(bookingId)}, ${b.serviceId}, ${b.vehicleClass ?? 'sedan'}::public.vehicle_class,
        ${b.start}, ${b.end},
        ${tx.json({ name: b.name ?? 'Иван', phone_e164: b.phone ?? `+7999${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` })},
        ${tx.json({ make: 'BMW', model: 'X5', year: 2021, color: 'черный', plate: b.plate ?? null })},
        '', 'customer') as r`
    return row!.r
  })
}

/** A future instant aligned to the hour, `hours` from now. */
export function hoursFromNow(hours: number): Date {
  const d = new Date(Date.now() + hours * 3_600_000)
  d.setUTCMinutes(0, 0, 0)
  return d
}

export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000)
}
