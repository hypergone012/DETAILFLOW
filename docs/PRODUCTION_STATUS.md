# Production status

Date: 2026-10-01. Branch: `claude/sleepy-dijkstra-kuo7qx`.

## Summary

**No production deployment exists yet.** The execution environment used for this work has no production credentials and its network policy blocks every production host except the Anthropic API:

| Host | Result from this environment |
|---|---|
| `api.supabase.com`, `*.supabase.co`, `supabase.com` | blocked (proxy 403 on CONNECT) |
| `api.telegram.org` | blocked (proxy 403) |
| `api.cloudflare.com`, `*.pages.dev` | blocked (proxy 403) |
| `api.anthropic.com` | reachable, but no `ANTHROPIC_API_KEY` provided |

Credentials present: none (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` all unset).

**GitHub Actions path (2026-10-01).** The production workflow now provisions everything from three repository secrets (`docs/PRODUCTION.md` §0). Its first run, [Deploy production #1](https://github.com/hypergone012/DETAILFLOW/actions/runs/36796760080), stopped at the first step because the repository has none of them (`SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `DF_OWNER_PASSWORD`). Nothing was deployed. CI on GitHub is green for the first time ([CI #17](https://github.com/hypergone012/DETAILFLOW/actions/runs/36796755748)); every earlier run had failed in the e2e job (fixed, see below).

Everything that can be proven without them was run against real components locally (PostgreSQL 16, Supabase Auth built from source, Edge Functions on Deno, the Cloudflare Pages runtime via wrangler/workerd, Chromium). Production steps are scripted and wired to fail or report **NOT VERIFIED** — never to simulate success.

## Status by area

| # | Area | Status | Evidence |
|---|---|---|---|
| 1 | Production Supabase project | **NOT VERIFIED** — not created from here | runbook §2 |
| 2 | Production migrations | **NOT VERIFIED** on hosted; clean-apply verified locally | `scripts/db/migrate.ts` on a fresh DB each test run; `pnpm prod:verify-db` PASS locally (`docs/smoke/verify-db-local-rehearsal.json`) |
| 3 | Production Auth | **NOT VERIFIED** on hosted; verified with Supabase Auth (GoTrue) built from source | E2E: invite → password → dashboard; login; logout revokes refresh token; signup disabled; API tests: expired / wrong issuer / anonymous / service_role / `alg: none` / tampered tokens → 401; wrong tenant → 404 |
| 4 | Production Edge Functions | **NOT VERIFIED** deployed; handlers verified on Deno and under the production DB role | 131 DB/API tests run the handlers as `df_edge`; `deno check` of all entrypoints |
| 5 | Production RLS | **NOT VERIFIED** on hosted; verified locally + read-only verifier ready | `tests/db/security.test.ts`, `isolation.test.ts`; `pnpm prod:verify-db` |
| 6 | Production frontend | **NOT VERIFIED** on Cloudflare; production build verified on the Pages runtime locally | `pnpm test:pages` 5/5: SPA fallback, headers/CSP, no CSP violations or third-party requests through booking + owner login, SW + offline, per-studio manifests |
| 7 | Telegram | **NOT VERIFIED** live | provider + dispatcher tested against a local Bot API contract server (created/cancelled delivered, demo sends nothing); `pnpm prod:telegram-check` → `docs/smoke/telegram-check.json` = NOT VERIFIED (no token, host blocked) |
| 8 | Claude API | **NOT VERIFIED** live | tool loop verified with a scripted model and real tools/DB; `pnpm prod:ai-smoke` → NOT VERIFIED (no key) |
| 9 | Cloudflare deployment | **NOT VERIFIED** | `wrangler pages deploy` wired in `deploy.yml`; API blocked, no token |
| 10 | Production smoke | **NOT VERIFIED** on production; **rehearsed 10/10** on the production build + Pages runtime + local backend | `docs/smoke/prod-e2e-local-rehearsal.json`: GRAPHITE booking → manage link → customer reschedule → owner login → owner reschedule → status → notifications → cancel; ICE LAB timezone/schedule/catalog/isolation; 360/390/768/1440 px; PWA (manifest, SW, offline shell, booking needs network). Live-Telegram branch rehearsed earlier: `docs/smoke/prod-e2e-local-rehearsal-live-branch.json` |
| 11 | New studio pipeline | **NOT VERIFIED** on production; **13/13 steps** locally | `docs/smoke/tenant-pipeline-local-rehearsal.json`: new → validate → seed (draft = 404) → invite → accept + password → single-use link → login → owner API sees only this studio → activate refused on demo artwork → activate → public → cleanup |
| 12 | Client IP behind the platform | **NOT VERIFIED** (needs the hosted gateway) | `scripts/prod/client-ip-check.ts`; locally it correctly reports a forged `X-Forwarded-For` as client-controlled (no proxy in front of the local gateway) |

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
| Forwarded headers | only XFF at the configured hop |
| Frontend headers | CSP (script-src 'self'), HSTS, frame-ancestors none, nosniff, referrer policy, HTTPS-only API enforced at build |

## Still NOT VERIFIED (needs credentials / network access)

1. Creating the Supabase project and `supabase db push` on a hosted **Postgres 15/17** (local verification used Postgres 16).
2. That the hosted `postgres` role may `grant authenticated, service_role to df_edge` (migration 0005) and that Supavisor accepts `df_edge.<ref>` logins.
3. Supabase CLI bundling of the functions with the vendored domain code and `npm:` imports.
4. JWKS verification with the project's asymmetric signing keys, and the exact `iss` value of hosted tokens.
5. Auth admin API (invite links) with new `sb_secret_` keys.
6. pg_cron + pg_net + Vault schedule of the dispatcher.
7. Real Telegram delivery (`api.telegram.org`), including error descriptions of the live Bot API.
8. Real Claude API calls (tool use with `claude-opus-5-5`, refusal fallback beta).
9. Cloudflare Pages deploy, custom domain, HTTPS certificate, real edge caching.
10. Client-IP position in `X-Forwarded-For` behind Supabase's gateway (`DF_TRUSTED_PROXY_HOPS`).
11. Production smoke (`pnpm test:prod`) and `pnpm prod:verify-db` against the real project.
12. The CI workflows themselves on GitHub Actions (never executed from here).

## To finish go-live

1. Add the repository secrets `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `DF_OWNER_PASSWORD` (optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`) — `docs/PRODUCTION.md` §0.
2. Run **Deploy production**. It creates or reuses the projects and verifies everything listed above against the real services.
3. Replace this file's statuses with the run's recorded results (`production-smoke` artifact).
