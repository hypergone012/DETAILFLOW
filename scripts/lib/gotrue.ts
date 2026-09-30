import { SignJWT } from 'jose'
import { LOCAL, env } from './env.ts'

/**
 * Minimal Supabase Auth (GoTrue) admin client.
 * Hosted: AUTH_URL=https://<ref>.supabase.co/auth/v1 + SUPABASE_SERVICE_ROLE_KEY.
 * Local:  the service-role JWT is minted with the local JWT secret.
 */
export async function serviceRoleKey(): Promise<string> {
  const given = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (given) return given
  return new SignJWT({ role: 'service_role' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(env('DF_JWT_SECRET', LOCAL.jwtSecret)))
}

export interface AdminUser {
  id: string
  email: string
}

/** Creates a confirmed email/password user. Returns null when the email already exists. */
export async function createUser(email: string, password: string): Promise<AdminUser | null> {
  const key = await serviceRoleKey()
  const res = await fetch(`${env('AUTH_URL', LOCAL.authUrl)}/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  if (res.status === 422) {
    const body = (await res.json()) as { error_code?: string; code?: string | number }
    if (body.error_code === 'email_exists' || body.code === 'email_exists') return null
    throw new Error(`gotrue: ${JSON.stringify(body)}`)
  }
  if (!res.ok) throw new Error(`gotrue ${res.status}: ${await res.text()}`)
  const user = (await res.json()) as AdminUser
  return { id: user.id, email: user.email }
}
