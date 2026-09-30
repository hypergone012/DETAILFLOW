import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateBusiness } from '@detailflow/config'
import { SignJWT } from 'jose'
import { seedTenant } from '../../scripts/tenant/seed.ts'
import { createAuthUser, type Sql } from '../db/harness.ts'

export const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
export const JWT_ISSUER = 'http://127.0.0.1:54321/auth/v1'
export const TOKEN_SECRET = 'test-manage-token-secret'
export const CORS = { allowedOrigins: ['http://127.0.0.1:5173'] }

const TENANTS = join(import.meta.dirname, '../../tenants')

export async function seedDemo(sql: Sql): Promise<{ graphite: string; iceLab: string; graphiteOwner: string; iceOwner: string }> {
  const load = (slug: string) =>
    validateBusiness(JSON.parse(readFileSync(join(TENANTS, slug, 'business.json'), 'utf8')), {
      assetExists: (p) => existsSync(join(TENANTS, slug, p)),
    }).business!
  const graphite = await seedTenant(sql, load('graphite'))
  const iceLab = await seedTenant(sql, load('ice-lab'))
  const graphiteOwner = await createAuthUser(sql, `owner-${randomUUID()}@graphite.test`)
  const iceOwner = await createAuthUser(sql, `owner-${randomUUID()}@ice.test`)
  await sql`insert into public.tenant_members (tenant_id, user_id, role) values (${graphite}, ${graphiteOwner}, 'owner'), (${iceLab}, ${iceOwner}, 'owner')`
  return { graphite, iceLab, graphiteOwner, iceOwner }
}

/** Same shape and signature as a Supabase Auth (GoTrue) access token with the local HS256 secret. */
export async function accessToken(
  userId: string,
  secret = JWT_SECRET,
  opts: { issuer?: string; expiresAt?: number; extra?: Record<string, unknown> } = {},
): Promise<string> {
  return new SignJWT({ role: 'authenticated', aud: 'authenticated', email: 'owner@example.test', is_anonymous: false, ...opts.extra })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(opts.issuer ?? JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expiresAt ?? '1h')
    .sign(new TextEncoder().encode(secret))
}

let ipCounter = 0
// Test responses are asserted structurally with expect(); untyped JSON keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
export interface CallResult<T = Json> {
  status: number
  body: T
  headers: Headers
}

export async function call<T = Json>(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ip?: string } = {},
): Promise<CallResult<T>> {
  ipCounter += 1
  const headers: Record<string, string> = {
    origin: 'http://127.0.0.1:5173',
    'x-forwarded-for': opts.ip ?? `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await handler(new Request(`http://localhost/functions/v1${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }))
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers }
}

let phoneCounter = 1_000_000
export function uniquePhone(): string {
  phoneCounter += 1
  return `+7916${String(phoneCounter).padStart(7, '0')}`
}

export function bookingBody(serviceId: string, startAt: string, overrides: Record<string, unknown> = {}) {
  return {
    serviceId,
    startAt,
    vehicle: { make: 'Toyota', model: 'Camry', year: 2022, color: 'Белый', vehicleClass: 'sedan', plate: 'а123вс 77', notes: '' },
    customer: { name: 'Пётр', phone: uniquePhone(), email: null, consent: true },
    comment: '',
    idempotencyKey: randomUUID(),
    ...overrides,
  }
}
