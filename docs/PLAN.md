# DETAILFLOW — Product & Architecture Plan

Статус: **план, implementation не начат.**
Дата: 2026-09-30.

---

## 0. Аудит окружения

### Репозиторий
- `hypergone012/DETAILFLOW`: пустой, коммитов нет. Файлов, `AGENTS.md`, `CLAUDE.md` и `.claude/skills` в проекте нет.
- Всё проектируется с нуля, ограничений от legacy-кода нет.

### Skills
- `ui-ux-pro-max` **в этой сессии не установлен.** Доступны только общие skills (docs/pdf/xlsx/code-review/security-review и т.п.).
  Дизайн-решения ниже приняты вручную, скилл не использовался. Если он нужен, его надо подключить к окружению.

### CLI / инструменты
| Инструмент | Статус | Последствие |
|---|---|---|
| node 22.22 / pnpm 10.33 / bun 1.3 | есть | pnpm workspace |
| psql + **PostgreSQL 16 server** + `btree_gist`, `pgcrypto` | есть | DB-тесты (exclusion constraints, RLS, concurrency) можно гонять локально на реальном Postgres |
| pgTAP | нет | SQL-тесты пишем через Vitest + `pg`, а не через pgTAP |
| supabase CLI | не установлен, есть npm-пакет `supabase@2.118.0` (через `pnpm dlx`) | |
| Docker | клиент есть, **daemon не запущен** | `supabase start` в этом контейнере не работает, нужен shim для auth-схемы (см. J) |
| `api.supabase.com` | **403 от network policy** | из этого контейнера нельзя сделать link/deploy в облачный Supabase без изменения network policy |
| `api.anthropic.com` | доступен | AI можно тестировать вживую при наличии ключа |
| deno | нет | Edge Functions: логику держим в чистых TS-модулях (тесты в Vitest), Deno-адаптер тонкий |
| Playwright CLI 1.56.1 + Chromium | есть | **закрепить `@playwright/test@1.56.1`** (npm latest 1.63 не совпадёт с предустановленным браузером) |
| gh | нет | GitHub через MCP |

### Актуальные версии (npm, 2026-09-30) и решения
| Пакет | latest | Решение |
|---|---|---|
| react / react-dom | 19.3.0 | ✅ |
| vite | 8.3.1 (Rolldown) | ✅ |
| @vitejs/plugin-react | 6.1.1 (peer vite ^8) | ✅ |
| react-router | 8.4.0 (peer react ≥19.2.7) | ✅ data-router SPA mode; API v8 сверить на scaffold |
| @tanstack/react-query | 5.104.0 | ✅ |
| zod | 4.6.5 | ✅ одна версия во фронте и в Edge Functions (`npm:zod@4.6.5`) |
| @supabase/supabase-js | 2.117.2 | ✅ |
| tailwindcss / @tailwindcss/vite | 4.3.3 (peer vite ^8) | ✅ |
| shadcn | 4.21.0 | ✅ как генератор компонентов |
| vite-plugin-pwa | 1.3.0 (peer vite ^8) | ✅ |
| **typescript** | **7.0.2** | ⚠️ **typescript-eslint 8.71 требует TS `<6.1.0`**. Берём **TS 6.0.3** strict. На 7.x переходим, когда lint-стек его поддержит |
| vitest | 5.0.3 | ✅ |
| fast-check | 4.10.2 | ✅ property-based тесты slot-движка |
| date-fns + @date-fns/tz | 4.4.0 / 1.5.0 | ✅ timezone-арифметика (`TZDate`) |
| libphonenumber-js | 1.13.14 | ✅ нормализация телефона в E.164 |
| @axe-core/playwright | 4.13.0 | ✅ a11y в E2E |
| **Astryx** | `@astryxdesign/core` 0.6.3 (facebook/astryx, StyleX) | ⚠️ см. ниже |

### ⚠️ Конфликт: Astryx vs shadcn/ui
В ТЗ указаны оба. Это два разных стилевых движка: shadcn = Tailwind v4 + Radix, Astryx = StyleX (нужен compile-time плагин) и своя система токенов.
Если держать оба:
- две системы токенов, акцент-цвет тенанта придётся прокидывать дважды;
- два набора a11y-примитивов (dialog, popover, focus-trap) с разным поведением;
- Astryx pre-1.0 (0.6.x), интеграция StyleX с Vite 8/Rolldown не проверена, растут риски бандла и сборки.

**Рекомендация:** shadcn/ui (Tailwind v4 + Radix) как слой примитивов плюс собственная система токенов DETAILFLOW. Astryx в MVP не брать и пересмотреть после 1.0.
Альтернатива: только Astryx без shadcn. **Нужно твоё решение** (см. §N).

---

## A. Product architecture

### Принципы
1. **Один код, один backend, много тенантов.** Тенант = строка в `tenants` + конфиг + ассеты. Кода под конкретного клиента нет.
2. **Сервер — единственный источник правды** для цены, длительности, статуса, ресурса и tenant_id. Клиент присылает только *намерение*: service_id, vehicle, желаемый start, контакты.
3. **Временная логика в TypeScript, атомарность в Postgres.**
   - `packages/domain`: чистый детерминированный slot-движок (рабочие часы, TZ/DST, буферы, multi-day). Один и тот же код работает в Edge Functions и в тестах.
   - Postgres: exclusion constraint + транзакционная RPC. Это последний и непробиваемый рубеж против двойного бронирования, даже если движок ошибся.
4. **anon не видит таблицы вообще.** Публичные операции идут через Edge Functions и узкие security-definer RPC.
5. **AI — опциональный слой поверх тех же server-side операций.** Своих путей записи у него нет.

### Структура репозитория
```
detailflow/
├─ apps/web/                      # React 19 SPA + PWA (public + owner, code-split)
│  ├─ src/app/                    # router, providers, error boundaries
│  ├─ src/tenant/                 # TenantProvider (slug → storefront config), theming
│  ├─ src/public/                 # customer PWA: home, services, booking, manage
│  ├─ src/owner/                  # owner dashboard (lazy chunk)
│  ├─ src/assistant/              # AI chat UI (lazy chunk, fail-soft)
│  ├─ src/ui/                     # shadcn-примитивы + DF-компоненты
│  └─ src/lib/                    # api client, query keys, supabase client
├─ packages/domain/               # slot engine, pricing resolution, status machine, zod-схемы API
├─ packages/config/               # zod-схема business.json, derive-токенов акцента
├─ supabase/
│  ├─ migrations/                 # SQL: schema, constraints, RLS, RPC
│  ├─ functions/                  # Edge Functions (Deno): public-api, owner-api, assistant, notify
│  │  └─ _shared/                 # импортирует packages/domain (relative / import map)
│  └─ seed/                       # dev-seed
├─ tenants/
│  ├─ _template/                  # business.json + assets для клонирования
│  └─ {slug}/business.json + assets/
├─ scripts/tenant/                # new / validate / seed / preview / activate / export
├─ tests/
│  ├─ db/                         # Postgres: RLS, constraints, concurrency, RPC
│  ├─ api/                        # Edge Function handlers
│  └─ e2e/                        # Playwright
└─ docs/
```

### Рантайм-поток
```
Browser (PWA /s/{slug}/)
   │  GET storefront (anon RPC, только публичные поля)
   │  POST /functions/v1/public-api/{availability|bookings|manage}
   ▼
Edge Function public-api  ── zod validate ── slug → tenant_id (сервер)
   │  domain.computeAvailability(...)  (TS, TZ-aware)
   │  rpc create_booking_atomic(...)   (service_role only)
   ▼
Postgres: транзакция → idempotency → customer/vehicle → booking(snapshot цены/длительности)
          → resource_allocations (EXCLUDE gist) → booking_events → notification_outbox
```
Owner-поток: Supabase Auth JWT → чтение через PostgREST под RLS; изменения идут через RPC (статус, блоки) и `owner-api` (reschedule, потому что нужен движок).

---

## B. Database schema

Все tenant-таблицы: `tenant_id uuid not null`, RLS `enable` + `force`. Ссылки внутри тенанта — **составные FK `(tenant_id, x_id)`**, поэтому cross-tenant ссылка невозможна физически. Деньги хранятся в minor units (`int`), время — `timestamptz` (UTC), локальные часы — `time` + IANA tz тенанта.

```sql
-- extensions
create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- enums
create type tenant_status   as enum ('draft','demo','active','suspended');
create type member_role     as enum ('owner','manager','staff');
create type service_category as enum ('detailing_wash','paint_correction','ceramic_coating',
                                      'ppf','interior_detailing','leather_protection','pre_sale_preparation');
create type vehicle_class   as enum ('compact','sedan','suv','large_suv','van','other');
create type resource_type   as enum ('wash_bay','detail_bay','ppf_booth','paint_booth','interior_station');
create type booking_status  as enum ('requested','confirmed','checked_in','in_progress',
                                     'ready','completed','cancelled','no_show');
create type cancel_actor    as enum ('customer','studio','system');

-- TENANCY
tenants (
  id uuid pk, slug citext unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name text, status tenant_status default 'draft',
  timezone text not null check (is_valid_tz(timezone)),     -- IANA
  currency char(3), locale text,
  config_version int, created_at, updated_at
)
tenant_settings (                                   -- 1:1, booking policy
  tenant_id pk fk, slot_step_min int check in (15,30,60),
  min_notice_min int, horizon_days int, cancel_cutoff_hours int,
  default_requires_confirmation bool,
  max_active_bookings_per_phone int default 3,
  contact jsonb, address jsonb, legal jsonb
)
tenant_branding (                                   -- 1:1, публичное
  tenant_id pk fk, accent_hex text check (~ '^#[0-9a-f]{6}$'),
  logo_path, hero_path, gallery jsonb, copy jsonb, social jsonb
)
tenant_members (tenant_id, user_id → auth.users, role member_role, pk(tenant_id,user_id))

-- CATALOG
services (
  id uuid, tenant_id, unique(tenant_id,id), slug, unique(tenant_id,slug),
  category service_category, name, description, requirements text[],
  resource_type resource_type not null,
  duration_min int check > 0,            -- рабочее время
  price_from_minor int check >= 0,
  buffer_before_min int default 0, buffer_after_min int default 0,
  multi_day bool default false,
  requires_confirmation bool null,       -- null → tenant default
  active bool, sort int, image_path
)
service_variants (                        -- цена/длительность по классу авто
  tenant_id, service_id, vehicle_class,
  duration_min int, price_from_minor int,
  pk(service_id, vehicle_class), fk (tenant_id,service_id) → services
)

-- CAPACITY
resources (id, tenant_id, unique(tenant_id,id), type resource_type, name, active, sort)
working_hours (tenant_id, weekday 0..6, opens time, closes time, check closes > opens)
                 -- несколько интервалов в день допустимы (обед)
schedule_exceptions (tenant_id, local_date date, closed bool, opens time null, closes time null, note)
resource_blocks (id, tenant_id, resource_id null /*null = все*/, during tstzrange, reason, created_by)

-- CUSTOMER & VEHICLE
customers (
  id, tenant_id, unique(tenant_id,id),
  name, phone_e164 text not null, email citext null,
  marketing_consent bool, internal_notes text,           -- internal_notes видит только owner
  unique(tenant_id, phone_e164)
)
vehicles (
  id, tenant_id, customer_id, fk(tenant_id,customer_id) → customers,
  make, model, year int check (year between 1950 and extract(year from now())+1),
  color, vehicle_class vehicle_class, plate text null, customer_notes text
)
vehicle_photos (id, tenant_id, vehicle_id, booking_id null, storage_path, kind ('customer','intake','result'), created_at)

-- BOOKING
bookings (
  id, tenant_id, unique(tenant_id,id), ref_code text unique per tenant (DF-7K3Q),
  customer_id, vehicle_id, service_id,            -- составные FK
  status booking_status,
  start_at timestamptz, end_at timestamptz,        -- клиентское окно (drop-off → ready)
  -- SNAPSHOT (сервер копирует на момент брони, клиент не задаёт)
  service_name_snapshot, duration_min_snapshot, price_from_minor_snapshot, currency,
  final_price_minor int null,                      -- ставит только owner
  contact_name, contact_phone_e164, contact_email, customer_comment,
  vehicle_snapshot jsonb,
  idempotency_key uuid not null, request_hash text not null,
  unique(tenant_id, idempotency_key),
  manage_token_hash bytea unique, manage_token_expires_at,
  source ('web','assistant','owner'), is_demo bool,
  cancelled_at, cancelled_by cancel_actor, cancel_reason,
  created_at, updated_at,
  check (end_at > start_at)
)
resource_allocations (
  id, tenant_id, resource_id, booking_id null, block_id null,
  during tstzrange not null,                        -- включает буферы
  released_at timestamptz null,
  check (num_nonnulls(booking_id, block_id) = 1),
  check (lower_inc(during) and not upper_inc(during) and not isempty(during)),
  EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (released_at IS NULL)
)
booking_events (id, tenant_id, booking_id, at, actor_type, actor_user_id null,
                type, from_status, to_status, payload jsonb)        -- append-only audit

-- INFRA
notification_outbox (id, tenant_id, booking_id, channel, template, recipient, payload,
                     status ('pending','sent','failed','suppressed_demo','not_configured'),
                     attempts, last_error, created_at, sent_at)
rate_limit_buckets (key text, window_start timestamptz, count int, pk(key, window_start))
ai_sessions (id, tenant_id, created_at, expires_at)                  -- без PII
ai_tool_calls (id, tenant_id, session_id, tool, input jsonb, ok bool, latency_ms, at)
```

Индексы: `bookings(tenant_id, start_at)`, `bookings(tenant_id, status, start_at)`, `vehicles(tenant_id, plate)`, `customers(tenant_id, phone_e164)`, gist-индекс `resource_allocations` уже даёт EXCLUDE.

Триггеры:
- `forbid_tenant_change`: на всех таблицах запрещает `UPDATE` поля tenant_id;
- `bookings_status_guard`: переход статуса только по матрице (см. D), а `final_price_minor` меняется только в RPC;
- `updated_at`.

Views, если понадобятся, создаются с `security_invoker = true`, иначе view обойдёт RLS.

---

## C. Tenant model

- **Идентичность:** `slug` в URL задаёт только маршрут. `tenant_id` **всегда** выводится сервером из slug (или из JWT-членства для owner) и никогда не приходит от клиента в теле запроса.
- **Жизненный цикл:** `draft → demo → active → suspended`.
  - `demo`: публичный сайт работает, брони создаются с `is_demo=true`, уведомления **физически подавляются** в dispatcher (`suppressed_demo`), в UI видна плашка «Демо». Любая проверка, которая отправляет наружу, смотрит на `tenant.status` в БД, а не на флаг клиента.
  - `suspended`: storefront показывает «временно недоступно», booking API возвращает 403, owner работает в read-only.
- **Конфигурация:**
  - `business.json` — формат авторинга и онбординга (в git, проверяется zod).
  - Runtime-источник правды — БД (`tenants`, `tenant_settings`, `tenant_branding`, `services`, `resources`, `working_hours`).
  - После go-live изменения, сделанные в dashboard, живут в БД. `tenant:export` выгружает БД обратно в `business.json` для версионирования, чтобы не было дрейфа.
- **Theming:** один `accent_hex` на тенанта. Из него на сервере или при валидации выводятся `accent`, `accent-hover`, `accent-subtle`, `on-accent`, `focus-ring` с **проверкой контраста WCAG AA** на тёмном фоне. Если контраст не проходит, валидатор падает, а не молча исправляет цвет.
- **Членство:** `tenant_members` (owner/manager/staff). Один пользователь может состоять в нескольких студиях.

---

## D. Booking / resource model

### Ресурсы
- Ресурс — физическая ёмкость: бокс/пост (`detail_bay`, `wash_bay`, `ppf_booth`, …). Услуга требует **один** `resource_type`.
- Бронь занимает **любой свободный** ресурс нужного типа. Ресурс выбирает сервер в детерминированном порядке (`sort`, `id`).
- Мастера как ресурс (бокс + мастер одновременно) — POST-SALE (multi-resource requirements).

### Время
- `slot_step_min` задаёт сетку стартов в локальном времени тенанта.
- Окно услуги:
  - однодневная: `start → start + duration`;
  - **multi-day:** рабочие минуты «проходят» по календарю рабочих часов с пропуском нерабочих дней и исключений. `end_at` — момент, когда накоплено `duration` рабочих минут. Машина стоит в боксе, поэтому **бокс занят непрерывно** от `start` до `end_at`, включая ночи.
- Занятость ресурса: `during = [start − buffer_before, end_at + buffer_after)`.
- Слот доступен, если:
  1. `start ≥ now + min_notice` и `start ≤ today + horizon_days`;
  2. старт и рабочее окно попадают в рабочие часы (для однодневной услуги вся работа укладывается в один рабочий интервал);
  3. существует ресурс нужного типа без пересечений с активными allocations и блоками.
- **TZ/DST:** сетка строится в IANA-зоне тенанта через `TZDate`. Несуществующие локальные времена (весенний переход) не предлагаются, повторяющиеся (осенний) берутся по первому вхождению. Всё хранится в UTC.

### Атомарное создание брони: `create_booking_atomic` (plpgsql, `security definer`, EXECUTE только `service_role`)
```
1. SELECT ... WHERE tenant_id=$t AND idempotency_key=$k
   → найдено и request_hash совпадает: вернуть ту же бронь (200, replay)
   → найдено, hash другой: 409 IDEMPOTENCY_MISMATCH
2. upsert customer по (tenant_id, phone_e164). Существующие name/email НЕ перезаписываем,
   контакт из формы кладём снапшотом в booking
3. проверка лимита активных будущих броней на телефон
4. insert vehicle (или reuse по vehicle_id, если он принадлежит этому customer)
5. insert booking: снапшот цены/длительности из services/service_variants (не из запроса),
   status = requested|confirmed по requires_confirmation
6. для каждого candidate resource_id (передаёт edge-функция, сервер перепроверяет тип/tenant):
      BEGIN insert resource_allocations ... ; EXIT;
      EXCEPTION WHEN exclusion_violation THEN continue;
   нет ни одного → RAISE 'SLOT_TAKEN' (вся транзакция откатывается)
7. insert booking_events('created'), notification_outbox(...)
8. вернуть {booking_id, ref_code, manage_token (сырой, только в ответе; в БД sha256)}
```
Гонка двух клиентов за последний бокс: один получает allocation, второй `SLOT_TAKEN → 409`, фронт обновляет слоты. Гарантию даёт EXCLUDE constraint, а не проверка в коде.

### Idempotency / retry
- Фронт генерирует `idempotency_key` (uuid v4) **при входе на шаг подтверждения** и хранит его в draft (sessionStorage). Повторный клик, ретрай сети или двойной submit дают ту же бронь.
- TanStack mutation `retry` включён только для сетевых ошибок, 4xx не ретраим.

### State machine
```
requested ─confirm→ confirmed ─check_in→ checked_in ─start→ in_progress ─ready→ ready ─complete→ completed
    │                   │            │                                                (закрыто)
    └──cancel──────────┴──cancel─────┘ (студия)          confirmed ─no_show→ no_show
customer cancel: только requested|confirmed и до cancel_cutoff_hours
```
- Отмена или no_show проставляет `released_at` в allocations, слот освобождается.
- `completed` освобождает хвост allocation (`upper = now()`), если машину забрали раньше.

### Reschedule
Одна транзакция: release старой allocation → insert новой → при `SLOT_TAKEN` откат, старая бронь остаётся нетронутой. Клиент может переносить через manage-token до cutoff, owner — всегда. Всё пишется в `booking_events`.

### Block
Owner блокирует ресурс или все ресурсы на интервал. Это `resource_blocks` + allocation с `block_id`, то есть блок подчиняется тому же EXCLUDE. Блок поверх существующей брони запрещён, UI показывает конфликт.

---

## E. Customer + Vehicle model

- **Аккаунт клиенту не нужен.** Идентификатор внутри тенанта — `phone_e164` (нормализация libphonenumber, страна по умолчанию из `tenant.locale`).
- **Приватность:** публичного lookup'а «найди меня по телефону» нет, иначе это enumeration и утечка. Повторный визит:
  - локально на устройстве (`localStorage`: последние авто и контакты, только у этого клиента);
  - сервер сам склеивает по телефону. Owner видит историю, клиент — только свою бронь по токену.
- **Manage-link:** `/s/{slug}/b/{token}`. Токен 256 бит, в БД хранится sha256. Срок: `end_at + 30d`. Даёт: просмотр, .ics, перенос, отмену, (NICE) загрузку фото.
- **Vehicle:** `make, model, year, color, vehicle_class, plate?, customer_notes`, фото. Make и model — combobox по встроенному справочнику популярных марок со свободным вводом (без внешнего API в MVP).
- **`vehicle_class` — ключевое детейлинг-поле:** он выбирает `service_variants` (цена «от» и длительность для SUV больше, чем для compact). Поэтому шаг «автомобиль» стоит до выбора даты, и flow из ТЗ это уже учитывает.
- **Фото:**
  - приватный bucket `vehicle-photos/{tenant_id}/{vehicle_id}/…`;
  - загрузка только по signed upload URL от edge-функции (с manage-token): ≤ 5 файлов, ≤ 8 MB, image/jpeg|png|webp|heic;
  - чтение: owner через RLS на `storage.objects` по `tenant_id` из пути, клиент — signed URL по токену;
  - EXIF/GPS вычищаем при обработке (POST-SALE: серверный resize).
- **Снапшоты:** бронь хранит `vehicle_snapshot` и контакт на момент записи, поэтому последующие правки профиля не переписывают историю.

---

## F. Owner dashboard — information architecture

Цель: за 5 секунд утром понять, что происходит в боксах сегодня.

```
/s/{slug}/owner/login
/s/{slug}/owner/                    → Today (default)
/s/{slug}/owner/schedule?date=&view=day|week
/s/{slug}/owner/bookings?status=&q=
/s/{slug}/owner/bookings/{id}
/s/{slug}/owner/customers?q=
/s/{slug}/owner/customers/{id}      (авто + история)
/s/{slug}/owner/settings            (часы, исключения/выходные, блоки; POST-SALE: услуги, бренд)
```

**Today** (desktop: 2 колонки; mobile: одна колонка + bottom nav)
- Верхняя полоса счётчиков. Только реальные числа из БД, без фейковых метрик:
  - «Ждут подтверждения»;
  - «Приезжают сегодня»;
  - «В работе»;
  - «Готовы к выдаче».
- **Resource timeline:** боксы — строки, время — ось X, брони — блоки с номером/маркой/услугой, блокировки заштрихованы, multi-day уходит за край с меткой «→ ср». Линия «сейчас».
- **Queue:** хронологический список действий («08:30 BMW X5 · Керамика · Принять авто»), одна кнопка — следующий статус.

**Booking detail** (sheet на mobile, панель справа на desktop)
- Шапка: ref_code, статус-степпер, окно drop-off → ready.
- Авто: make/model/year/color/plate (моноширинный), класс, заметки клиента, фото.
- Клиент: имя, телефон (tap-to-call / мессенджер), email, число прошлых визитов, internal notes.
- Услуга: snapshot, «от X», поле **final price** (только owner).
- Действия: Подтвердить · Принять авто · В работе · Готово · Выдано · Не приехал · Перенести · Отменить (с причиной).
- История (`booking_events`).

**Schedule**: day/week по ресурсам, создание блока (tap по пустому месту), перенос через диалог (MUST). Drag-and-drop — NICE.

**Bookings**: плотная таблица (desktop), карточки (mobile). Поиск по номеру авто, телефону, имени, ref.

**Customers**: список → профиль → авто → брони.

Nav mobile: `Сегодня · Расписание · Брони · Клиенты · Ещё`.
Обновление данных: Supabase Realtime по `bookings` тенанта (RLS-aware) с fallback на polling 30s.

---

## G. Customer PWA — information architecture

```
/s/{slug}/                        Home
/s/{slug}/services                Каталог по категориям
/s/{slug}/services/{serviceSlug}  Деталь услуги
/s/{slug}/book                    Booking flow (?service= предвыбор)
/s/{slug}/b/{token}               Manage booking
/s/{slug}/assistant               AI (также как bottom sheet с любой страницы)
```

**Home:** full-bleed фото студии/работ, имя, одна строка позиционирования, CTA «Записаться». Ниже:
- категории (фото-плитки);
- 3–4 флагманских услуги с «от X · ~N ч/дн»;
- адрес/карта-ссылка, часы, телефон;
- галерея работ.

**Booking flow**: 5 шагов, прогресс-полоса, sticky bottom CTA, минимум решений.
1. **Услуга.** Категория → услуга (если не предвыбрана). Показаны «от X», длительность, требования («машина должна быть чистой» и т.п.).
2. **Автомобиль.** Марка, модель, год, цвет, класс (иконки силуэтов), номер (опц.), заметки. Если авто сохранены на устройстве, выбираются одним тапом. После выбора класса цена и длительность пересчитываются.
3. **Дата/время.** Полоса дней на 14 дней (недоступные приглушены), затем сетка слотов. Для multi-day: «Сдать пн 09:00 → Забрать ≈ ср 17:00».
4. **Контакты.** Имя, телефон (маска по стране), email (опц.), комментарий, согласие на обработку данных.
5. **Подтверждение.** Сводка, «Итоговая цена после осмотра, от X», кнопка «Записаться». Далее Success: ref, окно, «Добавить в календарь», ссылка управления, «Что взять/как подготовить авто».

Состояния ошибок:
- `SLOT_TAKEN`: «Это время только что заняли», возврат на шаг 3 со свежими слотами, введённые данные сохранены;
- offline: «Нужен интернет для записи», draft сохранён;
- `suspended`: информационная страница.

**PWA:**
- per-tenant manifest `/s/{slug}/manifest.webmanifest`: `id` и `scope`/`start_url` = `/s/{slug}/`, name, icons, theme_color;
- SW: precache shell, `stale-while-revalidate` для storefront/каталога/изображений, **network-only для availability/booking/owner API** (никакого кэша слотов).

---

## H. AI architecture

### Роль
Customer concierge в PWA: объясняет услуги, помогает выбрать (например, «керамика или PPF для новой машины»), смотрит свободное время, **готовит черновик брони**. Бронь **создаёт пользователь** кнопкой в обычном UI, через тот же `public-api`.

### Контур
```
PWA chat ─POST→ Edge Function `assistant` (slug → tenant_id на сервере, rate-limit)
   → Claude Messages API (tool use), system prompt = политика + факты студии
   → tool_use → dispatcher (allowlist) → те же domain/DB функции, что у public-api
   → tool_result (данные) → ответ + опциональный structured card {booking_draft}
```

### Tools (allowlist, tenant_id подставляется сервером, модели не виден и не принимается)
| Tool | Вход (zod) | Что делает |
|---|---|---|
| `list_services` | `{category?}` | каталог тенанта (публичные поля) |
| `get_service` | `{service_slug}` | детали, требования, цены/длительности по классам |
| `get_studio_info` | `{}` | часы, адрес, политика отмены, контакты |
| `check_availability` | `{service_slug, vehicle_class, date_from, date_to ≤ 7 дн}` | domain engine, до N слотов |
| `prepare_booking_draft` | `{service_slug, vehicle_class, start_at, vehicle?}` | валидирует слот, **ничего не пишет**, возвращает карточку для UI → пользователь подтверждает в booking flow (шаг 4–5) |
| `handoff_to_human` | `{reason}` | показать телефон/мессенджер студии |

Запреты (жёстко в коде, не только в промпте):
- у модели нет SQL и нет доступа к tenant_id;
- нет tool, который пишет бронь, меняет цену или длительность;
- цены и длительности в ответе — только из tool_result (системная инструкция + пост-проверка: суммы в ответе сверяются с каталогом, если это проверяемо, иначе ответ идёт без цифр);
- tool-результаты и текст пользователя — данные, не инструкции (защита от prompt injection);
- лимиты: 20 сообщений на сессию, `max_tokens`, 8 tool-итераций на ход, rate-limit по IP-hash и тенанту.

### Модель и деградация
- Модель задаётся конфигом (`AI_MODEL`, по умолчанию `claude-sonnet-5-5`; дешевле — `claude-haiku-4-5-20251001`). Ключ хранится в Supabase secrets.
- **Fail-soft:** таймаут 20s, circuit breaker (N ошибок → AI off на 5 мин). UI: вход в ассистента скрывается или показывает «Ассистент недоступен — запишитесь напрямую» + CTA. **Booking flow от AI не зависит** ни кодом, ни чанком (lazy import, ошибка изолирована error boundary).
- `ai_enabled` на уровне тенанта. Demo-тенант может использовать AI, но уведомлений от него нет (он их и не шлёт).
- Логи: `ai_tool_calls` без PII. Текст диалога не храним в MVP.

POST-SALE: owner-AI (сводка дня, черновики ответов клиентам, заполнение business.json из сайта студии).

---

## I. Security / RLS model

### Роли
| Роль | Доступ |
|---|---|
| `anon` | **0 прав на таблицы.** EXECUTE только на `public_get_storefront(slug)` (публичные поля: branding, активные услуги/варианты, часы, контакт). Всё остальное через Edge Functions |
| `authenticated` | SELECT по RLS `is_member(tenant_id)`. INSERT/UPDATE/DELETE на bookings/allocations **запрещены напрямую**, только через RPC `owner_*` (security definer + внутренняя проверка membership и роли) |
| `service_role` | только внутри Edge Functions, ключ никогда не попадает во фронт |

### Правила
- `alter default privileges ... revoke all ... from anon, authenticated` плюс явные grant'ы. **CI-тест** проверяет `information_schema.role_table_grants`: у anon нет ни одной табличной привилегии.
- RLS-хелпер `private.is_member(t uuid, min_role member_role)`: `security definer`, `stable`, `search_path=''`, использует `(select auth.uid())` (initPlan-кэш).
- Схема `private` не экспонируется в PostgREST (внутренние функции, `create_booking_atomic`).
- Все security definer функции: `set search_path = ''`, полные имена объектов, явный `revoke execute from public`.
- Составные FK исключают cross-tenant ссылки. Триггер запрещает смену `tenant_id`.
- Storage: `tenant-assets` — public-read (только брендинг). `vehicle-photos` — private, RLS по префиксу `{tenant_id}/`.
- Edge Functions:
  - zod на каждом входе с `.strict()` (лишние поля вроде `price` или `tenant_id` дают 400, а не молча игнорируются);
  - CORS allowlist;
  - rate-limit (`rate_limit_buckets`);
  - honeypot-поле;
  - (NICE) Cloudflare Turnstile.
- Supabase keys: publishable key во фронте, secret key только в Edge Functions.
- Анти-спам слотов: лимит активных будущих броней на телефон и на IP-hash в сутки.
- PII: контакт клиента не отдаётся публично никогда. Manage-endpoint отдаёт только свою бронь и замаскированный телефон.

---

## J. Test strategy

Принцип: **каждый инвариант из ТЗ — минимум один автоматический тест, который упадёт при его нарушении.** Скриншоты и сборка — не тест.

| Слой | Инструмент | Что покрывает |
|---|---|---|
| Domain unit | Vitest | сетка слотов, рабочие часы с обедом, исключения, min_notice/horizon, буферы, multi-day через выходные, DST spring/fall (Europe/Berlin 2026-03-29 / 2026-10-25, America/New_York), variant resolution |
| Domain property | fast-check | для любых случайных расписаний: предложенные слоты не пересекают занятость; `end_at − start` в рабочих минутах = duration; движок детерминирован |
| DB | Vitest + `pg` на **реальном Postgres 16** | миграции применяются с нуля; EXCLUDE ловит overlap; **concurrency: 20 параллельных соединений на один последний слот → ровно 1 успех, 19 SLOT_TAKEN**; idempotency replay/mismatch; снапшот цены игнорирует клиентский ввод; матрица статусов; reschedule атомарен (провал → старая бронь цела); cancel освобождает слот |
| RLS | Vitest + `pg`, `set role anon/authenticated` + `request.jwt.claims` | anon: 0 строк или permission denied на каждую таблицу; owner A не видит и не меняет данные B; staff не может то, что может owner; прямой UPDATE `bookings.price*` / `tenant_id` запрещён; grants-audit |
| Edge handlers | Vitest (чистые handler-функции с DI) | 400 на лишние поля (`tenant_id`, `price`, `status`); slug → tenant; demo → `suppressed_demo`; suspended → 403; rate-limit |
| AI | Vitest с fake Anthropic client | tool allowlist; неизвестный tool отклоняется; tenant_id из сессии, не из аргументов; при 5xx/таймауте ассистента `/book` работает; draft не создаёт записей в БД |
| E2E | Playwright 1.56.1, mobile viewport + desktop | полный booking flow; SLOT_TAKEN recovery; manage: cancel/reschedule; owner login → today → статусы → перенос → блок; AI endpoint → 503, бронирование проходит; axe без serious/critical |
| Config | Vitest | все `tenants/*/business.json` валидны; контраст акцента; ассеты на месте |

**Postgres в тестах:**
- CI (GitHub Actions): `supabase start` (docker) + прогон всех слоёв. Так авторизация, роли и storage совпадают с Supabase.
- В этом контейнере docker-daemon нет, поэтому локальный PG16 + **shim** (`auth` schema, `auth.uid()` из `request.jwt.claims`, роли `anon/authenticated/service_role`, `storage.objects` stub). Shim используется только в тестах и никогда не попадает в миграции.

CI-гейт на PR: typecheck → lint → unit → db/rls → handlers → build → e2e (smoke).

---

## K. Tenant cloning pipeline

```
pnpm tenant:new  <slug> --name "…" [--from _template]
      → tenants/<slug>/business.json + assets/ (заглушки с пометкой TODO)
pnpm tenant:validate <slug>
      → zod-схема; уникальность slug; IANA tz; валюта/локаль; часы непересекающиеся;
        у каждой услуги есть ресурс её типа; контраст акцента AA;
        изображения: формат, размер, минимальное разрешение hero ≥ 2000px; обязательные тексты
pnpm tenant:preview <slug>
      → локальный запуск против dev-БД, статус demo
pnpm tenant:seed <slug> --env staging|prod
      → идемпотентный upsert по натуральным ключам (slug услуг/ресурсов),
        загрузка ассетов в Storage, генерация manifest + иконок (maskable),
        статус остаётся demo
pnpm tenant:invite-owner <slug> <email>
      → Supabase Auth invite + tenant_members(owner)
pnpm tenant:activate <slug>
      → чек-лист: owner принял инвайт, уведомления сконфигурированы, legal-тексты есть,
        тестовая бронь прошла → статус active
pnpm tenant:export <slug>
      → БД → business.json (обратная синхронизация)
```

Фрагмент `business.json`:
```json
{
  "$schema": "../../packages/config/business.schema.json",
  "slug": "carbon-lab", "name": "Carbon Lab Detailing",
  "locale": "ru-RU", "currency": "RUB", "timezone": "Europe/Moscow",
  "branding": { "accent": "#E4B43C", "logo": "assets/logo.svg", "hero": "assets/hero.jpg" },
  "policy": { "slotStepMin": 30, "minNoticeMin": 120, "horizonDays": 45,
              "cancelCutoffHours": 24, "requiresConfirmation": true },
  "hours": { "mon": [["09:00","13:00"],["14:00","20:00"]], "sun": [] },
  "resources": [{ "key": "bay-1", "type": "detail_bay", "name": "Бокс 1" }],
  "services": [{
    "slug": "ceramic-pro-3y", "category": "ceramic_coating", "name": "Керамика 3 года",
    "resourceType": "detail_bay", "durationMin": 960, "priceFrom": 45000,
    "bufferAfterMin": 60, "multiDay": true,
    "variants": { "suv": { "durationMin": 1200, "priceFrom": 55000 } },
    "requirements": ["Автомобиль после мойки не требуется — входит в подготовку"]
  }]
}
```
Цель: новая студия от получения материалов до demo-URL — **≤ 60 минут**, без правок кода.

---

## L. Deployment architecture

```
                ┌───────────── CDN / static hosting (Cloudflare Pages | Vercel | Netlify) ─┐
Browser ──────► │ apps/web dist (SPA, fallback /s/* → index.html), per-tenant manifests    │
                └──────────────────────────────────────────────────────────────────────────┘
      │ HTTPS
      ▼
Supabase project (per env: staging, prod)
  ├─ Postgres (migrations из supabase/migrations через CLI в CI)
  ├─ Auth (email + magic link / password для owner)
  ├─ Storage (tenant-assets public, vehicle-photos private)
  ├─ Edge Functions: public-api, owner-api, assistant, notify-dispatcher (cron)
  └─ Secrets: AI key, email/SMS provider key
External: Anthropic API; провайдер уведомлений (решение за тобой, см. §N)
```
- **Окружения:** `local` (shim / supabase start), `staging` (все demo-тенанты, sales-демо), `prod`.
- **CI/CD** (GitHub Actions):
  - на PR — тесты;
  - на `main` — миграции + функции → staging, ручной promote → prod;
  - фронт деплоится атомарно.
  - Нужен `SUPABASE_ACCESS_TOKEN` в GitHub secrets. Из этого контейнера `api.supabase.com` закрыт network policy.
- **Уведомления:** outbox-паттерн. `notify-dispatcher` по cron (1 мин) берёт `pending`:
  - `tenant.status='demo'` → `suppressed_demo`;
  - нет ключа провайдера → `not_configured` (виден в dashboard честно, без фейкового «отправлено»);
  - ошибка → retry с backoff, максимум 5 попыток.
- **Наблюдаемость:** structured logs в Edge Functions (request_id, tenant_id, без PII), Sentry во фронте (NICE).
- **Домены:** MVP — `app.<domain>/s/{slug}/`. POST-SALE — custom domain студии (host → slug mapping).
- **Бэкапы:** Supabase PITR на prod (платный план).

---

## M. 48-hour MVP scope

Реалистичный план при одном исполнителе. Порядок сдвига приоритетов при отставании указан в конце.

| Часы | Блок | Готово, когда |
|---|---|---|
| 0–4 | Scaffold: pnpm workspace, Vite 8, React 19, TS 6.0 strict, Tailwind 4 + shadcn, Router, Query, zod, PWA plugin, ESLint, Vitest, Playwright, CI | `pnpm check` зелёный в CI |
| 4–12 | Миграции: схема B, EXCLUDE, составные FK, триггеры, RLS, RPC `create_booking_atomic`, `owner_transition`, `owner_block`, `public_get_storefront`; тест-харнесс PG + auth shim | DB/RLS/concurrency тесты зелёные |
| 12–18 | `packages/domain`: availability + multi-day + DST + variants + status machine | unit + property тесты зелёные |
| 18–24 | Edge `public-api`: storefront, availability, create booking, manage (get/cancel/reschedule); `owner-api` reschedule; outbox + dispatcher (demo suppress, not_configured) | handler-тесты зелёные |
| 24–32 | Customer PWA: design tokens, Home, Services, Booking flow (5 шагов), Success, Manage, manifest per tenant | E2E booking + SLOT_TAKEN + cancel |
| 32–40 | Owner: login, Today (timeline + queue), Booking detail + статусы + final price, reschedule, cancel, блоки, Customers → Vehicles | E2E owner flow |
| 40–44 | AI concierge (read-only tools + draft), fail-soft; tenant CLI new/validate/seed | AI tests + E2E «AI down» |
| 44–48 | Demo-тенант с реальными фото, security pass (grants audit, `.strict()` везде), deploy staging, README | staging URL, все тесты зелёные |

**Если не успеваем, режем в таком порядке:** AI → week view → Customers list (оставить только из брони) → tenant:export → multi-day UI-полировка. **Не режем никогда:** EXCLUDE/атомарность, RLS, idempotency, DST-тесты, demo-suppression.

### MUST HAVE FOR FIRST SALE
- Multi-tenant ядро: slug-routing, изоляция tenant_id, RLS, anon без табличных прав
- Брендинг тенанта: accent + лого + фото + тексты из business.json
- Каталог: 7 категорий, услуги с price_from, duration, buffers, requirements, resource_type, multi-day, **варианты по классу авто**
- Booking flow без аккаунта: service → vehicle → date/time → contact → confirm
- Атомарная бронь, защита от double-booking, idempotency, TZ/DST, рабочие часы, исключения/выходные
- Manage-ссылка: просмотр, .ics, перенос, отмена с cutoff
- Owner: auth, Today, booking detail, статусы, перенос, отмена, блоки, клиент + авто
- Уведомление owner о новой брони + подтверждение клиенту через **один реальный провайдер** (либо честный статус `not_configured`)
- Demo-режим с гарантированным подавлением уведомлений
- PWA: установка, per-tenant manifest, offline shell
- Tenant pipeline: new / validate / seed / invite-owner / activate
- Автотесты всех инвариантов (J), CI-гейт
- Legal: согласие на обработку ПДн, политика конфиденциальности тенанта (шаблон)

### NICE TO HAVE
- AI concierge (если не вошёл в 48ч, то сразу после; архитектура готова)
- Фото авто от клиента (по manage-ссылке) и intake/result-фото от студии
- Drag-and-drop перенос в Schedule, week view
- Realtime-обновление dashboard (вместо polling)
- Turnstile/капча
- Напоминание клиенту за 24ч
- `tenant:export`, preview-деплой на каждый тенант
- Sentry, базовая продуктовая аналитика (реальные события, без фейковых дашбордов)

### POST-SALE
- Редактор услуг, цен, часов и бренда в dashboard (сейчас это business.json + seed)
- Мастера как второй ресурс (bay + technician), навыки, загрузка персонала
- Предоплата/депозиты (Stripe / ЮKassa), no-show fee
- Мессенджеры (WhatsApp/Telegram), SMS
- Custom domains для студий
- Owner-AI: сводка дня, ответы клиентам, онбординг из существующего сайта
- Отчёты (выручка по final_price, загрузка боксов) — только на реальных данных
- Лояльность, пакеты/абонементы, гарантийные талоны на керамику/PPF с напоминанием об обслуживании
- Мульти-локации одного бренда
- Billing для DETAILFLOW (подписка студий), self-serve онбординг

---

## Дизайн-язык (сквозной для F/G)

- **Поверхности:** графит, не чистый чёрный. `--bg #0B0C0E`, `--surface-1 #121418`, `--surface-2 #181B20`, hairline `--line rgba(255,255,255,.08)`. Текст `#E8EAED` / `#9AA0A6`.
- **Акцент:** один на тенанта. Используется только для primary CTA, выбранного состояния, «сейчас»-линии и фокуса. Всё остальное нейтральное.
- **Типографика:**
  - заголовки — широкий гротеск с технической геометрией (например, *Archivo* с осью width, expanded для H1);
  - UI — *Inter*;
  - данные (номера авто, время, цены, ref) — моноширинный с tabular-nums (*JetBrains Mono* / *IBM Plex Mono*).
- **Фото:** full-bleed hero, фото-плитки категорий с тёмным градиентом снизу только ради читаемости. Фото — главный декор, других декоративных элементов нет.
- **Тактильность:** touch-targets ≥ 44px, выраженное pressed-состояние (сдвиг 1px + затемнение), sticky bottom CTA, segmented controls вместо dropdown'ов.
- **Motion:** 120–200 ms ease-out, только для смены шагов, sheet'ов и подтверждений. `prefers-reduced-motion` уважается.
- **Не используем:** фиолетовые AI-градиенты, glassmorphism, 3D, parallax, фейковые графики.
- Owner: плотнее (row 36px desktop), моноширинные колонки, нейтральная палитра статусов (цвет несёт смысл, а не украшает).

---

## N. Открытые вопросы (нужны до implementation)

1. **Astryx vs shadcn/ui.** Рекомендую shadcn + свои токены, Astryx не брать (см. §0). Подтверди.
2. **Рынок/локаль:** RU (152-ФЗ, ₽, Telegram/WhatsApp) или EU/US (GDPR, email/SMS)? От этого зависят телефонные маски, legal-тексты и канал уведомлений.
3. **Провайдер уведомлений для first sale:** email (Resend/Postmark/SMTP), Telegram-бот для owner, SMS?
4. **Режим подтверждения по умолчанию:** рекомендую per-service (мойка — instant, керамика/PPF — requested).
5. **Supabase:** есть ли проект/токен? Из этого контейнера `api.supabase.com` закрыт network policy, docker-daemon не запущен. Для деплоя нужен allowlist хоста или деплой из CI с секретом.
6. **Хостинг фронта:** Cloudflare Pages / Vercel / Netlify?
7. **Фото для demo-тенанта:** реальные фото студии-пилота или лицензированный сток?
8. **Первый тенант:** есть ли конкретная студия-пилот (для business.json и реальных услуг)?
