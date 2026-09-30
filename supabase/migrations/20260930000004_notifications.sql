-- Notification outbox processing (dispatcher runs in an Edge Function).
--
-- Claiming uses FOR UPDATE SKIP LOCKED plus a lease (next_attempt_at pushed
-- forward) so concurrent dispatchers never process the same row twice and a
-- crashed dispatcher's rows become visible again after the lease.

create function private.claim_notifications(p_limit int)
returns table (
  id uuid, tenant_id uuid, booking_id uuid, event text, attempts int,
  tenant_slug text, tenant_name text, tenant_status public.tenant_status, timezone text,
  telegram_chat_id text, booking jsonb
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
         t.slug, t.name, t.status, t.timezone, s.telegram_chat_id,
         case when b.id is null then null else jsonb_build_object(
           'ref_code', b.ref_code, 'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at,
           'service_name', b.service_name_snapshot, 'multi_day', b.multi_day_snapshot,
           'price_from_minor', b.price_from_minor_snapshot, 'contact_name', b.contact_name,
           'contact_phone_e164', b.contact_phone_e164, 'vehicle', b.vehicle_snapshot, 'is_demo', b.is_demo,
           'booking_id', b.id) end
  from leased l
  join public.tenants t on t.id = l.tenant_id
  join public.tenant_settings s on s.tenant_id = l.tenant_id
  left join public.bookings b on b.id = l.booking_id
$$;

create function private.complete_notification(
  p_id uuid, p_status public.notification_status, p_error text, p_provider_message_id text, p_retry_at timestamptz
) returns void
language sql volatile security definer set search_path = '' as $$
  update public.notification_outbox
  set status = p_status,
      last_error = p_error,
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      next_attempt_at = coalesce(p_retry_at, next_attempt_at),
      processed_at = case when p_status = 'pending' then processed_at else now() end
  where id = p_id
$$;

-- Owner sets the Telegram chat that receives studio notifications.
create function public.owner_set_telegram_chat(p_tenant_id uuid, p_chat_id text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.is_member(p_tenant_id, 'owner') then
    raise exception 'NOT_FOUND';
  end if;
  if p_chat_id is not null and p_chat_id !~ '^-?[0-9]{3,20}$' then
    raise exception 'INVALID_WINDOW';
  end if;
  update public.tenant_settings set telegram_chat_id = p_chat_id, updated_at = now() where tenant_id = p_tenant_id;
end
$$;

revoke all on function private.claim_notifications(int) from public, anon, authenticated;
revoke all on function private.complete_notification(uuid, public.notification_status, text, text, timestamptz) from public, anon, authenticated;
grant execute on function private.claim_notifications(int) to service_role;
grant execute on function private.complete_notification(uuid, public.notification_status, text, text, timestamptz) to service_role;
revoke all on function public.owner_set_telegram_chat(uuid, text) from public, anon;
grant execute on function public.owner_set_telegram_chat(uuid, text) to authenticated;
