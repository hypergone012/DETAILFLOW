import { describe, expect, it } from 'vitest'
import { clientIp, routeSegments } from './http.ts'

const req = (headers: Record<string, string>) => new Request('http://x/functions/v1/public-api/a/b', { headers })

describe('clientIp', () => {
  it('ignores client-supplied left part of X-Forwarded-For', () => {
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('203.0.113.7')
  })
  it('prefers Cloudflare’s connecting IP', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '6.6.6.6' }))).toBe('198.51.100.1')
  })
  it('falls back safely', () => {
    expect(clientIp(req({}))).toBe('unknown')
  })
})

describe('routeSegments', () => {
  it('strips everything up to the function name', () => {
    expect(routeSegments(req({}), 'public-api')).toEqual(['a', 'b'])
    expect(routeSegments(new Request('http://x/public-api/storefront/graphite'), 'public-api')).toEqual(['storefront', 'graphite'])
  })
})
