-- DETAILFLOW booking engine: atomic, idempotent, occupancy-safe.
--
-- Error contract: functions raise SQLSTATE P0001 with MESSAGE set to one of
--   SLOT_TAKEN, IDEMPOTENCY_CONFLICT, TENANT_UNAVAILABLE, SERVICE_NOT_FOUND,
--   INVALID_WINDOW, OUTSIDE_BOOKING_WINDOW, TOO_MANY_ACTIVE_BOOKINGS,
--   BOOKING_NOT_FOUND, INVALID_TRANSITION, CUTOFF_PASSED, FORBIDDEN, NOT_FOUND
-- Edge Functions map these to HTTP responses.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.gen_ref_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(6);
  out text := '';
begin
  for i in 0..5 loop
    out := out || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return out;
end
$$;

-- Fixed-window rate limiter. Returns true when the call is allowed.
create function private.hit_rate_limit(p_key text, p_window_seconds int, p_max int) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits int;
begin
  insert into private.rate_limit_buckets as b (key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (key, window_start) do update set hits = b.hits + 1
  returning hits into v_hits;
  delete from private.rate_limit_buckets where window_start < now() - interval '1 day';
  return v_hits <= p_max;
end
$$;

-- Validates the relation between a window and the (snapshot) service duration.
-- Same-day: end = start + duration exactly. Multi-day: the working minutes are
-- spread over several days by the slot engine, so end >= start + duration.
create function private.assert_window(
  p_duration_min int, p_multi_day boolean, p_start timestamptz, p_end timestamptz
) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'INVALID_WINDOW';
  end if;
  if not p_multi_day and p_end <> p_start + make_interval(mins => p_duration_min) then
    raise exception 'INVALID_WINDOW';
  end if;
  if p_multi_day and (p_end < p_start + make_interval(mins => p_duration_min)
                      or p_end > p_start + interval '30 days') then
    raise exception 'INVALID_WINDOW';
  end if;
end
$$;

-- Customer-facing policy: min notice and horizon.
create function private.assert_customer_window(p_tenant_id uuid, p_start timestamptz) returns void
language plpgsql stable set search_path = '' as $$
declare s public.tenant_settings;
begin
  select * into s from public.tenant_settings where tenant_id = p_tenant_id;
  if p_start < now() + make_interval(mins => s.min_notice_min)
     or p_start > now() + make_interval(days => s.horizon_days) then
    raise exception 'OUTSIDE_BOOKING_WINDOW';
  end if;
end
$$;

-- Inserts one allocation row. Concurrent writers for the same resource are
-- serialized with a transaction-scoped advisory lock: without it two
-- transactions inserting overlapping ranges can wait on each other inside the
-- exclusion check and one gets `deadlock_detected` instead of a clean
-- `exclusion_violation` (reproduced by tests/db/booking.test.ts). A remaining
-- deadlock (e.g. reschedule preferring a different bay first) is retried.
-- Returns false when the range is taken.
create function private.try_occupy(
  p_tenant_id uuid, p_resource_id uuid, p_during tstzrange, p_booking_id uuid, p_block_id uuid
) returns boolean
language plpgsql volatile set search_path = '' as $$
begin
  for attempt in 1..5 loop
    begin
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('df:resource:' || p_resource_id::text, 0));
      insert into public.resource_allocations (tenant_id, resource_id, booking_id, block_id, during)
      values (p_tenant_id, p_resource_id, p_booking_id, p_block_id, p_during);
      return true;
    exception
      when exclusion_violation then
        return false;
      when deadlock_detected then
        if attempt = 5 then raise; end if;
    end;
  end loop;
  return false;
end
$$;

-- Tries active resources of the required type in a deterministic order
-- (preferred first). The exclusion constraint decides; we never pre-check.
create function private.allocate(
  p_tenant_id uuid, p_type public.resource_type, p_during tstzrange,
  p_booking_id uuid, p_block_id uuid, p_preferred uuid default null
) returns uuid
language plpgsql volatile set search_path = '' as $$
declare r record;
begin
  for r in
    select id from public.resources
    where tenant_id = p_tenant_id and type = p_type and active
    order by (id = p_preferred) desc nulls last, sort, key
  loop
    if private.try_occupy(p_tenant_id, r.id, p_during, p_booking_id, p_block_id) then
      return r.id;
    end if;
  end loop;
  return null;
end
$$;

create function private.enqueue_notification(p_tenant_id uuid, p_booking_id uuid, p_event text) returns void
language sql volatile set search_path = '' as $$
  insert into public.notification_outbox (tenant_id, booking_id, event, channel)
  values (p_tenant_id, p_booking_id, p_event, 'telegram')
$$;

-- ---------------------------------------------------------------------------
-- Public read models (called by Edge Functions as service_role)
-- ---------------------------------------------------------------------------
create function private.get_storefront(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant', jsonb_build_object(
      'slug', t.slug, 'name', t.name, 'status', t.status, 'timezone', t.timezone,
      'currency', t.currency, 'locale', t.locale),
    'profile', jsonb_build_object(
      'accent_hex', p.accent_hex, 'tagline', p.tagline, 'about', p.about, 'address', p.address,
      'map_url', p.map_url, 'phone_display', p.phone_display, 'phone_e164', p.phone_e164,
      'telegram_url', p.telegram_url, 'whatsapp_url', p.whatsapp_url,
      'logo_url', p.logo_url, 'hero_url', p.hero_url, 'gallery', p.gallery),
    'policy', jsonb_build_object(
      'slot_step_min', s.slot_step_min, 'min_notice_min', s.min_notice_min,
      'horizon_days', s.horizon_days, 'cancel_cutoff_hours', s.cancel_cutoff_hours),
    'ai_enabled', s.ai_enabled,
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'opens', to_char(w.opens, 'HH24:MI'),
                                          'closes', to_char(w.closes, 'HH24:MI')) order by w.weekday, w.opens)
      from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),
    'services', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sv.id, 'slug', sv.slug, 'category', sv.category, 'name', sv.name, 'summary', sv.summary,
        'description', sv.description, 'requirements', to_jsonb(sv.requirements),
        'duration_min', sv.duration_min, 'price_from_minor', sv.price_from_minor,
        'multi_day', sv.multi_day, 'image_url', sv.image_url,
        'requires_confirmation', coalesce(sv.requires_confirmation, s.requires_confirmation_default),
        'variants', coalesce((
          select jsonb_agg(jsonb_build_object('vehicle_class', v.vehicle_class, 'duration_min', v.duration_min,
                                              'price_from_minor', v.price_from_minor) order by v.vehicle_class)
          from public.service_variants v where v.service_id = sv.id), '[]'::jsonb)
      ) order by sv.sort, sv.name)
      from public.services sv where sv.tenant_id = t.id and sv.active), '[]'::jsonb)
  )
  from public.tenants t
  join public.tenant_profiles p on p.tenant_id = t.id
  join public.tenant_settings s on s.tenant_id = t.id
  where t.slug = p_slug and t.status in ('demo', 'active', 'suspended')
$$;

-- Everything the slot engine needs for one service over a range.
create function private.get_availability_inputs(
  p_tenant_id uuid, p_service_id uuid, p_from timestamptz, p_to timestamptz
) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'timezone', t.timezone,
    'policy', jsonb_build_object(
      'slot_step_min', s.slot_step_min, 'min_notice_min', s.min_notice_min, 'horizon_days', s.horizon_days),
    'service', jsonb_build_object(
      'id', sv.id, 'resource_type', sv.resource_type, 'duration_min', sv.duration_min,
      'price_from_minor', sv.price_from_minor, 'buffer_before_min', sv.buffer_before_min,
      'buffer_after_min', sv.buffer_after_min, 'multi_day', sv.multi_day,
      'variants', coalesce((select jsonb_agg(jsonb_build_object('vehicle_class', v.vehicle_class,
        'duration_min', v.duration_min, 'price_from_minor', v.price_from_minor))
        from public.service_variants v where v.service_id = sv.id), '[]'::jsonb)),
    'resources', coalesce((select jsonb_agg(r.id order by r.sort, r.key) from public.resources r
      where r.tenant_id = t.id and r.type = sv.resource_type and r.active), '[]'::jsonb),
    'busy', coalesce((select jsonb_agg(jsonb_build_object('resource_id', a.resource_id,
        'start', lower(a.during), 'end', upper(a.during)))
      from public.resource_allocations a
      join public.resources r on r.id = a.resource_id
      where a.tenant_id = t.id and a.released_at is null and r.type = sv.resource_type
        and a.during && tstzrange(p_from, p_to, '[)')), '[]'::jsonb),
    'hours', coalesce((select jsonb_agg(jsonb_build_object('weekday', w.weekday,
        'opens', to_char(w.opens, 'HH24:MI'), 'closes', to_char(w.closes, 'HH24:MI')))
      from public.working_hours w where w.tenant_id = t.id), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('date', e.local_date, 'closed', e.closed,
        'opens', to_char(e.opens, 'HH24:MI'), 'closes', to_char(e.closes, 'HH24:MI')))
      from public.schedule_exceptions e where e.tenant_id = t.id
        and e.local_date between (p_from at time zone t.timezone)::date - 1
                             and (p_to at time zone t.timezone)::date + 1), '[]'::jsonb)
  )
  from public.tenants t
  join public.tenant_settings s on s.tenant_id = t.id
  join public.services sv on sv.tenant_id = t.id and sv.id = p_service_id and sv.active
  where t.id = p_tenant_id
$$;

-- ---------------------------------------------------------------------------
-- Create booking
-- ---------------------------------------------------------------------------
create function private.create_booking(
  p_tenant_id uuid,
  p_booking_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_manage_token_hash bytea,
  p_service_id uuid,
  p_vehicle_class public.vehicle_class,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_customer jsonb,   -- {name, phone_e164, email}
  p_vehicle jsonb,    -- {make, model, year, color, plate, notes}
  p_comment text,
  p_source public.booking_actor
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tenant public.tenants;
  v_settings public.tenant_settings;
  v_service public.services;
  v_existing public.bookings;
  v_duration int;
  v_price bigint;
  v_customer_id uuid;
  v_vehicle_id uuid;
  v_active int;
  v_ref text;
  v_status public.booking_status;
  v_resource uuid;
  v_constraint text;
  v_plate text := nullif(upper(regexp_replace(coalesce(p_vehicle->>'plate', ''), '\s', '', 'g')), '');
begin
  -- 1. Idempotent replay
  select * into v_existing from public.bookings
  where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('booking_id', v_existing.id, 'ref_code', v_existing.ref_code,
                              'status', v_existing.status, 'replayed', true);
  end if;

  -- 2. Tenant and service (server-side source of truth for price & duration)
  select * into v_tenant from public.tenants where id = p_tenant_id;
  if not found or v_tenant.status not in ('demo', 'active') then
    raise exception 'TENANT_UNAVAILABLE';
  end if;
  select * into v_settings from public.tenant_settings where tenant_id = p_tenant_id;
  select * into v_service from public.services
  where tenant_id = p_tenant_id and id = p_service_id and active;
  if not found then
    raise exception 'SERVICE_NOT_FOUND';
  end if;

  select coalesce(v.duration_min, v_service.duration_min), coalesce(v.price_from_minor, v_service.price_from_minor)
  into v_duration, v_price
  from (select 1) one
  left join public.service_variants v on v.service_id = v_service.id and v.vehicle_class = p_vehicle_class;

  perform private.assert_window(v_duration, v_service.multi_day, p_start_at, p_end_at);
  perform private.assert_customer_window(p_tenant_id, p_start_at);

  -- 3. Customer (never overwrite an existing profile from a public form)
  insert into public.customers as c (tenant_id, name, phone_e164, email)
  values (p_tenant_id, p_customer->>'name', p_customer->>'phone_e164', nullif(p_customer->>'email', ''))
  on conflict (tenant_id, phone_e164) do update set email = coalesce(c.email, excluded.email)
  returning id into v_customer_id;

  select count(*) into v_active from public.bookings
  where tenant_id = p_tenant_id and customer_id = v_customer_id
    and status in ('requested', 'confirmed') and end_at > now();
  if v_active >= v_settings.max_active_bookings_per_phone then
    raise exception 'TOO_MANY_ACTIVE_BOOKINGS';
  end if;

  -- 4. Vehicle: reuse by plate, else by make/model/year/class
  select id into v_vehicle_id from public.vehicles
  where tenant_id = p_tenant_id and customer_id = v_customer_id
    and case when v_plate is not null then plate = v_plate
             else plate is null
                  and lower(make) = lower(p_vehicle->>'make') and lower(model) = lower(p_vehicle->>'model')
                  and year is not distinct from (p_vehicle->>'year')::int and vehicle_class = p_vehicle_class end
  order by created_at desc limit 1;
  if v_vehicle_id is null then
    insert into public.vehicles (tenant_id, customer_id, make, model, year, color, vehicle_class, plate, notes)
    values (p_tenant_id, v_customer_id, p_vehicle->>'make', p_vehicle->>'model', (p_vehicle->>'year')::int,
            coalesce(p_vehicle->>'color', ''), p_vehicle_class, v_plate, coalesce(p_vehicle->>'notes', ''))
    returning id into v_vehicle_id;
  end if;

  v_status := case when coalesce(v_service.requires_confirmation, v_settings.requires_confirmation_default)
                   then 'requested' else 'confirmed' end;

  -- 5. Booking row with snapshot (retry ref_code collisions; detect concurrent idempotent twin)
  for attempt in 1..5 loop
    v_ref := private.gen_ref_code();
    begin
      insert into public.bookings (
        id, tenant_id, ref_code, customer_id, vehicle_id, service_id, status, start_at, end_at,
        service_name_snapshot, resource_type_snapshot, vehicle_class_snapshot, duration_min_snapshot,
        buffer_before_min_snapshot, buffer_after_min_snapshot, multi_day_snapshot, price_from_minor_snapshot,
        currency, contact_name, contact_phone_e164, contact_email, customer_comment, vehicle_snapshot,
        idempotency_key, request_hash, manage_token_hash, source, is_demo)
      values (
        p_booking_id, p_tenant_id, v_ref, v_customer_id, v_vehicle_id, v_service.id, v_status, p_start_at, p_end_at,
        v_service.name, v_service.resource_type, p_vehicle_class, v_duration,
        v_service.buffer_before_min, v_service.buffer_after_min, v_service.multi_day, v_price,
        v_tenant.currency, p_customer->>'name', p_customer->>'phone_e164', nullif(p_customer->>'email', ''),
        coalesce(p_comment, ''),
        jsonb_build_object('make', p_vehicle->>'make', 'model', p_vehicle->>'model',
                           'year', (p_vehicle->>'year')::int, 'color', coalesce(p_vehicle->>'color', ''),
                           'vehicle_class', p_vehicle_class, 'plate', v_plate),
        p_idempotency_key, p_request_hash, p_manage_token_hash, p_source, v_tenant.status = 'demo');
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'bookings_tenant_id_idempotency_key_key' then
        -- A concurrent request with the same key committed first.
        select * into v_existing from public.bookings
        where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
        if v_existing.request_hash <> p_request_hash then
          raise exception 'IDEMPOTENCY_CONFLICT';
        end if;
        return jsonb_build_object('booking_id', v_existing.id, 'ref_code', v_existing.ref_code,
                                  'status', v_existing.status, 'replayed', true);
      elsif v_constraint = 'bookings_tenant_id_ref_code_key' and attempt < 5 then
        continue;
      else
        raise;
      end if;
    end;
  end loop;

  -- 6. Occupancy: the exclusion constraint is the final arbiter
  v_resource := private.allocate(
    p_tenant_id, v_service.resource_type,
    tstzrange(p_start_at - make_interval(mins => v_service.buffer_before_min),
              p_end_at + make_interval(mins => v_service.buffer_after_min), '[)'),
    p_booking_id, null);
  if v_resource is null then
    raise exception 'SLOT_TAKEN';
  end if;

  insert into public.booking_events (tenant_id, booking_id, actor, type, to_status, data)
  values (p_tenant_id, p_booking_id, p_source, 'created', v_status,
          jsonb_build_object('resource_id', v_resource, 'start_at', p_start_at, 'end_at', p_end_at));
  perform private.enqueue_notification(p_tenant_id, p_booking_id, 'booking.created');

  return jsonb_build_object('booking_id', p_booking_id, 'ref_code', v_ref, 'status', v_status, 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- Manage-link read model (customer, no account)
-- ---------------------------------------------------------------------------
create function private.get_booking_by_token(p_tenant_id uuid, p_token_hash bytea) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', b.id, 'ref_code', b.ref_code, 'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at,
    'service_id', b.service_id, 'service_name', b.service_name_snapshot,
    'vehicle_class', b.vehicle_class_snapshot, 'multi_day', b.multi_day_snapshot,
    'price_from_minor', b.price_from_minor_snapshot, 'currency', b.currency,
    'vehicle', b.vehicle_snapshot, 'contact_name', b.contact_name,
    'contact_phone_masked', overlay(b.contact_phone_e164 placing repeat('•', greatest(length(b.contact_phone_e164) - 6, 0))
                                    from 3 for greatest(length(b.contact_phone_e164) - 6, 0)),
    'customer_comment', b.customer_comment, 'is_demo', b.is_demo,
    'cancel_cutoff_at', b.start_at - make_interval(hours => s.cancel_cutoff_hours),
    'can_modify', b.status in ('requested', 'confirmed')
                  and now() <= b.start_at - make_interval(hours => s.cancel_cutoff_hours)
  )
  from public.bookings b
  join public.tenant_settings s on s.tenant_id = b.tenant_id
  where b.tenant_id = p_tenant_id and b.manage_token_hash = p_token_hash
$$;

-- ---------------------------------------------------------------------------
-- Reschedule (atomic: on any failure the original allocation stays intact)
-- ---------------------------------------------------------------------------
create function private.reschedule_booking(
  p_tenant_id uuid, p_booking_id uuid, p_new_start timestamptz, p_new_end timestamptz,
  p_actor public.booking_actor, p_actor_user_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.bookings;
  v_settings public.tenant_settings;
  v_prev_resource uuid;
  v_resource uuid;
begin
  select * into b from public.bookings where tenant_id = p_tenant_id and id = p_booking_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if b.status not in ('requested', 'confirmed') then
    raise exception 'INVALID_TRANSITION';
  end if;
  select * into v_settings from public.tenant_settings where tenant_id = p_tenant_id;
  if p_actor = 'customer' then
    if now() > b.start_at - make_interval(hours => v_settings.cancel_cutoff_hours) then
      raise exception 'CUTOFF_PASSED';
    end if;
    perform private.assert_customer_window(p_tenant_id, p_new_start);
  end if;
  perform private.assert_window(b.duration_min_snapshot, b.multi_day_snapshot, p_new_start, p_new_end);

  update public.resource_allocations set released_at = now()
  where booking_id = b.id and released_at is null
  returning resource_id into v_prev_resource;

  v_resource := private.allocate(
    p_tenant_id, b.resource_type_snapshot,
    tstzrange(p_new_start - make_interval(mins => b.buffer_before_min_snapshot),
              p_new_end + make_interval(mins => b.buffer_after_min_snapshot), '[)'),
    b.id, null, v_prev_resource);
  if v_resource is null then
    -- Raising aborts the whole transaction: the release above is rolled back.
    raise exception 'SLOT_TAKEN';
  end if;

  update public.bookings set start_at = p_new_start, end_at = p_new_end where id = b.id;
  insert into public.booking_events (tenant_id, booking_id, actor, actor_user_id, type, from_status, to_status, data)
  values (p_tenant_id, b.id, p_actor, p_actor_user_id, 'rescheduled', b.status, b.status,
          jsonb_build_object('from', jsonb_build_object('start_at', b.start_at, 'end_at', b.end_at),
                             'to', jsonb_build_object('start_at', p_new_start, 'end_at', p_new_end),
                             'resource_id', v_resource));
  perform private.enqueue_notification(p_tenant_id, b.id, 'booking.rescheduled');
  return jsonb_build_object('booking_id', b.id, 'start_at', p_new_start, 'end_at', p_new_end, 'resource_id', v_resource);
end
$$;

-- ---------------------------------------------------------------------------
-- Status machine
-- ---------------------------------------------------------------------------
create function private.allowed_transition(p_from public.booking_status, p_to public.booking_status) returns boolean
language sql immutable set search_path = '' as $$
  select (p_from, p_to) in (
    ('requested'::public.booking_status, 'confirmed'::public.booking_status),
    ('requested', 'cancelled'),
    ('confirmed', 'checked_in'), ('confirmed', 'cancelled'), ('confirmed', 'no_show'),
    ('checked_in', 'in_progress'), ('checked_in', 'cancelled'),
    ('in_progress', 'ready'),
    ('ready', 'completed')
  )
$$;

create function private.transition_booking(
  p_tenant_id uuid, p_booking_id uuid, p_to public.booking_status,
  p_actor public.booking_actor, p_actor_user_id uuid, p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.bookings;
  v_settings public.tenant_settings;
begin
  select * into b from public.bookings where tenant_id = p_tenant_id and id = p_booking_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if not private.allowed_transition(b.status, p_to) then
    raise exception 'INVALID_TRANSITION';
  end if;
  if p_actor = 'customer' then
    select * into v_settings from public.tenant_settings where tenant_id = p_tenant_id;
    if p_to <> 'cancelled' then
      raise exception 'FORBIDDEN';
    end if;
    if now() > b.start_at - make_interval(hours => v_settings.cancel_cutoff_hours) then
      raise exception 'CUTOFF_PASSED';
    end if;
  end if;

  update public.bookings set
    status = p_to,
    cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end,
    cancelled_by = case when p_to = 'cancelled' then p_actor else cancelled_by end,
    cancel_reason = case when p_to = 'cancelled' then nullif(p_reason, '') else cancel_reason end
  where id = b.id;

  if p_to in ('cancelled', 'no_show') then
    update public.resource_allocations set released_at = now()
    where booking_id = b.id and released_at is null;
  elsif p_to = 'completed' then
    -- Car picked up early: free the rest of the bay time.
    update public.resource_allocations
    set during = tstzrange(lower(during), greatest(now(), lower(during) + interval '1 minute'), '[)')
    where booking_id = b.id and released_at is null and upper(during) > now();
  end if;

  insert into public.booking_events (tenant_id, booking_id, actor, actor_user_id, type, from_status, to_status, data)
  values (p_tenant_id, b.id, p_actor, p_actor_user_id, 'status_changed', b.status, p_to,
          case when p_reason is null then '{}'::jsonb else jsonb_build_object('reason', p_reason) end);
  if p_to in ('cancelled', 'confirmed') then
    perform private.enqueue_notification(p_tenant_id, b.id, 'booking.' || p_to::text);
  end if;
  return jsonb_build_object('booking_id', b.id, 'status', p_to);
end
$$;

-- ---------------------------------------------------------------------------
-- Owner RPCs (authenticated; each checks membership of the row's tenant)
-- ---------------------------------------------------------------------------
create function private.booking_tenant(p_booking_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select tenant_id from public.bookings where id = p_booking_id
$$;

create function public.owner_transition_booking(
  p_booking_id uuid, p_to public.booking_status, p_reason text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tenant uuid := private.booking_tenant(p_booking_id);
  v_min public.member_role := case when p_to in ('checked_in', 'in_progress', 'ready', 'completed')
                                   then 'staff' else 'manager' end;
begin
  if v_tenant is null or not private.is_member(v_tenant, v_min) then
    raise exception 'NOT_FOUND';
  end if;
  return private.transition_booking(v_tenant, p_booking_id, p_to, 'owner', auth.uid(), p_reason);
end
$$;

create function public.owner_reschedule_booking(
  p_booking_id uuid, p_new_start timestamptz, p_new_end timestamptz
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_tenant uuid := private.booking_tenant(p_booking_id);
begin
  if v_tenant is null or not private.is_member(v_tenant, 'manager') then
    raise exception 'NOT_FOUND';
  end if;
  return private.reschedule_booking(v_tenant, p_booking_id, p_new_start, p_new_end, 'owner', auth.uid());
end
$$;

create function public.owner_set_final_price(p_booking_id uuid, p_amount_minor bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_tenant uuid := private.booking_tenant(p_booking_id);
begin
  if v_tenant is null or not private.is_member(v_tenant, 'manager') then
    raise exception 'NOT_FOUND';
  end if;
  if p_amount_minor is not null and p_amount_minor < 0 then
    raise exception 'INVALID_WINDOW';
  end if;
  update public.bookings set final_price_minor = p_amount_minor where id = p_booking_id;
  insert into public.booking_events (tenant_id, booking_id, actor, actor_user_id, type, data)
  values (v_tenant, p_booking_id, 'owner', auth.uid(), 'final_price_set', jsonb_build_object('amount_minor', p_amount_minor));
end
$$;

create function public.owner_create_block(
  p_resource_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_reason text default ''
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_block uuid;
begin
  select tenant_id into v_tenant from public.resources where id = p_resource_id;
  if v_tenant is null or not private.is_member(v_tenant, 'manager') then
    raise exception 'NOT_FOUND';
  end if;
  if p_ends_at <= p_starts_at or p_ends_at > p_starts_at + interval '60 days' then
    raise exception 'INVALID_WINDOW';
  end if;
  insert into public.resource_blocks (tenant_id, resource_id, starts_at, ends_at, reason, created_by)
  values (v_tenant, p_resource_id, p_starts_at, p_ends_at, coalesce(p_reason, ''), auth.uid())
  returning id into v_block;
  if not private.try_occupy(v_tenant, p_resource_id, tstzrange(p_starts_at, p_ends_at, '[)'), null, v_block) then
    raise exception 'SLOT_TAKEN';
  end if;
  return v_block;
end
$$;

create function public.owner_remove_block(p_block_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.resource_blocks where id = p_block_id and removed_at is null;
  if v_tenant is null or not private.is_member(v_tenant, 'manager') then
    raise exception 'NOT_FOUND';
  end if;
  update public.resource_blocks set removed_at = now() where id = p_block_id;
  update public.resource_allocations set released_at = now() where block_id = p_block_id and released_at is null;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges: private functions -> service_role only; owner RPCs -> authenticated
-- ---------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
grant execute on function private.is_member(uuid, public.member_role) to authenticated;

revoke all on function public.owner_transition_booking(uuid, public.booking_status, text) from public, anon;
revoke all on function public.owner_reschedule_booking(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.owner_set_final_price(uuid, bigint) from public, anon;
revoke all on function public.owner_create_block(uuid, timestamptz, timestamptz, text) from public, anon;
revoke all on function public.owner_remove_block(uuid) from public, anon;
grant execute on function public.owner_transition_booking(uuid, public.booking_status, text) to authenticated;
grant execute on function public.owner_reschedule_booking(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.owner_set_final_price(uuid, bigint) to authenticated;
grant execute on function public.owner_create_block(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.owner_remove_block(uuid) to authenticated;
