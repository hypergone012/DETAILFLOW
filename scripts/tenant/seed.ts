/**
 * Upserts tenants from tenants/{slug}/business.json into Postgres.
 *
 *   tsx scripts/tenant/seed.ts --all
 *   tsx scripts/tenant/seed.ts graphite --status active
 *
 * Idempotent: natural keys (tenant slug, service slug, resource key).
 * Services/resources removed from the config are deactivated, never deleted
 * (bookings reference them).
 */
import postgres from 'postgres'
import type { Business } from '@detailflow/config'
import { rubToMinor } from '@detailflow/domain'
import { LOCAL, env } from '../lib/env.ts'
import { createUser, setPassword } from '../lib/gotrue.ts'
import { assetUrl, loadTenant, tenantSlugs } from './load.ts'

const ISO_DAY = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 } as const

export async function seedTenant(sql: postgres.Sql, b: Business, statusOverride?: 'demo' | 'active'): Promise<string> {
  const status = statusOverride ?? b.status
  return sql.begin(async (tx) => {
    const [t] = await tx<{ id: string }[]>`
      insert into public.tenants (slug, name, status, timezone, currency, locale)
      values (${b.slug}, ${b.name}, ${status}, ${b.timezone}, ${b.currency}, ${b.locale})
      on conflict (slug) do update set name = excluded.name, status = excluded.status,
        timezone = excluded.timezone, currency = excluded.currency, locale = excluded.locale
      returning id`
    const id = t!.id
    const gallery = b.branding.gallery.map((g) => ({ url: assetUrl(b.slug, g.src), caption: g.caption }))
    await tx`
      insert into public.tenant_profiles (tenant_id, accent_hex, tagline, about, address, map_url, phone_display, phone_e164,
                                          telegram_url, whatsapp_url, logo_url, hero_url, gallery)
      values (${id}, ${b.branding.accent}, ${b.branding.tagline}, ${b.branding.about}, ${b.contacts.address},
              ${b.contacts.mapUrl ?? null}, ${b.contacts.phoneDisplay ?? null}, ${b.contacts.phone ?? null},
              ${b.contacts.telegramUrl ?? null}, ${b.contacts.whatsappUrl ?? null},
              ${b.branding.logo ? assetUrl(b.slug, b.branding.logo) : null}, ${assetUrl(b.slug, b.branding.hero)}, ${tx.json(gallery)})
      on conflict (tenant_id) do update set accent_hex = excluded.accent_hex, tagline = excluded.tagline, about = excluded.about,
        address = excluded.address, map_url = excluded.map_url, phone_display = excluded.phone_display,
        phone_e164 = excluded.phone_e164, telegram_url = excluded.telegram_url, whatsapp_url = excluded.whatsapp_url,
        logo_url = excluded.logo_url, hero_url = excluded.hero_url, gallery = excluded.gallery, updated_at = now()`
    await tx`
      insert into public.tenant_settings (tenant_id, slot_step_min, min_notice_min, horizon_days, cancel_cutoff_hours,
                                          requires_confirmation_default, max_active_bookings_per_phone, ai_enabled)
      values (${id}, ${b.policy.slotStepMin}, ${b.policy.minNoticeMin}, ${b.policy.horizonDays}, ${b.policy.cancelCutoffHours},
              ${b.policy.requiresConfirmation}, ${b.policy.maxActiveBookingsPerPhone}, ${b.ai.enabled})
      on conflict (tenant_id) do update set slot_step_min = excluded.slot_step_min, min_notice_min = excluded.min_notice_min,
        horizon_days = excluded.horizon_days, cancel_cutoff_hours = excluded.cancel_cutoff_hours,
        requires_confirmation_default = excluded.requires_confirmation_default,
        max_active_bookings_per_phone = excluded.max_active_bookings_per_phone, ai_enabled = excluded.ai_enabled,
        updated_at = now()`

    for (const [i, r] of b.resources.entries()) {
      await tx`
        insert into public.resources (tenant_id, key, type, name, sort, active)
        values (${id}, ${r.key}, ${r.type}, ${r.name}, ${i}, true)
        on conflict (tenant_id, key) do update set type = excluded.type, name = excluded.name, sort = excluded.sort, active = true`
    }
    await tx`update public.resources set active = false where tenant_id = ${id} and key <> all(${b.resources.map((r) => r.key)})`

    for (const [i, s] of b.services.entries()) {
      const [svc] = await tx<{ id: string }[]>`
        insert into public.services (tenant_id, slug, category, name, summary, description, requirements, resource_type,
                                     duration_min, price_from_minor, buffer_before_min, buffer_after_min, multi_day,
                                     requires_confirmation, sort, active)
        values (${id}, ${s.slug}, ${s.category}, ${s.name}, ${s.summary}, ${s.description}, ${s.requirements}, ${s.resourceType},
                ${s.durationMin}, ${rubToMinor(s.priceFrom)}, ${s.bufferBeforeMin}, ${s.bufferAfterMin}, ${s.multiDay},
                ${s.requiresConfirmation ?? null}, ${i}, true)
        on conflict (tenant_id, slug) do update set category = excluded.category, name = excluded.name, summary = excluded.summary,
          description = excluded.description, requirements = excluded.requirements, resource_type = excluded.resource_type,
          duration_min = excluded.duration_min, price_from_minor = excluded.price_from_minor,
          buffer_before_min = excluded.buffer_before_min, buffer_after_min = excluded.buffer_after_min,
          multi_day = excluded.multi_day, requires_confirmation = excluded.requires_confirmation, sort = excluded.sort, active = true
        returning id`
      await tx`delete from public.service_variants where service_id = ${svc!.id}`
      for (const [cls, v] of Object.entries(s.variants)) {
        await tx`insert into public.service_variants (tenant_id, service_id, vehicle_class, duration_min, price_from_minor)
                 values (${id}, ${svc!.id}, ${cls}, ${v.durationMin}, ${rubToMinor(v.priceFrom)})`
      }
    }
    await tx`update public.services set active = false where tenant_id = ${id} and slug <> all(${b.services.map((s) => s.slug)})`

    await tx`delete from public.working_hours where tenant_id = ${id}`
    for (const [day, ranges] of Object.entries(b.hours)) {
      for (const [opens, closes] of ranges) {
        await tx`insert into public.working_hours (tenant_id, weekday, opens, closes)
                 values (${id}, ${ISO_DAY[day as keyof typeof ISO_DAY]}, ${opens}, ${closes})`
      }
    }
    await tx`delete from public.schedule_exceptions where tenant_id = ${id}`
    for (const e of b.exceptions) {
      await tx`insert into public.schedule_exceptions (tenant_id, local_date, closed, opens, closes, note)
               values (${id}, ${e.date}, ${e.closed}, ${e.opens ?? null}, ${e.closes ?? null}, ${e.note ?? ''})`
    }
    return id
  })
}

/** DF_OWNER_PASSWORD_<SLUG> (e.g. DF_OWNER_PASSWORD_ICE_LAB) overrides the shared demo password per studio. */
export function ownerPassword(slug: string, fallback: string): string {
  return process.env[`DF_OWNER_PASSWORD_${slug.toUpperCase().replace(/-/g, '_')}`] || fallback
}

export async function ensureMembers(sql: postgres.Sql, tenantId: string, b: Business, password: string, syncPassword = false): Promise<void> {
  for (const o of b.owners) {
    const created = await createUser(o.email, password)
    const [u] = await sql<{ id: string }[]>`select id from auth.users where email = ${o.email}`
    if (!u) throw new Error(`auth user ${o.email} not found after creation`)
    if (!created && syncPassword) await setPassword(u.id, password)
    await sql`insert into public.tenant_members (tenant_id, user_id, role) values (${tenantId}, ${u.id}, ${o.role})
              on conflict (tenant_id, user_id) do update set role = excluded.role`
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const statusIdx = args.indexOf('--status')
  const status = statusIdx >= 0 ? (args[statusIdx + 1] as 'demo' | 'active') : undefined
  const slugs = args.includes('--all') ? tenantSlugs() : args.filter((a, i) => !a.startsWith('--') && (statusIdx < 0 || i !== statusIdx + 1))
  if (slugs.length === 0) throw new Error('usage: seed.ts <slug...> | --all [--status demo|active]')
  const password = env('DF_DEMO_OWNER_PASSWORD', 'detailflow-demo')
  const sql = postgres(env('DATABASE_URL', LOCAL.databaseUrl), { max: 2, onnotice: () => {} })
  try {
    for (const slug of slugs) {
      const result = loadTenant(slug)
      if (!result.ok) throw new Error(`${slug}: invalid business.json\n  ${result.errors.join('\n  ')}`)
      const id = await seedTenant(sql, result.business!, status)
      await ensureMembers(sql, id, result.business!, ownerPassword(slug, password), process.env.DF_SYNC_OWNER_PASSWORDS === '1')
      console.log(`seeded ${slug} (${id}) owners: ${result.business!.owners.map((o) => o.email).join(', ')}`)
    }
  } finally {
    await sql.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
