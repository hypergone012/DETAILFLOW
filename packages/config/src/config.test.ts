import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkAccentContrast, contrastRatio, deriveAccentTokens } from './theme.ts'
import { validateBusiness } from './validate.ts'

const TENANTS = join(import.meta.dirname, '../../../tenants')
const load = (slug: string) => JSON.parse(readFileSync(join(TENANTS, slug, 'business.json'), 'utf8')) as Record<string, unknown>
const env = (slug: string) => ({ assetExists: (p: string) => existsSync(join(TENANTS, slug, p)) })

describe('demo tenants', () => {
  it.each(['graphite', 'ice-lab'])('%s business.json is valid', (slug) => {
    const r = validateBusiness(load(slug), env(slug))
    expect(r.errors).toEqual([])
  })

  it('the two demo studios are intentionally different', () => {
    const a = validateBusiness(load('graphite'), env('graphite')).business!
    const b = validateBusiness(load('ice-lab'), env('ice-lab')).business!
    expect(a.timezone).not.toBe(b.timezone)
    expect(a.branding.accent).not.toBe(b.branding.accent)
    expect(a.policy.slotStepMin).not.toBe(b.policy.slotStepMin)
    expect(a.services.filter((s) => b.services.some((x) => x.slug === s.slug))).toEqual([])
  })
})

describe('validation errors', () => {
  const base = () => load('graphite')
  const run = (b: Record<string, unknown>) => validateBusiness(b, env('graphite'))

  it('rejects unknown keys (strict schema)', () => {
    expect(run({ ...base(), tenant_id: 'x' }).ok).toBe(false)
  })

  it('rejects a low-contrast accent instead of silently fixing it', () => {
    const b = base()
    ;(b.branding as Record<string, unknown>).accent = '#2a2a2a'
    expect(run(b).errors.join()).toMatch(/contrast too low/)
  })

  it('rejects a service without a resource of its type', () => {
    const b = base()
    b.resources = (b.resources as Array<{ type: string }>).filter((r) => r.type !== 'ppf_booth')
    expect(run(b).errors.join()).toMatch(/no resource of type ppf_booth/)
  })

  it('rejects overlapping hours and unknown timezones', () => {
    const b = base()
    ;(b.hours as Record<string, unknown>).mon = [['09:00', '13:00'], ['12:00', '18:00']]
    b.timezone = 'Mars/Olympus'
    const errors = run(b).errors.join()
    expect(errors).toMatch(/overlapping/)
    expect(errors).toMatch(/unknown IANA zone/)
  })

  it('rejects a same-day service that does not fit the working day', () => {
    const b = base()
    const svc = (b.services as Array<Record<string, unknown>>)[0]!
    svc.durationMin = 800
    expect(run(b).errors.join()).toMatch(/does not fit any working interval/)
  })

  it('rejects missing assets', () => {
    const b = base()
    ;(b.branding as Record<string, unknown>).hero = 'assets/missing.jpg'
    expect(run(b).errors.join()).toMatch(/asset missing/)
  })
})

describe('accent tokens', () => {
  it('picks the readable label color and reports WCAG ratios', () => {
    expect(deriveAccentTokens('#d6a84a').onAccent).toBe('#0b0c0e')
    expect(deriveAccentTokens('#1f4fd8').onAccent).toBe('#ffffff')
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0)
    expect(checkAccentContrast('#d6a84a').ok).toBe(true)
    expect(checkAccentContrast('#333333').ok).toBe(false)
  })
})
