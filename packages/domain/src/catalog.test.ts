import { describe, expect, it } from 'vitest'
import { formatDuration, plural, resolveVariant } from './catalog.ts'
import { normalizePhone, normalizePlate } from './phone.ts'

describe('catalog', () => {
  it('resolves variant price/duration by vehicle class with base fallback', () => {
    const base = { durationMin: 120, priceFromMinor: 350000 }
    const variants = [{ vehicleClass: 'suv' as const, durationMin: 180, priceFromMinor: 450000 }]
    expect(resolveVariant(base, variants, 'suv')).toEqual({ durationMin: 180, priceFromMinor: 450000 })
    expect(resolveVariant(base, variants, 'compact')).toEqual(base)
  })

  it('formats durations in Russian', () => {
    expect(formatDuration(90, false)).toBe('1 ч 30 мин')
    expect(formatDuration(120, false)).toBe('2 ч')
    expect(formatDuration(1500, true)).toBe('3 дня')
    expect(plural(5, 'день', 'дня', 'дней')).toBe('дней')
    expect(plural(21, 'день', 'дня', 'дней')).toBe('день')
  })
})

describe('phone & plate', () => {
  it('normalizes Russian numbers to E.164', () => {
    expect(normalizePhone('8 (916) 123-45-67')).toBe('+79161234567')
    expect(normalizePhone('+7 916 123 45 67')).toBe('+79161234567')
    expect(normalizePhone('12345')).toBeNull()
  })
  it('normalizes plates', () => {
    expect(normalizePlate(' а 123 бв 77 ')).toBe('А123БВ77')
    expect(normalizePlate('')).toBeNull()
  })
})
