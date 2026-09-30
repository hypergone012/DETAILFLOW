import { describe, expect, it } from 'vitest'
import { formatPriceFrom, formatRub, rubToMinor } from './money.ts'

describe('money', () => {
  it('formats kopecks as whole rubles in ru-RU', () => {
    expect(formatRub(4_500_000).replace(/\s/g, ' ')).toBe('45 000 ₽')
  })
  it('prefixes price_from with "от"', () => {
    expect(formatPriceFrom(150_000).replace(/\s/g, ' ')).toBe('от 1 500 ₽')
  })
  it('rejects non-integer minor units', () => {
    expect(() => formatRub(10.5)).toThrow(TypeError)
  })
  it('converts rubles to minor units', () => {
    expect(rubToMinor(45000)).toBe(4_500_000)
    expect(() => rubToMinor(-1)).toThrow(RangeError)
  })
})
