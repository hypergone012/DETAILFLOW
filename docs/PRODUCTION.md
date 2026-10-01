# DETAILFLOW — production runbook

Target: Supabase (Postgres, Auth, Edge Functions) + Cloudflare Pages. Every step below is scripted; the manual steps are one-time per project and marked **[once]**.

Current verification state of each step: [`PRODUCTION_STATUS.md`](PRODUCTION_STATUS.md).

---

## 0. Go-live from three secrets (recommended path)

`.github/workflows/deploy.yml` (Actions → **Deploy production** → Run workflow) does every step of §1–§10 by itself through the Supabase Management API and the Cloudflare API (`scripts/prod/provision.ts`). It needs three **repository secrets** (Settings → Secrets and variables → Actions → New repository secret):

| Secret | What it is | Where to get it |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Personal access token of the Supabase account (`sbp_…`) | supabase.com/dashboard/account/tokens → Generate new token |
| `CLOUDFLARE_API_TOKEN` | API token with **Account → Cloudflare Pages → Edit** | dash.cloudflare.com/profile/api-tokens → Create Token → Create Custom Token |
| `DF_OWNER_PASSWORD` | Password of the GRAPHITE owner account (≥ 8 chars), chosen by the operator | — |

Optional secrets: `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_CHAT_ID` for the live delivery check), `ANTHROPIC_API_KEY`. Optional variables: `SUPABASE_PROJECT_REF` (use an existing project), `CF_PAGES_PROJECT` (default `detailflow`).

What a run does, idempotently:

1. Gate: typecheck, lint, unit tests, `deno check` of the functions.
2. **prepare**: finds the Supabase project named `detailflow` or creates it (`eu-central-1`, the account's first organization, or a new one), waits until it is healthy (restores a paused free project), sets a fresh `postgres` password for this run only (never stored), reads the API keys and the pooler host, finds or creates the Cloudflare Pages project, and keeps the generated application secrets in the project's **Vault** (`df_edge_password`, `df_manage_token_secret`, `df_dispatcher_secret`, `df_project_url`, `df_smoke_ice_owner_password`) so later runs reuse them. Every secret is registered with the Actions log masker before use (the repository is public).
3. Migrations through the session pooler (`scripts/db/migrate.ts`, same history table as the Supabase CLI).
4. **configure**: `df_edge` LOGIN + password, Auth settings (site URL, redirect allow-list, signup disabled, anonymous users disabled), Edge Function secrets (§1), pg_cron + pg_net dispatcher schedule (§5).
5. `supabase functions deploy` for the four functions (`--use-api`, shared import map from `supabase/config.toml`).
6. GRAPHITE and ICE LAB (demo) with their owners: GRAPHITE's password = `DF_OWNER_PASSWORD`, ICE LAB's = generated (Vault).
7. `pnpm build:prod` (https API enforced + bundle secret scan) and `wrangler pages deploy`.
8. Checks: `prod:verify-db`, production smoke incl. 360/390/768/1440 px and PWA (§10.2), client IP behind the platform (§10.4, `scripts/prod/client-ip-check.ts`), new-studio pipeline (`scripts/prod/tenant-pipeline-check.ts`), live Claude and Telegram checks when their secrets exist.
9. Smoke results are uploaded as the `production-smoke` artifact only after a scan proves no secret value is inside.

The run summary lists the public, owner and API URLs. §1–§10 below describe the same steps for running them by hand.

---

## 1. Environment variables

### Edge Function secrets (`supabase secrets set --env-file <file>`)

Keep the file outside git (`chmod 600`). `SUPABASE_URL`, `SUPABASE_DB_URL` and the API keys are injected by the platform — do not set them.

| Variable | Required | Purpose |
|---|---|---|
| `DF_DB_URL` | yes | Connection string of the least-privilege role `df_edge` via the **transaction pooler**: `postgres://df_edge.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` (§3.3) |
| `DF_MANAGE_TOKEN_SECRET` | yes | HMAC key for customer manage links, ≥ 32 chars (`openssl rand -base64 48`). Rotating it invalidates existing links |
| `DF_ALLOWED_ORIGINS` | yes | Exact origins allowed by CORS, comma-separated, `https://` only (e.g. `https://app.example.ru,https://detailflow.pages.dev`) |
| `DF_APP_URL` | yes | Public app URL used in Telegram links |
| `DF_DISPATCHER_SECRET` | yes | Shared secret between pg_cron and `notify-dispatcher` (≥ 32 chars) |
| `TELEGRAM_BOT_TOKEN` | for notifications | From @BotFather. Unset ⇒ notifications are recorded as `not_configured` |
| `ANTHROPIC_API_KEY` | for the assistant | Unset ⇒ assistant reports unavailable; booking is unaffected |
| `DF_AI_MODEL` | no | Default `claude-opus-5-5` |
| `DF_AI_EFFORT` | no | `low` (default) \| `medium` \| `high` |
| `DF_TRUSTED_PROXY_HOPS` | no | Proxies appending to `X-Forwarded-For` in front of the functions (default `1`). Verify with §9.4 |
| `DF_JWT_ISSUER` | no | Defaults to `<SUPABASE_URL>/auth/v1` |
| `DF_JWT_SECRET` | legacy only | Only for projects still on the legacy HS256 JWT secret. New projects use JWT signing keys (JWKS, default) |
| `DF_ALLOW_PRIVILEGED_DB_ROLE` | **never in production** | Escape hatch that lets functions run as `postgres`. The deploy script refuses it |

### Frontend build (Cloudflare Pages / CI)

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` — must be https (`pnpm build:prod` fails otherwise) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Publishable key (`sb_publishable_…`). Never a secret/service key: `pnpm security:scan-bundle` fails the build if one leaks |

### GitHub environment `production` (for `.github/workflows/deploy.yml`)

Secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `PROD_FUNCTION_SECRETS` (the whole secrets file above), `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PROD_DATABASE_URL` (read-only verification, §9.1), `PROD_GRAPHITE_OWNER_EMAIL/PASSWORD`, `PROD_ICE_OWNER_EMAIL/PASSWORD`.
Variables: `PROD_APP_URL`, `PROD_SMOKE_PHONE`, `CF_PAGES_PROJECT` (default `detailflow`).

---

## 2. Supabase project setup [once]

1. Create a project in the region closest to customers (for Russia: `eu-central-1`). Note the ref and the database password.
2. **Authentication → Sign In / Providers**: Email enabled; **disable "Allow new users to sign up"** (staff are invited only). Keep "Confirm email" on.
3. **Authentication → URL Configuration**: Site URL = `DF_APP_URL`; add `https://<app-domain>/s/*/owner/accept` to Redirect URLs.
4. **Authentication → JWT Keys**: use asymmetric signing keys (default for new projects). Functions verify tokens through `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`.
5. **Authentication → Sessions**: consider an access-token lifetime shorter than 1 h. Logout revokes refresh tokens; an already issued access token stays valid until it expires.
6. **Database → Extensions** are enabled by the migrations (`btree_gist`, `pgcrypto`); pg_cron and pg_net by §5.

## 3. Migrations and the Edge database role

### 3.1 Apply migrations

```bash
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations/*.sql in order
```
`scripts/prod/deploy-supabase.sh` does this as part of a deploy. The local runner (`scripts/db/migrate.ts`) writes the same `supabase_migrations.schema_migrations` table, so the history is compatible.

### 3.2 Why a dedicated role

Edge Functions talk to Postgres directly (not through PostgREST) and switch role per transaction, exactly as PostgREST does: `set_config('role', 'authenticated'|'service_role', true)` + `request.jwt.claims`. Connecting as `postgres` would make every query that forgets the role switch bypass RLS. Migration `20260930000005_edge_role.sql` creates `df_edge`: `NOINHERIT`, no `BYPASSRLS`, no privileges of its own, member of `authenticated` and `service_role`. A query without `SET ROLE` fails with *permission denied*. Functions refuse to start when connected as a superuser/bypassrls/inheriting role.

### 3.3 Enable `df_edge` [once]

Run `supabase/sql/enable-edge-role.sql` in the SQL editor with a freshly generated password, then set `DF_DB_URL` to the **transaction pooler** (port 6543; user `df_edge.<ref>`). The functions use `prepare: false`, so transaction pooling is safe; every statement runs inside a transaction with `SET LOCAL`, so nothing leaks between pooled clients.

> If `grant authenticated, service_role to df_edge` in migration 0005 is rejected on the hosted platform, the migration fails loudly. Do not work around it with `DF_ALLOW_PRIVILEGED_DB_ROLE`; open a Supabase support ticket. (NOT VERIFIED on a hosted project — see status.)

## 4. Edge Functions

```bash
PROD_SECRETS_FILE=./prod.secrets SUPABASE_ACCESS_TOKEN=… SUPABASE_PROJECT_REF=… SUPABASE_DB_PASSWORD=… \
  scripts/prod/deploy-supabase.sh
```
Deploys `public-api`, `owner-api`, `assistant`, `notify-dispatcher` (`verify_jwt = false` in `supabase/config.toml`: `public-api` and `assistant` are public by design, `owner-api` verifies the Supabase JWT itself, the dispatcher checks `x-dispatcher-secret`). Shared domain code is vendored into `supabase/functions/_vendor/` so the bundle never imports outside `supabase/functions`.

## 5. Notification dispatcher schedule [once]

Run `supabase/sql/schedule-dispatcher.sql` (placeholders: project URL, `DF_DISPATCHER_SECRET`). It stores both in Vault and schedules `notify-dispatcher` every minute via pg_cron + pg_net. Check: `select * from cron.job_run_details order by start_time desc limit 5;`.

## 6. Cloudflare Pages

```bash
VITE_SUPABASE_URL=https://<ref>.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_… pnpm build:prod
pnpm exec wrangler pages deploy apps/web/dist --project-name detailflow --branch main
```
- SPA fallback: automatic (no `404.html` at the root).
- `_headers` is generated at build (`apps/web/build/cloudflare-pages.ts`): CSP with `connect-src` limited to the Supabase origin, HSTS, `X-Frame-Options: DENY`, immutable hashed assets, `no-cache` for `sw.js`/workbox, short cache for per-studio manifests.
- Custom domain: Pages → Custom domains; then add it to `DF_ALLOWED_ORIGINS` and `DF_APP_URL` and redeploy the functions' secrets.
- Local check of the same runtime: `pnpm test:pages` (wrangler pages dev / workerd).

## 7. Telegram

1. Create a bot with @BotFather → `TELEGRAM_BOT_TOKEN` (function secret only; never in the frontend, logs or responses — error messages are scrubbed of the token).
2. Add the bot to the studio's group; get the chat id (e.g. send a message and read `getUpdates` once from a trusted machine).
3. Owner sets the chat id in **Кабинет → Настройки** (owner role only).
4. Live check from a trusted machine: `TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… pnpm prod:telegram-check`.
Events: `booking.created`, `booking.confirmed`, `booking.cancelled`, `booking.rescheduled`. A studio in **demo** status never sends: the dispatcher marks those rows `suppressed_demo` before any provider call.

## 8. Claude API

Set `ANTHROPIC_API_KEY` (and optionally `DF_AI_MODEL`, `DF_AI_EFFORT`) as function secrets. The assistant runs server-side only, uses the official TypeScript SDK, six allowlisted read-only tools, a tenant resolved from the URL, and a circuit breaker; per-studio switch `ai.enabled` in `business.json`. Live check: `PROD_SUPABASE_URL=https://<ref>.supabase.co pnpm prod:ai-smoke` (or `--local` with a key against a local stack).

## 9. First studio, owners, go-live

```bash
# config + assets in git
pnpm tenant new my-studio --name "My Studio" --tz Europe/Moscow --accent "#d6a84a"
pnpm tenant validate my-studio && pnpm tenant:icons my-studio
# seed into production (DATABASE_URL = postgres role, direct connection)
DATABASE_URL=… pnpm tenant:seed my-studio
# invite the owner through Supabase Auth: prints a single-use link to /s/my-studio/owner/accept
DATABASE_URL=… AUTH_URL=https://<ref>.supabase.co/auth/v1 SUPABASE_SERVICE_ROLE_KEY=… DF_APP_URL=https://app… \
  pnpm tenant invite-owner my-studio owner@studio.ru
# go live (refuses demo artwork, missing phone, missing owner)
DATABASE_URL=… pnpm tenant activate my-studio
```
Send the invite link over a trusted channel; it can be used once.

## 10. Production verification

### 10.1 Database invariants (read-only)
`PROD_DATABASE_URL=… pnpm prod:verify-db` → `docs/smoke/verify-db-production.json`.

### 10.2 Production smoke (browser)
```bash
PROD_APP_URL=https://app… PROD_SUPABASE_URL=https://<ref>.supabase.co PROD_SUPABASE_PUBLISHABLE_KEY=… \
PROD_GRAPHITE_OWNER_EMAIL=… PROD_GRAPHITE_OWNER_PASSWORD=… PROD_ICE_OWNER_EMAIL=… PROD_ICE_OWNER_PASSWORD=… \
  pnpm test:prod
```
- GRAPHITE: fresh browser → service → vehicle → free time → booking → manage link (no account) → customer reschedules → owner login → finds it → owner reschedules → status change → Telegram (expects *отправлено* when the studio is active, *не отправлено (демо)* when demo) → cancels its own booking and waits until every event (rescheduled, cancelled) has gone through the dispatcher.
- Widths 360, 390, 768, 1440 px: storefront, service, booking start, owner login and dashboard without horizontal scroll; owner dashboard on a phone.
- PWA: per-studio manifest/scope/icons, service worker controls the page, the studio opens offline, booking offline shows «Нет соединения» instead of stale slots.
- ICE LAB: different timezone/grid/catalog/closed days; GRAPHITE unreachable through ICE LAB's public API, UI and owner API.
Results: `docs/smoke/prod-e2e-production.json`. Missing credentials ⇒ tests are **skipped as NOT VERIFIED**, never passed.

### 10.3 Live integrations
`pnpm prod:telegram-check`, `pnpm prod:ai-smoke` → `docs/smoke/*.json`.

### 10.4 Client IP behind the platform
Rate limits key on the client IP taken from `X-Forwarded-For` at position `DF_TRUSTED_PROXY_HOPS` from the right. `scripts/prod/client-ip-check.ts` (run by the deploy workflow) sends one request with a forged `X-Forwarded-For` prefix and checks which hashed key in `private.rate_limit_buckets` was charged: the runner's public IP (correct), the forged value (client-controlled: lower the setting) or anything else (a proxy address shared by every customer: raise it).

### 10.5 Automated
`.github/workflows/deploy.yml` (manual dispatch) runs the gate tests, migrations, secrets, functions, `build:prod`, Pages deploy, `prod:verify-db`, `test:prod`, `prod:ai-smoke`, and uploads `docs/smoke/`.

## 11. Rollback

- Frontend: Pages → Deployments → roll back to the previous deployment.
- Functions: redeploy the previous git revision with `scripts/prod/deploy-supabase.sh`.
- Database: migrations are forward-only; write a compensating migration. Enable PITR on the production plan before go-live.
