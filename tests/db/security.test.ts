import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTenant, hashToken, hoursFromNow, addMinutes, type TenantFixture } from './fixtures.ts'
import { asAnon, asUser, connect, edgeConnect, errorOf, type Sql } from './harness.ts'

let sql: Sql
let t: TenantFixture

beforeAll(async () => {
  sql = connect()
  t = await createTenant(sql)
})
afterAll(() => sql.end())

const PUBLIC_TABLES = [
  'tenants', 'tenant_profiles', 'tenant_settings', 'tenant_members', 'services', 'service_variants', 'resources',
  'working_hours', 'schedule_exceptions', 'customers', 'vehicles', 'bookings', 'resource_blocks',
  'resource_allocations', 'booking_events', 'notification_outbox', 'ai_tool_calls',
]

describe('grants audit', () => {
  it('anon has zero table or column privileges in public and private', async () => {
    const tableGrants = await sql`
      select table_schema, table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'anon' and table_schema in ('public', 'private')`
    const columnGrants = await sql`
      select table_name, column_name from information_schema.column_privileges
      where grantee = 'anon' and table_schema in ('public', 'private')`
    expect(tableGrants).toEqual([])
    expect(columnGrants).toEqual([])
  })

  it('authenticated can only SELECT (plus column-limited customer edits)', async () => {
    const grants = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'authenticated' and table_schema in ('public', 'private') and privilege_type <> 'SELECT'`
    expect(grants).toEqual([])
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
      where grantee = 'authenticated' and table_schema = 'public' and table_name = 'customers' and privilege_type = 'UPDATE'
      order by column_name`
    expect(cols.map((c) => c.column_name)).toEqual(['email', 'internal_notes', 'name'])
  })

  it('RLS is enabled on every public table', async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`
    const byName = Object.fromEntries(rows.map((r) => [r.relname, r.relrowsecurity]))
    for (const table of PUBLIC_TABLES) expect(byName[table], table).toBe(true)
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
  })

  it('every SECURITY DEFINER function pins search_path', async () => {
    const rows = await sql<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`
    expect(rows).toEqual([])
  })

  it('anon and authenticated cannot execute private functions', async () => {
    const rows = await sql<{ fn: string; role: string }[]>`
      select p.oid::regprocedure::text as fn, r.role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated')) r(role)
      where n.nspname = 'private'
        and has_function_privilege(r.role, p.oid, 'EXECUTE')
        and p.proname <> 'is_member'`
    expect(rows).toEqual([])
    expect((await sql`select has_function_privilege('anon', 'private.is_member(uuid, public.member_role)', 'EXECUTE') as ok`)[0]!.ok).toBe(false)
  })

  it('anon cannot execute owner RPCs', async () => {
    const rows = await sql<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
        and p.proname like 'owner_%'`
    expect(rows).toEqual([])
  })
})

describe('anon runtime access', () => {
  it.each(PUBLIC_TABLES)('anon SELECT on %s is denied', async (table) => {
    const msg = await errorOf(asAnon(sql, (tx) => tx.unsafe(`select * from public.${table} limit 1`)))
    expect(msg).toMatch(/permission denied/)
  })

  it('anon cannot call private.create_booking directly', async () => {
    const start = hoursFromNow(48)
    const id = randomUUID()
    const msg = await errorOf(
      asAnon(sql, (tx) => tx`
        select private.create_booking(${t.id}, ${id}, ${randomUUID()}, 'h', ${hashToken(id)}, ${t.serviceId},
          'sedan', ${start}, ${addMinutes(start, 120)}, '{"name":"x","phone_e164":"+79990000000"}',
          '{"make":"a","model":"b"}', '', 'customer')`),
    )
    expect(msg).toMatch(/permission denied/)
  })

  it('authenticated non-member sees no tenant rows', async () => {
    const stranger = randomUUID()
    const rows = await asUser(sql, stranger, (tx) => tx`select id from public.tenants`)
    expect(rows).toEqual([])
  })
})

describe('tenant_id immutability', () => {
  it('tenant_id cannot be changed even by a privileged session', async () => {
    const other = await createTenant(sql)
    const msg = await errorOf(sql`update public.services set tenant_id = ${other.id} where id = ${t.serviceId}`)
    expect(msg).toMatch(/TENANT_IMMUTABLE|violates foreign key/)
  })
})

describe('df_edge: the Edge Function database role', () => {
  it('is least-privilege: no inherit, no bypassrls, no direct table or function rights', async () => {
    const [r] = await sql`select rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb from pg_roles where rolname = 'df_edge'`
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false })
    const tables = await sql<{ t: string }[]>`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relkind = 'r' and has_table_privilege('df_edge', c.oid, 'SELECT')`
    expect(tables).toEqual([])
    const fns = await sql<{ f: string }[]>`
      select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and has_function_privilege('df_edge', p.oid, 'EXECUTE')`
    expect(fns).toEqual([])
  })

  it('a query that forgets SET ROLE fails instead of bypassing RLS', async () => {
    const edge = edgeConnect(1)
    try {
      expect(await errorOf(edge`select * from public.bookings limit 1`)).toMatch(/permission denied/)
      expect(await errorOf(edge`select private.get_storefront('x')`)).toMatch(/permission denied/)
      const [who] = await edge.begin(async (tx) => {
        await tx`select set_config('role', 'service_role', true)`
        return tx`select current_user as u`
      })
      expect(who!.u).toBe('service_role')
    } finally {
      await edge.end()
    }
  })
})
