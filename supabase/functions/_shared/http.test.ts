import { afterEach, describe, expect, it } from 'vitest'
import { clientIp, configureClientIp, readJson, routeSegments } from './http.ts'
import { z } from 'zod'

const req = (headers: Record<string, string>) => new Request('http://x/functions/v1/public-api/a/b', { headers })

describe('clientIp', () => {
  afterEach(() => configureClientIp({ trustedProxyHops: 1 }))

  it('ignores the client-controlled left part of X-Forwarded-For', () => {
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('203.0.113.7')
  })
  it('never trusts headers a client can set directly', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '6.6.6.6', 'x-real-ip': '6.6.6.7', 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7')
    expect(clientIp(req({ 'cf-connecting-ip': '6.6.6.6' }))).toBe('unknown')
  })
  it('supports several trusted proxy hops', () => {
    configureClientIp({ trustedProxyHops: 2 })
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4, 10.0.0.1' }))).toBe('198.51.100.4')
  })
})

describe('readJson', () => {
  it('caps the body size on the bytes received, not on Content-Length', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(70_000) })
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close() } })
    const r = new Request('http://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    await expect(readJson(r, z.object({ a: z.string() }))).rejects.toMatchObject({ status: 413 })
  })
  it('rejects malformed JSON with 400', async () => {
    await expect(readJson(new Request('http://x', { method: 'POST', body: '{nope' }), z.object({}))).rejects.toMatchObject({ status: 400 })
  })
})

describe('routeSegments', () => {
  it('strips everything up to the function name', () => {
    expect(routeSegments(req({}), 'public-api')).toEqual(['a', 'b'])
    expect(routeSegments(new Request('http://x/public-api/storefront/graphite'), 'public-api')).toEqual(['storefront', 'graphite'])
  })
})
