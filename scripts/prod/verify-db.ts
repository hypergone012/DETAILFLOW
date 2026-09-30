/**
 * Read-only verification of a deployed database (production or staging):
 *   PROD_DATABASE_URL=postgres://postgres.<ref>:<pw>@...:5432/postgres pnpm prod:verify-db
 * Checks the security invariants the test suite enforces locally. Writes a
 * JSON report to docs/smoke/ and exits non-zero on any failure.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

const url = process.env.PROD_DATABASE_URL
if (!url) {
  console.error('PROD_DATABASE_URL is not set — NOT VERIFIED')
  process.exit(2)
}
const label = process.env.SMOKE_LABEL ?? 'production'
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

type Result = { check: string; ok: boolean; detail?: unknown; severity: 'fail' | 'warn' }
const results: Result[] = []
const check = (name: string, ok: boolean, detail?: unknown, severity: 'fail' | 'warn' = 'fail') =>
  results.push({ check: name, ok, severity, ...(ok ? {} : { detail }) })

const TENANT_TABLES = [
  'tenant_profiles', 'tenant_settings', 'tenant_members', 'services', 'service_variants', 'resources',
  'working_hours', 'schedule_exceptions', 'customers', 'vehicles', 'bookings', 'resource_blocks',
  'resource_allocations', 'booking_events', 'notification_outbox', 'ai_tool_calls',
]
const EXPECTED_COMPOSITE_FKS = [
  'bookings->customers', 'bookings->services', 'bookings->vehicles', 'booking_events->bookings',
  'notification_outbox->bookings', 'resource_allocations->bookings', 'resource_allocations->resource_blocks',
  'resource_allocations->resources', 'resource_blocks->resources', 'service_variants->services', 'vehicles->customers',
]

try {
  const files = readdirSync(join(import.meta.dirname, '../../supabase/migrations')).filter((f) => f.endsWith('.sql'))
  const applied = new Set((await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations`).map((r) => r.version))
  const missing = files.map((f) => f.split('_')[0]!).filter((v) => !applied.has(v))
  check('all migrations applied', missing.length === 0, missing)

  const ext = (await sql<{ extname: string }[]>`select extname from pg_extension`).map((r) => r.extname)
  for (const e of ['btree_gist', 'pgcrypto']) check(`extension ${e}`, ext.includes(e))
  check('extension pg_cron (dispatcher schedule)', ext.includes('pg_cron'), 'run supabase/sql/schedule-dispatcher.sql', 'warn')

  const anonGrants = await sql`select table_schema, table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema in ('public','private')`
  check('anon has no table privileges', anonGrants.length === 0, anonGrants)
  const authWrites = await sql`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_schema in ('public','private') and privilege_type <> 'SELECT'`
  check('authenticated has no table write privileges', authWrites.length === 0, authWrites)

  const noRls = await sql<{ relname: string }[]>`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`
  check('RLS enabled on every public table', noRls.length === 0, noRls.map((r) => r.relname))

  const [edge] = await sql`select rolinherit, rolbypassrls, rolsuper, rolcanlogin from pg_roles where rolname = 'df_edge'`
  check('df_edge exists, NOINHERIT, no bypassrls/superuser', !!edge && !edge.rolinherit && !edge.rolbypassrls && !edge.rolsuper, edge)
  check('df_edge can log in (supabase/sql/enable-edge-role.sql applied)', !!edge?.rolcanlogin, edge, 'warn')
  const edgeTables = await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind = 'r' and has_table_privilege('df_edge', c.oid, 'SELECT')`
  check('df_edge has no direct table rights', edgeTables.length === 0, edgeTables)

  const privExec = await sql`
    select p.oid::regprocedure::text as fn, r.role from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated'), ('df_edge')) r(role)
    where n.nspname = 'private' and has_function_privilege(r.role, p.oid, 'EXECUTE') and not (p.proname = 'is_member' and r.role = 'authenticated')`
  check('private.* not executable by anon/authenticated/df_edge', privExec.length === 0, privExec)

  const unpinned = await sql`
    select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`
  check('SECURITY DEFINER functions pin search_path', unpinned.length === 0, unpinned)

  const fks = await sql<{ pair: string }[]>`
    select c.conrelid::regclass::text || '->' || c.confrelid::regclass::text as pair
    from pg_constraint c
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 2
      and (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) = 'tenant_id'`
  const pairs = new Set(fks.map((r) => r.pair.replace(/public\./g, '')))
  const missingFks = EXPECTED_COMPOSITE_FKS.filter((p) => !pairs.has(p))
  check('composite (tenant_id, id) foreign keys', missingFks.length === 0, missingFks)

  const [excl] = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'resource_allocations_no_overlap' and contype = 'x'`
  check('exclusion constraint on resource_allocations', !!excl && /gist \(resource_id WITH =, during WITH &&\) WHERE \(\(released_at IS NULL\)\)/.test(excl.def), excl)

  const [idem] = await sql`select 1 as ok from pg_constraint where conname = 'bookings_tenant_id_idempotency_key_key' and contype = 'u'`
  check('unique (tenant_id, idempotency_key)', !!idem)

  const triggers = (await sql<{ t: string }[]>`select tgrelid::regclass::text as t from pg_trigger where tgname like '%_tenant_immutable'`).map((r) => r.t.replace('public.', ''))
  const missingTriggers = TENANT_TABLES.filter((t) => !triggers.includes(t))
  check('tenant_id immutability trigger on every tenant table', missingTriggers.length === 0, missingTriggers)

  const tenants = await sql<{ slug: string; status: string }[]>`select slug, status from public.tenants order by slug`
  check('tenants present', tenants.length > 0, tenants, 'warn')
  results.push({ check: 'tenants (info)', ok: true, severity: 'warn', detail: tenants })
} catch (err) {
  check('verification ran', false, err instanceof Error ? `${err.name}: ${err.message}` : String(err))
} finally {
  await sql.end()
}

const failed = results.filter((r) => !r.ok && r.severity === 'fail')
const report = { label, at: new Date().toISOString(), passed: failed.length === 0, results }
const dir = join(import.meta.dirname, '../../docs/smoke')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `verify-db-${label}.json`), JSON.stringify(report, null, 2) + '\n')
for (const r of results) console.log(`${r.ok ? 'PASS' : r.severity === 'warn' ? 'WARN' : 'FAIL'}  ${r.check}${r.ok ? '' : `  ${JSON.stringify(r.detail)}`}`)
process.exit(failed.length ? 1 : 0)
