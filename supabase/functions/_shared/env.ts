import type { Sql } from './db.ts'

/** Runtime configuration for Edge Functions (Deno). Values are never logged. */
export function requireEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

export function allowedOrigins(): string[] {
  return (Deno.env.get('DF_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('https://') || s.startsWith('http://127.0.0.1') || s.startsWith('http://localhost'))
}

/**
 * Database URL for the least-privilege `df_edge` role (DF_DB_URL, transaction
 * pooler recommended). Falling back to the platform-injected SUPABASE_DB_URL
 * (role `postgres`) requires an explicit acknowledgement.
 */
export function databaseUrl(): string {
  const url = Deno.env.get('DF_DB_URL')
  if (url) return url
  if (Deno.env.get('DF_ALLOW_PRIVILEGED_DB_ROLE') === 'true') return requireEnv('SUPABASE_DB_URL')
  throw new Error('missing env DF_DB_URL (df_edge role); see docs/PRODUCTION.md')
}

export function authConfig(): { jwksUrl?: string; jwtSecret?: string; issuer?: string } {
  const issuer = Deno.env.get('DF_JWT_ISSUER') ?? `${requireEnv('SUPABASE_URL')}/auth/v1`
  const jwtSecret = Deno.env.get('DF_JWT_SECRET')
  if (jwtSecret) return { jwtSecret, issuer }
  return { jwksUrl: `${requireEnv('SUPABASE_URL')}/auth/v1/.well-known/jwks.json`, issuer }
}

/** HMAC secret for manage links: refuse weak secrets (fail closed). */
export function manageTokenSecret(): string {
  const s = requireEnv('DF_MANAGE_TOKEN_SECRET')
  if (s.length < 32) throw new Error('DF_MANAGE_TOKEN_SECRET must be at least 32 characters')
  return s
}

/**
 * Refuses to serve when connected as a role that could bypass RLS or read
 * tables without SET ROLE (unless explicitly acknowledged).
 */
export async function assertLeastPrivilegeRole(sql: Sql): Promise<void> {
  const [r] = await sql<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }[]>`
    select current_user, r.rolsuper, r.rolbypassrls, r.rolinherit from pg_roles r where r.rolname = current_user`
  const privileged = !r || r.rolsuper || r.rolbypassrls || r.rolinherit
  if (privileged && Deno.env.get('DF_ALLOW_PRIVILEGED_DB_ROLE') !== 'true') {
    throw new Error(`database role ${r?.current_user ?? '?'} is not least-privilege (expected df_edge); see docs/PRODUCTION.md`)
  }
}
