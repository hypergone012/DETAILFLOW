import { WEEKDAY_KEYS, businessSchema, type Business } from './business.ts'
import { checkAccentContrast } from './theme.ts'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  business?: Business
}

export interface ValidationEnv {
  /** Whether tenants/{slug}/{path} exists. */
  assetExists: (path: string) => boolean
  /** Whether the IANA zone is known to the runtime. */
  isValidTimezone?: (tz: string) => boolean
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h! * 60 + m!
}

export function defaultIsValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Schema + semantic validation. Never auto-fixes: a studio config either passes or it does not. */
export function validateBusiness(raw: unknown, env: ValidationEnv): ValidationResult {
  const parsed = businessSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  }
  const b = parsed.data
  const errors: string[] = []

  if (!(env.isValidTimezone ?? defaultIsValidTimezone)(b.timezone)) errors.push(`timezone: unknown IANA zone ${b.timezone}`)

  const contrast = checkAccentContrast(b.branding.accent)
  if (!contrast.ok) {
    errors.push(`branding.accent: contrast too low (on background ${contrast.accentOnBackground.toFixed(2)}, label on accent ${contrast.textOnAccent.toFixed(2)}; need ≥ 4.5)`)
  }

  for (const day of WEEKDAY_KEYS) {
    const ranges = [...b.hours[day]].sort((x, y) => x[0].localeCompare(y[0]))
    ranges.forEach(([o, c], i) => {
      if (toMin(c) <= toMin(o)) errors.push(`hours.${day}[${i}]: closes must be after opens`)
      const next = ranges[i + 1]
      if (next && toMin(next[0]) < toMin(c)) errors.push(`hours.${day}: overlapping ranges`)
    })
  }
  if (WEEKDAY_KEYS.every((d) => b.hours[d].length === 0)) errors.push('hours: studio is never open')

  for (const [i, e] of b.exceptions.entries()) {
    if (!e.closed && (!e.opens || !e.closes || toMin(e.closes) <= toMin(e.opens))) errors.push(`exceptions[${i}]: open day needs opens < closes`)
  }

  const keys = new Set<string>()
  for (const r of b.resources) {
    if (keys.has(r.key)) errors.push(`resources: duplicate key ${r.key}`)
    keys.add(r.key)
  }
  const types = new Set(b.resources.map((r) => r.type))
  const slugs = new Set<string>()
  for (const s of b.services) {
    if (slugs.has(s.slug)) errors.push(`services: duplicate slug ${s.slug}`)
    slugs.add(s.slug)
    if (!types.has(s.resourceType)) errors.push(`services.${s.slug}: no resource of type ${s.resourceType}`)
    const maxDuration = Math.max(s.durationMin, ...Object.values(s.variants).map((v) => v.durationMin))
    if (!s.multiDay && maxDuration > 840) errors.push(`services.${s.slug}: same-day service longer than 14h must be multiDay`)
    if (!s.multiDay) {
      const longestDay = Math.max(...WEEKDAY_KEYS.flatMap((d) => b.hours[d].map(([o, c]) => toMin(c) - toMin(o))))
      if (maxDuration > longestDay) errors.push(`services.${s.slug}: does not fit any working interval; mark multiDay`)
    }
  }

  const assets = [b.branding.hero, b.branding.logo, ...b.branding.gallery.map((g) => g.src)].filter((a): a is string => !!a)
  for (const a of assets) if (!env.assetExists(a)) errors.push(`asset missing: ${a}`)

  const emails = new Set<string>()
  for (const o of b.owners) {
    if (emails.has(o.email)) errors.push(`owners: duplicate ${o.email}`)
    emails.add(o.email)
  }
  if (!b.owners.some((o) => o.role === 'owner')) errors.push('owners: at least one owner required')

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], business: b }
}
