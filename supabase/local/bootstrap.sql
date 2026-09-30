-- Local Supabase platform bootstrap.
--
-- Reproduces the roles, schemas and default privileges that the Supabase
-- Postgres image (supabase/postgres) creates before any project migration runs.
-- Used ONLY for local development and tests on a vanilla PostgreSQL 16 cluster;
-- on a hosted Supabase project all of this already exists.
--
-- NOTE: the default privileges below are intentionally as permissive as on the
-- real platform (anon/authenticated get ALL on new public tables). Project
-- migrations must revoke them explicitly; tests assert they do.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin noinherit createrole login password 'postgres';
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;
alter role supabase_auth_admin set search_path = 'auth';

create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;
do $$ begin execute format('grant create on database %I to supabase_auth_admin', current_database()); end $$;

create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
