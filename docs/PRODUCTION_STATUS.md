# Production status

Date: 2026-10-01. Branch: `claude/sleepy-dijkstra-kuo7qx`.

## Summary

**Production is deployed and verified end to end** by [Deploy production run 36812058239](https://github.com/hypergone012/DETAILFLOW/actions/runs/36812058239) (commit `d2b2521`, 2026-10-01 03:46–03:57 UTC, every step green).

| | |
|---|---|
| Public app (GRAPHITE) | https://detailflow.pages.dev/s/graphite/ |
| Owner dashboard (GRAPHITE) | https://detailflow.pages.dev/s/graphite/owner/ |
| Second studio (ICE LAB) | https://detailflow.pages.dev/s/ice-lab/ |
| API | `https://kqzbtcrempmgpwtwrlgg.supabase.co` (Supabase, eu-west-1) |
| Frontend | Cloudflare Pages project `detailflow` |

The deploy runs on GitHub Actions (`.github/workflows/deploy.yml`); this development environment itself cannot reach Supabase, Cloudflare or Telegram (network policy), so every production check below was executed by the workflow against the real services. Smoke results are uploaded as the `production-smoke` artifact of each run (only after a scan proved no secret value is inside).

## Status by area

| # | Area | Status | Evidence (run 36812058239 unless noted) |
|---|---|---|---|
| 1 | Supabase project | **VERIFIED** | project `kqzbtcrempmgpwtwrlgg` found and healthy; API keys and pooler read through the Management API |
| 2 | Migrations | **VERIFIED** | 6 migrations applied on hosted Postgres; first hosted run found that `ALTER ROLE … NOSUPERUSER NOBYPASSRLS` is rejected by Supabase (supautils) — fixed in `ce68b26` |
| 3 | Auth | **VERIFIED** | signup disabled, anonymous users disabled, site URL / redirect allow-list set; GRAPHITE and ICE LAB owners log in; invite link → accept → password → login and single-use link checked by the pipeline check |
| 4 | Edge Functions | **VERIFIED** | four functions deployed; run under the least-privilege `df_edge` role through the transaction pooler |
| 5 | RLS / grants / invariants | **VERIFIED** | `prod:verify-db` PASS on the hosted DB (anon no grants, RLS on every table, `df_edge` without own rights, `private.*` closed, pinned search_path, composite FKs, exclusion constraint, idempotency key, tenant_id immutability, one Telegram chat per studio, no token column) |
| 6 | Frontend on Cloudflare Pages | **VERIFIED** | `https://detailflow.pages.dev` serves the production build (https API enforced, bundle secret scan clean) |
| 7 | Telegram (tenant-scoped) | **VERIFIED** via `api.telegram.org` | `prod:telegram-check`: bot `@detailingstudio_app_bot` accepted (getMe); GRAPHITE chat read from GRAPHITE's own settings row; server-side test message delivered to it; GRAPHITE (demo) booking suppressed with no Bot API call; booking.created (message 23) and booking.cancelled (message 24) delivered by the scheduled dispatcher to that chat through a throwaway active studio; ICE LAB booking never reached GRAPHITE's chat. Same result in runs 36808803417, 36809984690, 36810989552 |
| 8 | Claude API | **NOT VERIFIED** | no `ANTHROPIC_API_KEY` secret; the assistant reports unavailable and booking works without it (fail-soft, tested) |
| 9 | Production browser smoke | **VERIFIED 10/10** | GRAPHITE: fresh browser → booking → manage link → customer reschedule → owner login → owner finds it → owner reschedule → status change → every notification processed (`не отправлено (демо)`) → cancel; ICE LAB: own timezone/schedule/catalog, GRAPHITE unreachable via ICE LAB API/UI/owner API; 360/390/768/1440 px without horizontal scroll; owner dashboard on a phone; PWA manifest/scope/icons, service worker, offline studio shell, booking offline shows «Нет соединения» |
| 10 | New studio pipeline | **VERIFIED 14/14** | new → validate → seed (draft not public) → invite → accept + password → link not reusable → login → owner API sees only this studio → other studio 404 → activate refused on template artwork → activate → public storefront → app page served → cleanup |
| 11 | Client IP behind Supabase | **VERIFIED** (auto-tuned) | with the default (`DF_TRUSTED_PROXY_HOPS=1`) rate limits keyed on a proxy address shared by all customers (run 36808803417); `client-ip-check --tune` now selects the configuration that keys on the caller's real IP and ignores forged `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`; PASS in the last three runs |
| 12 | Notification dispatcher schedule | **VERIFIED** | pg_cron → pg_net → `notify-dispatcher` answers 200 after deploy (`dispatcher-check`) |
| 13 | Custom domain | not configured | the app runs on `detailflow.pages.dev` |

Local regression (this environment, real Postgres 16 + Supabase Auth + Deno + Pages runtime): 73 unit, 152 DB/API, 19 E2E, 5 Pages-runtime tests, bundle scan clean.

## Findings fixed during hardening

| Finding | Severity | Fix |
|---|---|---|
| Functions connected as `postgres`: any query outside the role switch would bypass RLS | high | least-privilege `df_edge` (NOINHERIT, no own rights); functions refuse privileged roles; all handler tests run as `df_edge` |
| Telegram bot token leaked into `notification_outbox.last_error` (visible to owners) and logs via Deno fetch error messages that contain the URL | high | token scrubbed from every provider error; unit tests |
| Rate-limit IP taken from `cf-connecting-ip` / `x-real-ip`, which a client can set when the platform is not behind Cloudflare | medium | only X-Forwarded-For at a configured trusted-hop position |
| Body size checked only via `Content-Length` (chunked bodies unbounded) | medium | cap on bytes read |
| JWT: no issuer check, anonymous Supabase users accepted as `authenticated` | medium | issuer enforced, `is_anonymous` rejected, algorithms pinned for JWKS |
| Unhandled-error logs included Postgres messages (may contain row values) | medium | logs carry name/code/constraint only |
| Production CSP would block Vite-inlined font subsets (broken glyphs) | medium | fonts are never inlined |
| Duplicate `Cache-Control` on manifests from overlapping `_headers` rules | low | rules narrowed |
| Dispatcher secret compared with `!==` | low | constant-time comparison |
| CORS accepted a `*` entry | low | exact-match allowlist only; non-https origins dropped except localhost |
| `DF_MANAGE_TOKEN_SECRET` length unchecked | low | ≥ 32 chars or the function does not start |
| Auth admin calls sent new `sb_secret_` keys as a Bearer JWT | low | `apikey` only for new secret keys |
| `.wrangler/` emulator state committed | hygiene | untracked, ignored |
| CI e2e failed on every GitHub run: the function gateway starts before Playwright's globalSetup and refused to start without `df_edge` (and a seeded studio) on a fresh runner | CI | DB prepared before Playwright; CI #17 green |
| `pnpm tenant:seed <slug> …` without `--status` silently skipped the first slug | medium | argument parsing fixed; production seeding uses it |
| Telegram chat id had no uniqueness: one studio could set another studio's chat and receive or send into it | high | `tenant_notification_settings` with a unique chat id, owner-only RPC, manager+ read RLS |
| Trigger function `private.create_notification_settings` was executable by PUBLIC (found by the grants audit test) | low | revoked |
| Hosted Supabase rejects `ALTER ROLE … NOSUPERUSER NOBYPASSRLS` from `postgres` (first hosted deploy) | deploy blocker | migration names only NOINHERIT; runtime + verify-db still enforce the attributes |
| Rate limits keyed on a Supabase proxy address (first hosted deploy) | high | client IP source auto-tuned and verified against forged headers |
| Production smoke waited 2 s per reload, shorter than a real page load | test | 15 s per attempt; diagnostics print the booking's notification state on failure |

## Security checklist

| Item | Status |
|---|---|
| CORS | exact allowlist; tested (allowed origin echoed, foreign origin not) |
| Rate limiting | per IP (trusted hops), per phone, per assistant session, per studio; tested (429). IP correctness behind Supabase's proxies **NOT VERIFIED** (runbook §10.4) |
| Input validation | strict zod on every body (unknown keys → 400), byte cap, phone normalisation |
| Secret exposure | bundle scan in CI; secrets only in function env; Telegram token scrubbed; no secret in responses/logs |
| JWT | signature, audience, issuer, expiry, role, non-anonymous |
| RLS | enabled on every table, anon has zero grants, mutations only via checked RPCs, `df_edge` without own rights |
| Tenant enumeration | owner API returns 404 for foreign studios and ids; draft studios 404 publicly; manage tokens 256-bit HMAC, rate-limited |
| Booking token entropy | 32 bytes HMAC-SHA256, only SHA-256 stored |
| Error leakage | generic `INTERNAL` to clients; DB error codes mapped to fixed messages |
| Logs | no bodies, no PII-bearing messages, token redaction |
| Forwarded headers | client IP from the source chosen and verified by `client-ip-check --tune` on the hosted platform (XFF hop or a platform-set header); forged XFF / X-Real-IP / CF-Connecting-IP values are rejected by that check |
| Frontend headers | CSP (script-src 'self'), HSTS, frame-ancestors none, nosniff, referrer policy, HTTPS-only API enforced at build |

## Still NOT VERIFIED

1. Claude API live calls (no `ANTHROPIC_API_KEY`).
2. Custom domain and its certificate (none configured).
3. Real studio photos and a live (non-demo) studio: GRAPHITE and ICE LAB are demo studios by design (booking notifications are never sent for them).

## Operating

- Re-deploy: GitHub → Actions → **Deploy production** → Run workflow (the GRAPHITE chat id input can stay empty once linked).
- A new studio: `docs/PRODUCTION.md` §9; its owner links the studio's own Telegram chat in Кабинет → Настройки → Telegram.
