import { API_ERROR_MESSAGES } from '@detailflow/domain'
import type { z } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? API_ERROR_MESSAGES[code] ?? code)
  }
}

/** Domain error codes raised by SQL functions (MESSAGE of SQLSTATE P0001) → HTTP status. */
const DB_ERROR_STATUS: Record<string, number> = {
  SLOT_TAKEN: 409,
  IDEMPOTENCY_CONFLICT: 409,
  TENANT_UNAVAILABLE: 403,
  SERVICE_NOT_FOUND: 404,
  INVALID_WINDOW: 422,
  OUTSIDE_BOOKING_WINDOW: 422,
  TOO_MANY_ACTIVE_BOOKINGS: 422,
  BOOKING_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  CUTOFF_PASSED: 409,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
}

export function fromDbError(err: unknown): HttpError | null {
  const e = err as { code?: string; message?: string }
  if (e?.code === 'P0001' && e.message && e.message in DB_ERROR_STATUS) {
    return new HttpError(DB_ERROR_STATUS[e.message]!, e.message)
  }
  return null
}

export interface CorsConfig {
  allowedOrigins: readonly string[]
}

export function corsHeaders(req: Request, cfg: CorsConfig): Record<string, string> {
  const origin = req.headers.get('origin')
  // Exact-match allowlist only; no wildcard support by design.
  const allowed = origin && cfg.allowedOrigins.includes(origin)
  return {
    ...(allowed ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600',
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  })
}

export function errorResponse(err: unknown, log: (msg: string, extra?: Record<string, unknown>) => void): Response {
  const http = err instanceof HttpError ? err : fromDbError(err)
  if (http) return json({ error: { code: http.code, message: http.message } }, http.status)
  // Never log messages/details: Postgres errors can carry row values (PII).
  const e = err as { name?: string; code?: string; constraint_name?: string }
  log('unhandled error', { error: e?.name ?? typeof err, code: e?.code ?? null, constraint: e?.constraint_name ?? null })
  return json({ error: { code: 'INTERNAL', message: API_ERROR_MESSAGES.INTERNAL } }, 500)
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  // Cap on the bytes actually received (Content-Length can be absent with chunked bodies).
  const MAX = 64_000
  if (Number(req.headers.get('content-length') ?? '0') > MAX) throw new HttpError(413, 'VALIDATION_FAILED')
  let raw: unknown
  try {
    const reader = req.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX) {
        await reader.cancel()
        throw new HttpError(413, 'VALIDATION_FAILED')
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const c of chunks) {
      bytes.set(c, offset)
      offset += c.byteLength
    }
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'VALIDATION_FAILED')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(400, 'VALIDATION_FAILED', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  return parsed.data
}

/** Path segments after the function name, e.g. /functions/v1/public-api/a/b → ['a','b']. */
export function routeSegments(req: Request, functionName: string): string[] {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const i = parts.indexOf(functionName)
  return i >= 0 ? parts.slice(i + 1) : parts
}

export interface ClientIpConfig {
  /**
   * Number of trusted proxies that append to X-Forwarded-For in front of the
   * function. The client address is the entry that many positions from the
   * right; everything further left is client-controlled and ignored.
   */
  trustedProxyHops: number
}

let ipConfig: ClientIpConfig = { trustedProxyHops: 1 }
export function configureClientIp(cfg: ClientIpConfig): void {
  ipConfig = { trustedProxyHops: Math.max(1, Math.floor(cfg.trustedProxyHops)) }
}

/**
 * Client IP for rate limiting. Headers a client can set freely
 * (cf-connecting-ip, x-real-ip, the left part of X-Forwarded-For) are not
 * trusted: a spoofed value must never let a client pick its own bucket.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean)
  if (!xff?.length) return 'unknown'
  return xff[Math.max(0, xff.length - ipConfig.trustedProxyHops)]!
}
