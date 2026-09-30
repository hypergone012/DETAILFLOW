/** Local-stack defaults (scripts/local/stack.sh). Production values come from the environment. */
export const LOCAL = {
  databaseUrl: 'postgres://postgres@127.0.0.1:54322/postgres_df',
  authUrl: 'http://127.0.0.1:54324',
  jwtSecret: 'super-secret-jwt-token-with-at-least-32-characters-long',
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`missing env ${name}`)
  return v
}
