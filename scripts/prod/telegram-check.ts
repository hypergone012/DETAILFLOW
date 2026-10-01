/**
 * Live Telegram check, tenant-scoped (no global chat id):
 *
 *   1. getMe: the platform bot token (TELEGRAM_BOT_TOKEN) is accepted by Telegram.
 *   2. GRAPHITE's destination comes from its own settings row (linked by the owner
 *      in Кабинет → Настройки). Not linked yet -> NOT VERIFIED (exit 2).
 *   3. GRAPHITE owner logs in and presses "test" through the deployed owner API:
 *      the function sends a real message to GRAPHITE's chat.
 *   4. A GRAPHITE booking (demo studio) goes through the dispatcher -> suppressed,
 *      zero Bot API calls.
 *   5. Real booking notifications: GRAPHITE is a demo studio and never sends them,
 *      so a throwaway *active* studio "telegram-check" borrows GRAPHITE's chat for
 *      the duration of the check: booking -> booking.created delivered, cancel ->
 *      booking.cancelled delivered (provider message ids recorded).
 *   6. ICE LAB booking -> its own destination (never GRAPHITE's chat), suppressed as demo.
 *   7. Cleanup: throwaway studio removed, GRAPHITE's chat restored, check bookings cancelled.
 *
 * Env: TELEGRAM_BOT_TOKEN, DATABASE_URL (postgres role), PROD_SUPABASE_URL,
 * PROD_SUPABASE_PUBLISHABLE_KEY, PROD_GRAPHITE_OWNER_EMAIL/PASSWORD, AUTH_URL
 * (optional), TELEGRAM_API_BASE (local rehearsal only), SMOKE_LABEL.
 * The token is never printed; every error is scrubbed of it.
 */
import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import type { Business } from '@detailflow/config'
import { TENANTS_DIR, loadTenant } from '../tenant/load.ts'
import { createTenantFromTemplate } from '../tenant/pipeline.ts'
import { seedTenant } from '../tenant/seed.ts'

const CHECK_SLUG = 'telegram-check'
const label = process.env.SMOKE_LABEL ?? 'production'
const token = process.env.TELEGRAM_BOT_TOKEN ?? ''
const telegramApi = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'
const api = process.env.PROD_SUPABASE_URL ?? ''
const apikey = process.env.PROD_SUPABASE_PUBLISHABLE_KEY ?? ''
const authUrl = process.env.AUTH_URL ?? `${api}/auth/v1`
const out = join(import.meta.dirname, '../../docs/smoke')
const steps: Array<{ step: string; ok: boolean; detail?: string }> = []
// Only api.telegram.org counts as live; a local contract server is a rehearsal.
const liveTelegram = telegramApi === 'https://api.telegram.org'
const scrub = (s: string) => (token ? s.split(token).join('<redacted>') : s).replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>')

function save(verified: boolean | 'not_verified', reason?: string): void {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `telegram-check-${label}.json`), scrub(JSON.stringify({ label, at: new Date().toISOString(), telegram: liveTelegram ? 'api.telegram.org (live)' : 'local Bot API contract server (rehearsal, not live)', verified: liveTelegram ? verified : verified === true ? 'rehearsal_passed' : verified, ...(reason ? { reason } : {}), steps }, null, 2)) + '\n')
}
function record(step: string, ok: boolean, detail?: string): void {
  steps.push({ step, ok, ...(detail ? { detail: scrub(detail) } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${scrub(detail)})` : ''}`)
  if (!ok) throw new Error(step)
}
function notVerified(reason: string): never {
  console.log(`NOT VERIFIED: ${reason}`)
  save('not_verified', reason)
  process.exit(2)
}

const headers = { apikey, 'content-type': 'application/json' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const [k, v] of Object.entries({ TELEGRAM_BOT_TOKEN: token, PROD_SUPABASE_URL: api, DATABASE_URL: process.env.DATABASE_URL, PROD_GRAPHITE_OWNER_PASSWORD: process.env.PROD_GRAPHITE_OWNER_PASSWORD })) {
  if (!v) notVerified(`${k} is not set`)
}

const sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} })

async function bookPublic(slug: string, dayOffset: number): Promise<{ id: string; ref: string; manage: string }> {
  const store = (await (await fetch(`${api}/functions/v1/public-api/storefront/${slug}`, { headers })).json()) as { services: Array<{ id: string }> }
  const svc = store.services[0]!.id
  const from = new Date(Date.now() + dayOffset * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(Date.now() + (dayOffset + 14) * 86_400_000).toISOString().slice(0, 10)
  const av = (await (await fetch(`${api}/functions/v1/public-api/availability/${slug}`, { method: 'POST', headers, body: JSON.stringify({ serviceId: svc, vehicleClass: 'sedan', from, to }) })).json()) as { days: Array<{ slots: Array<{ startAt: string }> }> }
  const slot = av.days.flatMap((d) => d.slots).find((s) => Date.parse(s.startAt) > Date.now() + 26 * 3_600_000)
  if (!slot) throw new Error(`${slug}: no free slot`)
  const res = await fetch(`${api}/functions/v1/public-api/bookings/${slug}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      serviceId: svc, startAt: slot.startAt, comment: 'Проверка уведомлений DETAILFLOW', idempotencyKey: randomUUID(),
      vehicle: { make: 'Проверка', model: 'Telegram', year: 2020, color: 'Серый', vehicleClass: 'sedan', plate: '', notes: '' },
      customer: { name: 'ПРОВЕРКА УВЕДОМЛЕНИЙ', phone: `+7999${String(Date.now()).slice(-7)}`, email: null, consent: true },
    }),
  })
  const body = (await res.json()) as { refCode?: string; manageToken?: string; error?: { code: string } }
  if (res.status !== 201) throw new Error(`${slug}: booking ${res.status} ${body.error?.code ?? ''}`)
  const [b] = await sql<{ id: string }[]>`select id from public.bookings where ref_code = ${body.refCode!}`
  return { id: b!.id, ref: body.refCode!, manage: body.manageToken! }
}

/** Removes the throwaway studio with its check bookings (composite FKs do not cascade on purpose). */
async function removeCheckStudio(): Promise<void> {
  await sql.begin(async (tx) => {
    const [t] = await tx<{ id: string }[]>`select id from public.tenants where slug = ${CHECK_SLUG}`
    if (!t) return
    for (const table of ['notification_outbox', 'booking_events', 'resource_allocations', 'bookings', 'vehicles', 'customers']) {
      await tx.unsafe(`delete from public.${table} where tenant_id = $1`, [t.id])
    }
    await tx`delete from public.tenants where id = ${t.id}`
  })
}

const cancelPublic = (slug: string, manage: string) =>
  fetch(`${api}/functions/v1/public-api/manage/${slug}/${manage}/cancel`, { method: 'POST', headers, body: JSON.stringify({ reason: 'проверка уведомлений' }) })

/** Waits for the scheduled dispatcher (pg_cron, every minute) to process the row. */
async function outcome(bookingId: string, event: string): Promise<{ status: string; provider_message_id: string | null; last_error: string | null }> {
  for (let i = 0; i < 40; i++) {
    const [r] = await sql<{ status: string; provider_message_id: string | null; last_error: string | null }[]>`
      select status, provider_message_id, last_error from public.notification_outbox where booking_id = ${bookingId} and event = ${event}`
    if (r && r.status !== 'pending') return r
    await sleep(5_000)
  }
  throw new Error(`${event}: still pending after 200 s (is the dispatcher schedule running?)`)
}

const dir = mkdtempSync(join(tmpdir(), 'df-tg-'))
let graphiteChat: string | null = null
let graphiteEnabled = false
let graphiteId = ''
const cancelLater: Array<[string, string]> = []
try {
  const me = (await (await fetch(`${telegramApi}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) })).json()) as { ok: boolean; result?: { username: string } }
  record('platform bot token accepted by Telegram (getMe)', me.ok, me.ok ? `@${me.result?.username}` : 'token rejected')

  const [g] = await sql<{ id: string; telegram_enabled: boolean; telegram_chat_id: string | null }[]>`
    select t.id, n.telegram_enabled, n.telegram_chat_id from public.tenants t
    join public.tenant_notification_settings n on n.tenant_id = t.id where t.slug = 'graphite'`
  if (!g?.telegram_chat_id) notVerified('GRAPHITE has no Telegram chat linked yet (Кабинет → Настройки → Telegram)')
  graphiteId = g.id
  graphiteChat = g.telegram_chat_id
  graphiteEnabled = g.telegram_enabled
  record('GRAPHITE destination read from its own settings row', true, `chat ••••${graphiteChat.slice(-4)}`)

  const login = await fetch(`${authUrl}/token?grant_type=password`, {
    method: 'POST', headers,
    body: JSON.stringify({ email: process.env.PROD_GRAPHITE_OWNER_EMAIL, password: process.env.PROD_GRAPHITE_OWNER_PASSWORD }),
  })
  const accessToken = ((await login.json()) as { access_token?: string }).access_token
  record('GRAPHITE owner logs in', login.ok && !!accessToken)
  const test = await fetch(`${api}/functions/v1/owner-api/graphite/settings/telegram/test`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${accessToken}` }, body: '{}' })
  const testBody = await test.text()
  record('test notification delivered to GRAPHITE chat (server-side, Bot API)', test.status === 200, test.status === 200 ? undefined : testBody)

  const demo = await bookPublic('graphite', 2)
  cancelLater.push(['graphite', demo.manage])
  const demoOut = await outcome(demo.id, 'booking.created')
  record('GRAPHITE (demo) booking: suppressed, no Bot API call', demoOut.status === 'suppressed_demo' && !demoOut.provider_message_id, demoOut.status)

  // Throwaway active studio borrowing GRAPHITE's chat (one chat belongs to one studio at a time).
  await removeCheckStudio()
  cpSync(join(TENANTS_DIR, '_template'), join(dir, '_template'), { recursive: true })
  createTenantFromTemplate({ slug: CHECK_SLUG, name: 'DETAILFLOW проверка уведомлений', timezone: 'Europe/Moscow', dir })
  const path = join(dir, CHECK_SLUG, 'business.json')
  const b = JSON.parse(readFileSync(path, 'utf8')) as Business
  b.branding.demoArtwork = false
  b.contacts.phone ??= '+74950000000'
  writeFileSync(path, JSON.stringify(b, null, 2) + '\n')
  // No owner account: the studio exists only for this check (the go-live gate itself is checked by tenant-pipeline-check).
  const checkId = await seedTenant(sql, loadTenant(CHECK_SLUG, dir).business!, 'active')
  record('throwaway active studio created', true)
  await sql.begin(async (tx) => {
    await tx`update public.tenant_notification_settings set telegram_enabled = false, telegram_chat_id = null where tenant_id = ${graphiteId}`
    await tx`update public.tenant_notification_settings set telegram_enabled = true, telegram_chat_id = ${graphiteChat} where tenant_id = ${checkId}`
  })

  const checkBooking = await bookPublic(CHECK_SLUG, 1)
  const created = await outcome(checkBooking.id, 'booking.created')
  record('booking.created delivered by the dispatcher (Bot API)', created.status === 'sent' && !!created.provider_message_id, created.status === 'sent' ? `message ${created.provider_message_id}` : created.last_error ?? created.status)
  record('cancel through the customer manage link', (await cancelPublic(CHECK_SLUG, checkBooking.manage)).status === 200)
  const cancelled = await outcome(checkBooking.id, 'booking.cancelled')
  record('booking.cancelled delivered by the dispatcher (Bot API)', cancelled.status === 'sent' && !!cancelled.provider_message_id, cancelled.status === 'sent' ? `message ${cancelled.provider_message_id}` : cancelled.last_error ?? cancelled.status)

  const ice = await bookPublic('ice-lab', 2)
  cancelLater.push(['ice-lab', ice.manage])
  const iceOut = await outcome(ice.id, 'booking.created')
  const [iceDest] = await sql<{ telegram_chat_id: string | null }[]>`
    select n.telegram_chat_id from public.tenant_notification_settings n join public.tenants t on t.id = n.tenant_id where t.slug = 'ice-lab'`
  record('ICE LAB booking never goes to GRAPHITE’s chat', iceDest?.telegram_chat_id !== graphiteChat && iceOut.status !== 'sent', `ice-lab: ${iceOut.status}`)
  save(true)
  console.log(liveTelegram ? 'VERIFIED: tenant-scoped Telegram delivery via api.telegram.org' : 'REHEARSAL PASSED against a local Bot API contract server (not a live check)')
} catch (err) {
  const msg = scrub(err instanceof Error ? err.message : String(err))
  if (!steps.some((s) => !s.ok)) steps.push({ step: 'unexpected error', ok: false, detail: msg })
  save(false, msg)
  console.log(`FAILED: ${msg}`)
  process.exitCode = 1
} finally {
  for (const [slug, manage] of cancelLater) await cancelPublic(slug, manage).catch(() => {})
  await removeCheckStudio().catch((err: unknown) => console.error('cleanup: throwaway studio not removed', scrub(String(err))))
  if (graphiteId && graphiteChat) {
    await sql`update public.tenant_notification_settings set telegram_chat_id = ${graphiteChat}, telegram_enabled = ${graphiteEnabled} where tenant_id = ${graphiteId}`
  }
  await sql.end()
  rmSync(dir, { recursive: true, force: true })
}
