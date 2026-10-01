# DETAILFLOW

White-label operating system for automotive detailing studios: branded customer PWA with account-less booking, owner dashboard, tenant pipeline, Telegram notifications and an optional AI concierge. One codebase, one backend, many studios.

- Public: `/s/{slug}/` · Owner: `/s/{slug}/owner/`
- Config: `tenants/{slug}/business.json` + `assets/` → Postgres (Supabase)
- Plan and architecture: [`docs/PLAN.md`](docs/PLAN.md)
- Production runbook: [`docs/PRODUCTION.md`](docs/PRODUCTION.md) · status: [`docs/PRODUCTION_STATUS.md`](docs/PRODUCTION_STATUS.md)

## Stack

React 19 · Vite 8 · TypeScript 6 strict · React Router 8 · TanStack Query · Zod 4 · Tailwind 4 + shadcn-style primitives (radix-ui) · vite-plugin-pwa · Supabase (Postgres, Auth, Edge Functions on Deno) · Playwright · Vitest.

TypeScript is pinned to 6.0.3 because typescript-eslint does not support TS 7 yet.

## Layout

```
apps/web/                 customer PWA + owner dashboard (one SPA, code-split)
packages/domain/          slot engine, status machine, money/phone, zod API contracts
packages/config/          business.json schema, validator, accent tokens + WCAG gate
supabase/migrations/      schema, RLS, booking engine, notifications
supabase/functions/       public-api, owner-api, assistant, notify-dispatcher (Deno)
  _dev/gateway.ts         local stand-in for the Supabase gateway (routes + /auth/v1 proxy)
supabase/local/           Supabase platform bootstrap for a vanilla Postgres (local/tests only)
tenants/                  studios: graphite, ice-lab, _template
scripts/local/            local stack (Postgres + Supabase Auth built from source)
scripts/tenant/           seed, pipeline CLI, icons, manifests, demo artwork
tests/db, tests/api       Vitest against real Postgres + real handlers
tests/e2e                 Playwright against the whole local stack
```

## Run locally

Requirements: Node 22, pnpm 10, PostgreSQL 16 server binaries (with `btree_gist`), Go (to build Supabase Auth once). No Docker needed.

```bash
pnpm install
scripts/local/stack.sh init      # Postgres :54322, builds Supabase Auth (GoTrue) from source, auth migrations
scripts/local/stack.sh start     # Postgres + Auth :54324
pnpm db:migrate
scripts/local/stack.sh enable-edge-role   # least-privilege role used by the functions
pnpm tenant:seed --all           # GRAPHITE Detailing + ICE LAB, owners with password "detailflow-demo"
pnpm functions:serve             # Deno gateway :54321 (functions + /auth/v1)
pnpm dev                         # http://127.0.0.1:5173/s/graphite
```

Owner login: `http://127.0.0.1:5173/s/graphite/owner` — `owner@graphite-detailing.test` / `detailflow-demo` (ICE LAB: `owner@icelab-detailing.test`).

Environment variables: see [`.env.example`](.env.example).

## Checks

```bash
pnpm typecheck && pnpm lint      # TS strict, ESLint
pnpm test                        # unit: engine (incl. property tests), config, contracts, manifests
pnpm test:db                     # Postgres: RLS, isolation, concurrency, idempotency, API handlers, notifications, AI tools
pnpm functions:check             # deno check of every Edge Function entrypoint
pnpm test:e2e                    # Playwright on the full stack (recreates postgres_df)
pnpm test:pages                  # production build on the Cloudflare Pages runtime (wrangler/workerd)
pnpm build:prod                  # https API enforced + bundle secret scan
pnpm prod:verify-db              # read-only invariants of a deployed DB (PROD_DATABASE_URL)
pnpm test:prod                   # production smoke (PROD_* env; skipped as NOT VERIFIED without it)
```

## Tenant pipeline

```bash
pnpm tenant new north-shine --name "North Shine" --tz Asia/Novosibirsk --accent "#7fd18b"
# edit tenants/north-shine/business.json and assets/, then:
pnpm tenant validate north-shine
pnpm tenant:icons north-shine
pnpm tenant:seed north-shine          # status demo/draft from the file
pnpm tenant invite-owner north-shine owner@studio.ru     # prints a single-use accept link
pnpm tenant activate north-shine      # refuses while demo artwork / no phone / no owner
pnpm tenant export north-shine        # DB -> business.export.json
```

## Security model (short)

- `anon` has no table privileges; public traffic goes through Edge Functions that call `private.*` functions as `service_role`.
- Owner requests run as `authenticated` with the caller's verified JWT claims (exactly like PostgREST), so RLS decides visibility; mutations go through `owner_*` RPCs that re-check membership and role.
- `tenant_id` is resolved on the server (slug or membership), immutable, and intra-tenant references use composite foreign keys.
- Booking: price/duration/status/resource are set by the server; occupancy is guarded by `EXCLUDE USING gist` on `(resource_id, tstzrange)`; idempotency keys; reschedule is one transaction.

## Acceptance

| Requirement | Evidence |
|---|---|
| Two studios run at the same time | GRAPHITE (Moscow) and ICE LAB (Yekaterinburg, other hours/grid/catalog) seeded side by side; `tests/e2e/isolation.spec.ts` |
| One studio's data is not reachable from another | `tests/db/isolation.test.ts` (RLS per table, RPCs), `tests/db/security.test.ts` (grants audit), `tests/api/owner-api.test.ts`, E2E isolation |
| Concurrent booking never double-books | `tests/db/booking.test.ts` (20-way race, 3 bays/12 requests, contention regression), `tests/api/public-api.test.ts` (HTTP race), E2E race |
| Reschedule failure keeps the original | DB, API and owner-API tests assert allocation and times unchanged after `SLOT_TAKEN` |
| Price/duration come from the server | strict zod contracts reject `price`/`durationMin`/`endAt`/`tenant_id`; snapshot from the vehicle-class variant (DB + API tests) |
| AI cannot reach another tenant | `tests/api/assistant.test.ts`: tenant bound from the URL, foreign slugs / extra params / unknown tools rejected, no other-studio data in model input |
| Booking works with AI disabled | ICE LAB has AI off; assistant 503 without a key; API test + `tests/e2e/assistant-failsoft.spec.ts` |
| Demo never sends real notifications | dispatcher suppresses demo before any provider call: `tests/api/notifications.test.ts` (0 requests to the Bot API), E2E shows «не отправлено (демо)» |
| End-to-end customer → owner flow | `tests/e2e/customer-owner.spec.ts` (booking → owner login via Supabase Auth → workflow → final price → customer sees «Выдано») |

## Production deploy

One workflow, three repository secrets: [`docs/PRODUCTION.md` §0](docs/PRODUCTION.md). **Deploy production** creates or reuses the Supabase project and the Cloudflare Pages project, applies migrations, deploys the functions, seeds the studios, publishes the app and runs the production checks. Status: **deployed** — https://detailflow.pages.dev/s/graphite/ (owner: `/s/graphite/owner/`), verified by the workflow's production checks ([status](docs/PRODUCTION_STATUS.md)).

## Not verified

- **Claude API**: no `ANTHROPIC_API_KEY` configured; the assistant is fail-soft (booking works without it).
- **Custom domain**: not configured (the app runs on `detailflow.pages.dev`).
- **Demo imagery** is generated SVG artwork (`branding.demoArtwork: true`); `tenant activate` refuses to go live until it is replaced with the studio's photos.
