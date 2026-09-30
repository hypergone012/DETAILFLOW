import postgres from 'postgres'

export type Sql = postgres.Sql
export type Tx = postgres.TransactionSql

export function createSql(url: string): Sql {
  // prepare:false keeps us compatible with the Supabase transaction pooler.
  return postgres(url, { max: 5, prepare: false, idle_timeout: 20, onnotice: () => {} })
}

/**
 * Exactly what PostgREST does per request: a transaction with SET LOCAL role
 * and request.jwt.claims, so auth.uid() and RLS apply.
 */
export async function asRole<T>(sql: Sql, role: 'service_role' | 'authenticated', claims: Record<string, unknown>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
    return fn(tx)
  })) as T
}

export const asService = <T>(sql: Sql, fn: (tx: Tx) => Promise<T>) => asRole(sql, 'service_role', { role: 'service_role' }, fn)
