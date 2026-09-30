import { describe, expect, it } from 'vitest'
import { isWellFormedToken, manageToken, timingSafeEqual } from './crypto.ts'

describe('crypto helpers', () => {
  it('timingSafeEqual compares whole strings', () => {
    expect(timingSafeEqual('s3cret', 's3cret')).toBe(true)
    expect(timingSafeEqual('s3cret', 's3creT')).toBe(false)
    expect(timingSafeEqual('s3cret', 's3cret-longer')).toBe(false)
    expect(timingSafeEqual('', 'x')).toBe(false)
  })

  it('manage tokens carry 256 bits and differ per booking', async () => {
    const a = await manageToken('x'.repeat(32), 'booking-a')
    const b = await manageToken('x'.repeat(32), 'booking-b')
    expect(isWellFormedToken(a)).toBe(true)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(a).not.toBe(b)
    expect(await manageToken('y'.repeat(32), 'booking-a')).not.toBe(a)
  })
})
