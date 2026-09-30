import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { inject } from 'vitest'

export type Sql = postgres.Sql

export function connect(max = 10): Sql {
  return postgres(inject('databaseUrl'), { max, onnotice: () => {} })
}

type Tx = postgres.TransactionSql

/** Runs `fn` exactly like PostgREST would for an anonymous request. */
export async function asAnon<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role":"anon"}', true)`
    return fn(tx)
  }) as Promise<T>
}

/** Runs `fn` as a signed-in Supabase user (role authenticated + JWT claims). */
export async function asUser<T>(sql: Sql, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' })
  return sql.begin(async (tx) => {
    await tx`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', ${claims}, true)`
    return fn(tx)
  }) as Promise<T>
}

/** Runs `fn` as service_role (what Edge Functions use for private.* calls). */
export async function asService<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('role', 'service_role', true), set_config('request.jwt.claims', '{"role":"service_role"}', true)`
    return fn(tx)
  }) as Promise<T>
}

/** Postgres error message of a rejected promise (our RPCs raise codes as messages). */
export async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    return (err as { message?: string }).message ?? String(err)
  }
  throw new Error('expected promise to reject')
}

export async function createAuthUser(sql: Sql, email: string): Promise<string> {
  const id = randomUUID()
  await sql`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values ('00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated', ${email}, '', now(), now(), now(),
            '{"provider":"email","providers":["email"]}', '{}')`
  return id
}
