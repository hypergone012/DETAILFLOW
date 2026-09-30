import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { HttpError } from './http.ts'

export interface AuthConfig {
  /** Hosted Supabase (asymmetric signing keys): https://<ref>.supabase.co/auth/v1/.well-known/jwks.json */
  jwksUrl?: string | undefined
  /** Legacy/local symmetric secret (HS256). */
  jwtSecret?: string | undefined
}

export interface UserClaims extends JWTPayload {
  sub: string
  role: 'authenticated'
  email?: string
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

/** Verifies a Supabase Auth access token. Throws 401 on anything unexpected. */
export async function verifyAccessToken(req: Request, cfg: AuthConfig): Promise<UserClaims> {
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) throw new HttpError(401, 'UNAUTHORIZED')
  try {
    const opts = { audience: 'authenticated' }
    let payload: JWTPayload
    if (cfg.jwksUrl) {
      jwks ??= createRemoteJWKSet(new URL(cfg.jwksUrl))
      payload = (await jwtVerify(token, jwks, opts)).payload
    } else if (cfg.jwtSecret) {
      payload = (await jwtVerify(token, new TextEncoder().encode(cfg.jwtSecret), { ...opts, algorithms: ['HS256'] })).payload
    } else {
      throw new Error('no JWT verification configured')
    }
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') throw new Error('not a user token')
    return payload as UserClaims
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED')
  }
}
