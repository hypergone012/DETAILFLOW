/**
 * Tenant pipeline: new -> validate -> seed -> invite-owner -> activate -> export.
 * Library functions (tested) behind a thin CLI (cli.ts).
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { businessSchema, checkAccentContrast, type Business } from '@detailflow/config'
import type postgres from 'postgres'
import { LOCAL, env } from '../lib/env.ts'
import { adminHeaders, serviceRoleKey } from '../lib/gotrue.ts'
import { TENANTS_DIR, loadTenant } from './load.ts'

export function createTenantFromTemplate(opts: { slug: string; name: string; timezone?: string; accent?: string; dir?: string }): string {
  const root = opts.dir ?? TENANTS_DIR
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(opts.slug)) throw new Error(`invalid slug "${opts.slug}": lowercase latin, digits, dashes`)
  const target = join(root, opts.slug)
  if (existsSync(target)) throw new Error(`tenants/${opts.slug} already exists`)
  if (opts.accent && !checkAccentContrast(opts.accent).ok) throw new Error(`accent ${opts.accent} fails WCAG contrast on the dark theme`)
  cpSync(join(root, '_template'), target, { recursive: true })
  const b = JSON.parse(readFileSync(join(target, 'business.json'), 'utf8')) as Business
  b.slug = opts.slug
  b.name = opts.name
  b.status = 'draft'
  if (opts.timezone) b.timezone = opts.timezone
  if (opts.accent) b.branding.accent = opts.accent
  b.owners = [{ email: `owner@${opts.slug}.test`, role: 'owner' }]
  writeFileSync(join(target, 'business.json'), JSON.stringify(b, null, 2) + '\n')
  return target
}

/** Creates (or reuses) a Supabase Auth user via an invite link and adds the membership. */
export async function inviteOwner(sql: postgres.Sql, slug: string, email: string, role: 'owner' | 'manager' | 'staff' = 'owner'): Promise<{ userId: string; acceptLink: string | null }> {
  const [tenant] = await sql<{ id: string }[]>`select id from public.tenants where slug = ${slug}`
  if (!tenant) throw new Error(`tenant ${slug} is not seeded`)
  const key = await serviceRoleKey()
  const res = await fetch(`${env('AUTH_URL', LOCAL.authUrl)}/admin/generate_link`, {
    method: 'POST',
    headers: adminHeaders(key),
    body: JSON.stringify({ type: 'invite', email }),
  })
  // The link points at the app, which exchanges the one-time token (verifyOtp) and asks for a password.
  let acceptLink: string | null = null
  if (res.ok) {
    const hashed = ((await res.json()) as { hashed_token?: string }).hashed_token
    if (hashed) acceptLink = `${env('DF_APP_URL', 'http://127.0.0.1:5173')}/s/${slug}/owner/accept?token_hash=${hashed}&type=invite`
  } else if (res.status !== 422) {
    throw new Error(`gotrue ${res.status}: ${await res.text()}`) // 422: already registered, just add membership
  }
  const [user] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`
  if (!user) throw new Error(`auth user ${email} not found`)
  await sql`insert into public.tenant_members (tenant_id, user_id, role) values (${tenant.id}, ${user.id}, ${role})
            on conflict (tenant_id, user_id) do update set role = excluded.role`
  return { userId: user.id, acceptLink }
}

export interface ActivationCheck {
  ok: boolean
  problems: string[]
  warnings: string[]
}

/** Go-live gate. Demo artwork, a missing owner or an invalid config block activation. */
export async function activationCheck(sql: postgres.Sql, slug: string, business: Business): Promise<ActivationCheck> {
  const problems: string[] = []
  const warnings: string[] = []
  if (business.branding.demoArtwork) problems.push('branding.demoArtwork is true: replace demo artwork with the studio’s own photos')
  if (!business.contacts.phone) problems.push('contacts.phone is required for a live studio')
  const [t] = await sql<{ id: string; status: string }[]>`select id, status from public.tenants where slug = ${slug}`
  if (!t) {
    problems.push('tenant is not seeded')
    return { ok: false, problems, warnings }
  }
  const [{ owners }] = (await sql`select count(*)::int as owners from public.tenant_members where tenant_id = ${t.id} and role = 'owner'`) as unknown as [{ owners: number }]
  if (owners === 0) problems.push('no owner account: run tenant:invite-owner')
  const [s] = await sql<{ telegram_chat_id: string | null }[]>`select telegram_chat_id from public.tenant_settings where tenant_id = ${t.id}`
  if (!s?.telegram_chat_id) warnings.push('no Telegram chat configured: new bookings will show as not_configured')
  return { ok: problems.length === 0, problems, warnings }
}

export async function activate(sql: postgres.Sql, slug: string, dir = TENANTS_DIR): Promise<ActivationCheck> {
  const loaded = loadTenant(slug, dir)
  if (!loaded.ok) return { ok: false, problems: loaded.errors, warnings: [] }
  const check = await activationCheck(sql, slug, loaded.business!)
  if (!check.ok) return check
  await sql`update public.tenants set status = 'active' where slug = ${slug}`
  const path = join(dir, slug, 'business.json')
  const b = JSON.parse(readFileSync(path, 'utf8')) as Business
  b.status = 'active'
  writeFileSync(path, JSON.stringify(b, null, 2) + '\n')
  return check
}

const DAY_KEY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

/** DB -> business.json shape (runtime is the source of truth after go-live). */
export async function exportTenant(sql: postgres.Sql, slug: string, base: Business): Promise<Business> {
  const [t] = await sql<{ id: string; name: string; status: 'draft' | 'demo' | 'active'; timezone: string }[]>`
    select id, name, status, timezone from public.tenants where slug = ${slug}`
  if (!t) throw new Error(`tenant ${slug} is not seeded`)
  const [p] = await sql`select * from public.tenant_profiles where tenant_id = ${t.id}`
  const [s] = await sql`select * from public.tenant_settings where tenant_id = ${t.id}`
  const hours = await sql<{ weekday: number; opens: string; closes: string }[]>`
    select weekday, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes from public.working_hours where tenant_id = ${t.id} order by weekday, opens`
  const exceptions = await sql<{ d: string; closed: boolean; opens: string | null; closes: string | null; note: string }[]>`
    select to_char(local_date, 'YYYY-MM-DD') as d, closed, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes, note
    from public.schedule_exceptions where tenant_id = ${t.id} order by local_date`
  const resources = await sql<{ key: string; type: Business['resources'][number]['type']; name: string }[]>`
    select key, type, name from public.resources where tenant_id = ${t.id} and active order by sort, key`
  const services = await sql`select * from public.services where tenant_id = ${t.id} and active order by sort, slug`
  const variants = await sql`select * from public.service_variants where tenant_id = ${t.id}`
  const out: Business = {
    ...base,
    name: t.name,
    status: t.status === 'draft' || t.status === 'demo' || t.status === 'active' ? t.status : base.status,
    timezone: t.timezone,
    branding: { ...base.branding, accent: p!.accent_hex, tagline: p!.tagline, about: p!.about },
    policy: {
      slotStepMin: s!.slot_step_min, minNoticeMin: s!.min_notice_min, horizonDays: s!.horizon_days,
      cancelCutoffHours: s!.cancel_cutoff_hours, requiresConfirmation: s!.requires_confirmation_default,
      maxActiveBookingsPerPhone: s!.max_active_bookings_per_phone,
    },
    hours: Object.fromEntries(DAY_KEY.map((k, i) => [k, hours.filter((h) => h.weekday === i + 1).map((h) => [h.opens, h.closes])])) as Business['hours'],
    exceptions: exceptions.map((e) => ({ date: e.d, closed: e.closed, ...(e.opens ? { opens: e.opens } : {}), ...(e.closes ? { closes: e.closes } : {}), ...(e.note ? { note: e.note } : {}) })),
    resources: resources.map((r) => ({ key: r.key, type: r.type, name: r.name })),
    services: services.map((sv) => ({
      slug: sv.slug, category: sv.category, name: sv.name, summary: sv.summary, description: sv.description,
      requirements: sv.requirements, resourceType: sv.resource_type, durationMin: sv.duration_min,
      priceFrom: Number(sv.price_from_minor) / 100, bufferBeforeMin: sv.buffer_before_min, bufferAfterMin: sv.buffer_after_min,
      multiDay: sv.multi_day, ...(sv.requires_confirmation === null ? {} : { requiresConfirmation: sv.requires_confirmation }),
      variants: Object.fromEntries(variants.filter((v) => v.service_id === sv.id).map((v) => [v.vehicle_class, { durationMin: v.duration_min, priceFrom: Number(v.price_from_minor) / 100 }])),
    })),
    ai: { enabled: s!.ai_enabled },
  }
  return businessSchema.parse(out)
}
