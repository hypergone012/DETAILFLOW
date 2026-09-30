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
  const allowed = origin && (cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin))
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
  log('unhandled error', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  return json({ error: { code: 'INTERNAL', message: API_ERROR_MESSAGES.INTERNAL } }, 500)
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > 64_000) throw new HttpError(413, 'VALIDATION_FAILED')
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
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

/**
 * Client IP for rate limiting. Proxies append to X-Forwarded-For, so its left
 * part is client-controlled: only the rightmost entry (added by the closest
 * trusted proxy) is used. Cloudflare's header cannot be set by clients.
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const xff = req.headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean)
  if (xff?.length) return xff[xff.length - 1]!
  return req.headers.get('x-real-ip')?.trim() ?? 'unknown'
}
