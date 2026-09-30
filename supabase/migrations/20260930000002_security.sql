-- DETAILFLOW security model.
--
-- anon          : no table privileges at all. Public traffic goes through Edge
--                 Functions, which call private.* functions as service_role.
-- authenticated : SELECT on tenant data only where the user is a tenant member
--                 (RLS). No direct INSERT/UPDATE/DELETE on booking state; all
--                 mutations go through public.owner_* security-definer RPCs.
-- service_role  : used only inside Edge Functions.

-- ---------------------------------------------------------------------------
-- Undo Supabase's permissive defaults for this project's objects
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

revoke all on all functions in schema private from public;
alter default privileges in schema private revoke all on functions from public;
revoke all on all tables in schema private from public, anon, authenticated;

grant usage on schema private to authenticated, service_role;
grant all on all tables in schema private to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Membership helpers (used by RLS policies)
-- ---------------------------------------------------------------------------
create function private.is_member(p_tenant_id uuid, p_min_role public.member_role default 'staff')
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.role >= p_min_role
  )
$$;
revoke all on function private.is_member(uuid, public.member_role) from public;
grant execute on function private.is_member(uuid, public.member_role) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: enabled everywhere.
-- Not FORCEd: the table owner (postgres) must bypass RLS so that the narrowly
-- scoped SECURITY DEFINER functions below can do their job. anon/authenticated
-- are always subject to RLS.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'tenants', 'tenant_profiles', 'tenant_settings', 'tenant_members', 'services', 'service_variants',
    'resources', 'working_hours', 'schedule_exceptions', 'customers', 'vehicles', 'bookings',
    'resource_blocks', 'resource_allocations', 'booking_events', 'notification_outbox', 'ai_tool_calls'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;
alter table private.rate_limit_buckets enable row level security;

-- Read access for members, per table.
create policy tenants_member_read on public.tenants
  for select to authenticated using ((select private.is_member(id)));

create policy tenant_members_read on public.tenant_members
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_member(tenant_id, 'owner')));

do $$
declare t text;
begin
  foreach t in array array[
    'tenant_profiles', 'tenant_settings', 'services', 'service_variants', 'resources', 'working_hours',
    'schedule_exceptions', 'customers', 'vehicles', 'bookings', 'resource_blocks',
    'resource_allocations', 'booking_events', 'notification_outbox'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select private.is_member(tenant_id)))',
      t || '_member_read', t);
  end loop;
end
$$;

create policy ai_tool_calls_owner_read on public.ai_tool_calls
  for select to authenticated using ((select private.is_member(tenant_id, 'manager')));

-- Column-limited edits members may make directly.
create policy customers_member_update on public.customers
  for update to authenticated
  using ((select private.is_member(tenant_id)))
  with check ((select private.is_member(tenant_id)));

-- ---------------------------------------------------------------------------
-- Grants for authenticated (RLS decides which rows)
-- ---------------------------------------------------------------------------
grant select on
  public.tenants, public.tenant_profiles, public.tenant_members, public.services, public.service_variants,
  public.resources, public.working_hours, public.schedule_exceptions, public.customers, public.vehicles,
  public.bookings, public.resource_blocks, public.resource_allocations, public.booking_events,
  public.notification_outbox, public.ai_tool_calls
to authenticated;
-- tenant_settings holds the owner's Telegram chat id: readable by members, not writable directly.
grant select on public.tenant_settings to authenticated;
grant update (name, email, internal_notes) on public.customers to authenticated;
