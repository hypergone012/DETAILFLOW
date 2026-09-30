/** Runtime configuration for Edge Functions (Deno). */
export function requireEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

export function allowedOrigins(): string[] {
  return (Deno.env.get('DF_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * SUPABASE_DB_URL is injected by the Supabase Edge Runtime. On hosted
 * Supabase SUPABASE_URL is injected too and JWTs are verified through JWKS.
 */
export function authConfig(): { jwksUrl?: string; jwtSecret?: string } {
  const jwtSecret = Deno.env.get('DF_JWT_SECRET')
  if (jwtSecret) return { jwtSecret }
  return { jwksUrl: `${requireEnv('SUPABASE_URL')}/auth/v1/.well-known/jwks.json` }
}
