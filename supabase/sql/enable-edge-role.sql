-- Enables the least-privilege Edge Function role created by migration 0005.
-- Run ONCE per project in the SQL editor (as postgres). Generate the password
-- locally (e.g. `openssl rand -base64 36`), never commit it, then build
--   DF_DB_URL=postgres://df_edge.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
-- (Supavisor transaction pooler; the user is "df_edge.<project-ref>").
alter role df_edge with login password '<GENERATED_PASSWORD>';

-- Verify: the role must not bypass RLS nor read tables without SET ROLE.
select rolname, rolinherit, rolbypassrls, rolsuper from pg_roles where rolname = 'df_edge';
