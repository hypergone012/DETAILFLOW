-- DETAILFLOW core schema.
-- Every tenant-owned row carries tenant_id; intra-tenant references use composite
-- foreign keys (tenant_id, id) so a row can never point at another tenant's data.

create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.tenant_status as enum ('draft', 'demo', 'active', 'suspended');
-- Declaration order matters: roles are compared with >=.
create type public.member_role as enum ('staff', 'manager', 'owner');
create type public.service_category as enum (
  'detailing_wash', 'paint_correction', 'ceramic_coating', 'ppf',
  'interior_detailing', 'leather_protection', 'pre_sale_preparation'
);
create type public.vehicle_class as enum ('compact', 'sedan', 'suv', 'large_suv', 'van', 'other');
create type public.resource_type as enum ('wash_bay', 'detail_bay', 'ppf_booth', 'paint_booth', 'interior_station');
create type public.booking_status as enum (
  'requested', 'confirmed', 'checked_in', 'in_progress', 'ready', 'completed', 'cancelled', 'no_show'
);
create type public.booking_actor as enum ('customer', 'owner', 'assistant', 'system');
create type public.notification_status as enum ('pending', 'sent', 'failed', 'suppressed_demo', 'not_configured');

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create function private.forbid_tenant_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'TENANT_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end
$$;

create function private.validate_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'INVALID_TIMEZONE: %', new.timezone using errcode = '22023';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (length(name) between 1 and 120),
  status public.tenant_status not null default 'draft',
  timezone text not null,
  currency text not null default 'RUB' check (currency ~ '^[A-Z]{3}$'),
  locale text not null default 'ru-RU',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tenants_tz before insert or update of timezone on public.tenants
  for each row execute function private.validate_timezone();
create trigger tenants_touch before update on public.tenants
  for each row execute function private.touch_updated_at();

-- Public-facing studio profile (shown on the storefront).
create table public.tenant_profiles (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  accent_hex text not null check (accent_hex ~ '^#[0-9a-f]{6}$'),
  tagline text not null default '',
  about text not null default '',
  address text not null default '',
  map_url text,
  phone_display text,
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  telegram_url text,
  whatsapp_url text,
  logo_url text,
  hero_url text,
  gallery jsonb not null default '[]'::jsonb check (jsonb_typeof(gallery) = 'array'),
  updated_at timestamptz not null default now()
);

-- Booking policy + private operational settings.
create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  slot_step_min int not null default 30 check (slot_step_min in (15, 30, 60)),
  min_notice_min int not null default 120 check (min_notice_min between 0 and 10080),
  horizon_days int not null default 45 check (horizon_days between 1 and 365),
  cancel_cutoff_hours int not null default 24 check (cancel_cutoff_hours between 0 and 336),
  requires_confirmation_default boolean not null default true,
  max_active_bookings_per_phone int not null default 3 check (max_active_bookings_per_phone between 1 and 50),
  -- Owner notification target (private: never exposed on the storefront).
  telegram_chat_id text,
  ai_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

-- ---------------------------------------------------------------------------
-- Catalog & capacity
-- ---------------------------------------------------------------------------
create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$'),
  category public.service_category not null,
  name text not null check (length(name) between 1 and 120),
  summary text not null default '',
  description text not null default '',
  requirements text[] not null default '{}',
  resource_type public.resource_type not null,
  duration_min int not null check (duration_min between 15 and 14400),
  price_from_minor bigint not null check (price_from_minor >= 0),
  buffer_before_min int not null default 0 check (buffer_before_min between 0 and 240),
  buffer_after_min int not null default 0 check (buffer_after_min between 0 and 240),
  multi_day boolean not null default false,
  requires_confirmation boolean,
  image_url text,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug),
  -- Same-day services must fit a working day.
  check (multi_day or duration_min <= 840)
);

create table public.service_variants (
  tenant_id uuid not null,
  service_id uuid not null,
  vehicle_class public.vehicle_class not null,
  duration_min int not null check (duration_min between 15 and 14400),
  price_from_minor bigint not null check (price_from_minor >= 0),
  primary key (service_id, vehicle_class),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id) on delete cascade
);

create table public.resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  type public.resource_type not null,
  name text not null,
  active boolean not null default true,
  sort int not null default 0,
  unique (tenant_id, id),
  unique (tenant_id, key)
);

-- Weekly working hours in the tenant's local time. ISO weekday: 1 = Monday.
create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  opens time not null,
  closes time not null,
  check (closes > opens),
  unique (tenant_id, weekday, opens)
);

-- Date-specific override: closed day or special hours (local date).
create table public.schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  local_date date not null,
  closed boolean not null,
  opens time,
  closes time,
  note text not null default '',
  unique (tenant_id, local_date),
  check (closed or (opens is not null and closes is not null and closes > opens))
);

-- ---------------------------------------------------------------------------
-- Customers & vehicles
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  internal_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, phone_e164)
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  make text not null check (length(make) between 1 and 60),
  model text not null check (length(model) between 1 and 60),
  year int check (year between 1950 and 2100),
  color text not null default '' check (length(color) <= 40),
  vehicle_class public.vehicle_class not null,
  plate text check (plate is null or length(plate) between 1 and 16),
  notes text not null default '' check (length(notes) <= 1000),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id) on delete cascade
);
create index vehicles_customer_idx on public.vehicles (tenant_id, customer_id);
create index vehicles_plate_idx on public.vehicles (tenant_id, plate);

-- ---------------------------------------------------------------------------
-- Bookings & occupancy
-- ---------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ref_code text not null check (ref_code ~ '^[A-Z0-9]{6}$'),
  customer_id uuid not null,
  vehicle_id uuid not null,
  service_id uuid not null,
  status public.booking_status not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- Server-side snapshot taken at booking time. Never supplied by the client.
  service_name_snapshot text not null,
  resource_type_snapshot public.resource_type not null,
  vehicle_class_snapshot public.vehicle_class not null,
  duration_min_snapshot int not null,
  buffer_before_min_snapshot int not null,
  buffer_after_min_snapshot int not null,
  multi_day_snapshot boolean not null,
  price_from_minor_snapshot bigint not null,
  currency text not null,
  final_price_minor bigint check (final_price_minor is null or final_price_minor >= 0),
  contact_name text not null,
  contact_phone_e164 text not null,
  contact_email text,
  customer_comment text not null default '' check (length(customer_comment) <= 1000),
  vehicle_snapshot jsonb not null,
  idempotency_key uuid not null,
  request_hash text not null,
  manage_token_hash bytea not null unique,
  source public.booking_actor not null,
  is_demo boolean not null,
  cancelled_at timestamptz,
  cancelled_by public.booking_actor,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, ref_code),
  unique (tenant_id, idempotency_key),
  check (end_at > start_at),
  foreign key (tenant_id, customer_id) references public.customers (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id),
  foreign key (tenant_id, service_id) references public.services (tenant_id, id)
);
create index bookings_tenant_start_idx on public.bookings (tenant_id, start_at);
create index bookings_tenant_status_idx on public.bookings (tenant_id, status, start_at);
create index bookings_customer_idx on public.bookings (tenant_id, customer_id);

create table public.resource_blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  resource_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default '',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  check (ends_at > starts_at),
  unique (tenant_id, id),
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id) on delete cascade
);

-- The single source of truth for "who occupies which bay when".
-- `during` includes service buffers. The exclusion constraint makes a double
-- booking of one resource physically impossible, whatever the application does.
create table public.resource_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  resource_id uuid not null,
  booking_id uuid,
  block_id uuid,
  during tstzrange not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  check (num_nonnulls(booking_id, block_id) = 1),
  check (not isempty(during) and lower_inc(during) and not upper_inc(during)
         and not lower_inf(during) and not upper_inf(during)),
  foreign key (tenant_id, resource_id) references public.resources (tenant_id, id),
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade,
  foreign key (tenant_id, block_id) references public.resource_blocks (tenant_id, id) on delete cascade,
  constraint resource_allocations_no_overlap
    exclude using gist (resource_id with =, during with &&) where (released_at is null)
);
create index resource_allocations_booking_idx on public.resource_allocations (booking_id) where released_at is null;
create index resource_allocations_tenant_idx on public.resource_allocations (tenant_id) where released_at is null;

create table public.booking_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  booking_id uuid not null,
  at timestamptz not null default now(),
  actor public.booking_actor not null,
  actor_user_id uuid,
  type text not null,
  from_status public.booking_status,
  to_status public.booking_status,
  data jsonb not null default '{}'::jsonb,
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade
);
create index booking_events_booking_idx on public.booking_events (booking_id, at);

-- ---------------------------------------------------------------------------
-- Infrastructure
-- ---------------------------------------------------------------------------
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid,
  event text not null,
  channel text not null check (channel in ('telegram')),
  status public.notification_status not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  foreign key (tenant_id, booking_id) references public.bookings (tenant_id, id) on delete cascade
);
create index notification_outbox_pending_idx on public.notification_outbox (next_attempt_at) where status = 'pending';

create table private.rate_limit_buckets (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);

-- AI audit trail: tool calls only, no conversation text / PII.
create table public.ai_tool_calls (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null,
  tool text not null,
  ok boolean not null,
  latency_ms int not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tenant_id immutability on every tenant-owned table
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'tenant_profiles', 'tenant_settings', 'tenant_members', 'services', 'service_variants', 'resources',
    'working_hours', 'schedule_exceptions', 'customers', 'vehicles', 'bookings', 'resource_blocks',
    'resource_allocations', 'booking_events', 'notification_outbox', 'ai_tool_calls'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.forbid_tenant_change()',
      t || '_tenant_immutable', t);
  end loop;
end
$$;

create trigger services_touch before update on public.services for each row execute function private.touch_updated_at();
create trigger customers_touch before update on public.customers for each row execute function private.touch_updated_at();
create trigger bookings_touch before update on public.bookings for each row execute function private.touch_updated_at();
