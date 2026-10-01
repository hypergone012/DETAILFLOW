-- Least-privilege database role for Edge Functions.
--
-- df_edge owns no privileges of its own (NOINHERIT): every statement must run
-- after SET LOCAL ROLE to `authenticated` (owner requests, RLS applies) or
-- `service_role` (public requests calling private.* functions). A query that
-- forgets to switch role fails with "permission denied" instead of running as
-- `postgres` and bypassing RLS.
--
-- The role is created without LOGIN. The operator enables it once, outside
-- migrations, so no password ever lands in git:
--   alter role df_edge with login password '<generated>';
-- (docs/PRODUCTION.md, "Edge database role").

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'df_edge') then
    create role df_edge nologin noinherit;
  end if;
end
$$;

-- Only NOINHERIT is set explicitly: a role created by a non-superuser never has
-- SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB, and Supabase (supautils) rejects any
-- ALTER ROLE that names those attributes. Functions refuse to start if the role
-- has them anyway (assertLeastPrivilegeRole), and prod:verify-db checks it.
alter role df_edge noinherit;
grant authenticated, service_role to df_edge;
-- Same session settings PostgREST relies on; statement_timeout caps runaway queries.
alter role df_edge set statement_timeout = '8s';
alter role df_edge set idle_in_transaction_session_timeout = '15s';
