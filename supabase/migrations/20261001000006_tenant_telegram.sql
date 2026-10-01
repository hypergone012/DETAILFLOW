-- Tenant-scoped Telegram destination.
--
-- The bot token is one platform credential (TELEGRAM_BOT_TOKEN, Edge Function
-- secret) and is never stored in the database. Where a studio's notifications
-- go is studio data: one row per tenant, one chat per studio.
--
-- Guarantees enforced here (not in the UI):
--   * a chat id belongs to at most one studio (unique), so no studio can point
--     its notifications at another studio's chat;
--   * owners change only their own studio's row, through owner_set_telegram;
--   * managers/owners of the studio can read it, nobody else (RLS), anon nothing;
--   * the dispatcher resolves the destination from the outbox row's tenant,
--     which is the booking's tenant (composite FK), never from a request.

create table public.tenant_notification_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  telegram_enabled boolean not null default false,
  telegram_chat_id text check (telegram_chat_id ~ '^-?[0-9]{3,20}$'),
  telegram_last_test_at timestamptz,
  telegram_last_test_ok boolean,
  telegram_last_test_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_enabled_needs_chat check (not telegram_enabled or telegram_chat_id is not null)
);

create unique index tenant_notification_settings_chat_unique
  on public.tenant_notification_settings (telegram_chat_id) where telegram_chat_id is not null;

create trigger tenant_notification_settings_tenant_immutable before update on public.tenant_notification_settings
  for each row execute function private.forbid_tenant_change();
create trigger tenant_notification_settings_touch before update on public.tenant_notification_settings
  for each row execute function private.touch_updated_at();

-- Every studio has a row (disabled, no chat) from the moment it exists.
create function private.create_notification_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tenant_notification_settings (tenant_id) values (new.id) on conflict do nothing;
  return new;
end
$$;
revoke all on function private.create_notification_settings() from public, anon, authenticated;
create trigger tenants_notification_settings after insert on public.tenants
  for each row execute function private.create_notification_settings();

-- Carry over chats set before this migration (a duplicated chat stays with the oldest studio).
insert into public.tenant_notification_settings (tenant_id, telegram_enabled, telegram_chat_id)
select tenant_id, chat is not null, chat
from (
  select t.id as tenant_id,
         case when row_number() over (partition by s.telegram_chat_id order by t.created_at, t.id) = 1 then s.telegram_chat_id end as chat
  from public.tenants t left join public.tenant_settings s on s.tenant_id = t.id
) x
on conflict (tenant_id) do nothing;

drop function public.owner_set_telegram_chat(uuid, text);
alter table public.tenant_settings drop column telegram_chat_id;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
alter table public.tenant_notification_settings enable row level security;
create policy tenant_notification_settings_manager_read on public.tenant_notification_settings
  for select to authenticated using ((select private.is_member(tenant_id, 'manager')));
revoke all on public.tenant_notification_settings from public, anon, authenticated;
grant select on public.tenant_notification_settings to authenticated;
grant all on public.tenant_notification_settings to service_role;

-- Owner sets the studio's Telegram destination. p_chat_id null with p_keep_chat
-- keeps the stored chat (toggle only).
create function public.owner_set_telegram(p_tenant_id uuid, p_enabled boolean, p_chat_id text, p_keep_chat boolean default false)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_chat text;
begin
  if not private.is_member(p_tenant_id, 'owner') then
    raise exception 'NOT_FOUND';
  end if;
  if p_keep_chat then
    select telegram_chat_id into v_chat from public.tenant_notification_settings where tenant_id = p_tenant_id;
  else
    v_chat := p_chat_id;
  end if;
  if v_chat is not null and v_chat !~ '^-?[0-9]{3,20}$' then
    raise exception 'TELEGRAM_CHAT_INVALID';
  end if;
  if p_enabled and v_chat is null then
    raise exception 'TELEGRAM_CHAT_REQUIRED';
  end if;
  if v_chat is not null and exists (
    select 1 from public.tenant_notification_settings where telegram_chat_id = v_chat and tenant_id <> p_tenant_id
  ) then
    raise exception 'TELEGRAM_CHAT_TAKEN';
  end if;
  insert into public.tenant_notification_settings as s (tenant_id, telegram_enabled, telegram_chat_id)
  values (p_tenant_id, p_enabled, v_chat)
  on conflict (tenant_id) do update set
    telegram_enabled = excluded.telegram_enabled,
    telegram_chat_id = excluded.telegram_chat_id,
    -- a new destination has not been tested yet
    telegram_last_test_at = case when s.telegram_chat_id is distinct from excluded.telegram_chat_id then null else s.telegram_last_test_at end,
    telegram_last_test_ok = case when s.telegram_chat_id is distinct from excluded.telegram_chat_id then null else s.telegram_last_test_ok end,
    telegram_last_test_error = case when s.telegram_chat_id is distinct from excluded.telegram_chat_id then null else s.telegram_last_test_error end;
exception
  when unique_violation then raise exception 'TELEGRAM_CHAT_TAKEN';
end
$$;
revoke all on function public.owner_set_telegram(uuid, boolean, text, boolean) from public, anon;
grant execute on function public.owner_set_telegram(uuid, boolean, text, boolean) to authenticated;

-- Result of a server-side test message; ignored if the chat changed meanwhile.
create function private.record_telegram_test(p_tenant_id uuid, p_chat_id text, p_ok boolean, p_error text)
returns void
language sql volatile security definer set search_path = '' as $$
  update public.tenant_notification_settings
  set telegram_last_test_at = now(), telegram_last_test_ok = p_ok, telegram_last_test_error = p_error
  where tenant_id = p_tenant_id and telegram_chat_id = p_chat_id
$$;
revoke all on function private.record_telegram_test(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function private.record_telegram_test(uuid, text, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- Dispatcher: destination = settings of the outbox row's (= booking's) tenant
-- ---------------------------------------------------------------------------
drop function private.claim_notifications(int);
create function private.claim_notifications(p_limit int)
returns table (
  id uuid, tenant_id uuid, booking_id uuid, event text, attempts int,
  tenant_slug text, tenant_name text, tenant_status public.tenant_status, timezone text,
  telegram_enabled boolean, telegram_chat_id text, booking jsonb
)
language sql volatile security definer set search_path = '' as $$
  with claimed as (
    select o.id from public.notification_outbox o
    where o.status = 'pending' and o.next_attempt_at <= now()
    order by o.created_at
    limit p_limit
    for update skip locked
  ), leased as (
    update public.notification_outbox o
    set next_attempt_at = now() + interval '5 minutes', attempts = o.attempts + 1
    from claimed where o.id = claimed.id
    returning o.*
  )
  select l.id, l.tenant_id, l.booking_id, l.event, l.attempts,
         t.slug, t.name, t.status, t.timezone,
         coalesce(n.telegram_enabled, false), n.telegram_chat_id,
         case when b.id is null then null else jsonb_build_object(
           'ref_code', b.ref_code, 'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at,
           'service_name', b.service_name_snapshot, 'multi_day', b.multi_day_snapshot,
           'price_from_minor', b.price_from_minor_snapshot, 'contact_name', b.contact_name,
           'contact_phone_e164', b.contact_phone_e164, 'vehicle', b.vehicle_snapshot, 'is_demo', b.is_demo,
           'booking_id', b.id) end
  from leased l
  join public.tenants t on t.id = l.tenant_id
  left join public.tenant_notification_settings n on n.tenant_id = l.tenant_id
  left join public.bookings b on b.tenant_id = l.tenant_id and b.id = l.booking_id
$$;
revoke all on function private.claim_notifications(int) from public, anon, authenticated;
grant execute on function private.claim_notifications(int) to service_role;
