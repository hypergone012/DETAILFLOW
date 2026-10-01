import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDispatcher } from '../../supabase/functions/notify-dispatcher/handler.ts'
import { createOwnerApi } from '../../supabase/functions/owner-api/handler.ts'
import { createPublicApi } from '../../supabase/functions/public-api/handler.ts'
import { MAX_ATTEMPTS, TelegramProvider, dispatchOutbox } from '../../supabase/functions/_shared/notifications.ts'
import { addMinutes, book, createTenant, hoursFromNow } from '../db/fixtures.ts'
import { asUser, connect, edgeConnect, errorOf, type Sql } from '../db/harness.ts'
import { CORS, JWT_ISSUER, JWT_SECRET, TOKEN_SECRET, accessToken, bookingBody, call, seedDemo } from './helpers.ts'

/**
 * Tenant-scoped Telegram: every studio has its own destination chat; the bot
 * token is one platform secret. A local server implements the Bot API
 * contract (sendMessage, getMe) so the real TelegramProvider HTTP path runs;
 * it stands in for api.telegram.org only.
 */
interface Received { token: string; method: string; chat_id: string; text: string }
let server: Server
let apiBase: string
let received: Received[] = []
let respond: (r: Received) => { status: number; body: unknown }

// Shaped like a real token: digits, colon, 35 url-safe chars.
const BOT_TOKEN = '7012345678:AAH_secret-token-value-ABCDEFGHIJKLMNO'
const GRAPHITE_CHAT = '-1001111111111'
const ICE_CHAT = '-1002222222222'

let sql: Sql
let edge: Sql
let ids: Awaited<ReturnType<typeof seedDemo>>
let graphiteToken: string
let iceToken: string
let pub: (req: Request) => Promise<Response>
let owner: (req: Request) => Promise<Response>
const logs: string[] = []
const log = (msg: string, extra?: Record<string, unknown>) => logs.push(JSON.stringify({ msg, ...extra }))

const provider = (base = apiBase) => new TelegramProvider(BOT_TOKEN, base)
const dispatch = (p: TelegramProvider | null = provider()) => dispatchOutbox(edge, { provider: p, appUrl: 'https://app.example' })

type Slot = { startAt: string }
async function bookVia(slug: string, serviceSlug: string, slotIndex = 0) {
  const store = await call(pub, 'GET', `/public-api/storefront/${slug}`)
  const svc = store.body.services.find((s: { slug: string }) => s.slug === serviceSlug).id as string
  const from = new Date().toISOString().slice(0, 10)
  const to = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10)
  const av = await call(pub, 'POST', `/public-api/availability/${slug}`, { body: { serviceId: svc, vehicleClass: 'sedan', from, to } })
  const slots: Slot[] = av.body.days.flatMap((d: { slots: Slot[] }) => d.slots).filter((s: Slot) => Date.parse(s.startAt) > Date.now() + 30 * 3_600_000)
  const r = await call(pub, 'POST', `/public-api/bookings/${slug}`, { body: bookingBody(svc, slots[slotIndex]!.startAt) })
  expect(r.status).toBe(201)
  const [b] = await sql<{ id: string }[]>`select id from public.bookings where ref_code = ${r.body.refCode}`
  return { id: b!.id, ref: r.body.refCode as string, token: r.body.manageToken as string }
}

const outbox = (bookingId: string) => sql<{ event: string; status: string; attempts: number; last_error: string | null }[]>`
  select event, status, attempts, last_error from public.notification_outbox where booking_id = ${bookingId} order by created_at`

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const m = /\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
      const body = JSON.parse(raw || '{}') as { chat_id?: string; text?: string }
      const r = { token: m?.[1] ?? '', method: m?.[2] ?? '', chat_id: String(body.chat_id ?? ''), text: body.text ?? '' }
      if (r.method === 'getMe') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { id: 7012345678, is_bot: true, username: 'detailflow_test_bot' } }))
        return
      }
      received.push(r)
      const out = respond(r)
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  sql = connect(10)
  edge = edgeConnect()
  ids = await seedDemo(sql)
  // Launched studios for delivery tests (restored to demo afterwards).
  await sql`update public.tenants set status = 'active' where id in (${ids.graphite}, ${ids.iceLab})`
  await sql`update public.tenant_notification_settings set telegram_enabled = false, telegram_chat_id = null`
  graphiteToken = await accessToken(ids.graphiteOwner)
  iceToken = await accessToken(ids.iceOwner)
  pub = createPublicApi({ sql: edge, cors: CORS, manageTokenSecret: TOKEN_SECRET, log })
  owner = createOwnerApi({ sql: edge, cors: CORS, auth: { jwtSecret: JWT_SECRET, issuer: JWT_ISSUER }, telegram: provider(), log })
  // Each owner links their own studio's chat through the API.
  expect((await call(owner, 'POST', '/owner-api/graphite/settings/telegram', { token: graphiteToken, body: { enabled: true, chatId: GRAPHITE_CHAT } })).status).toBe(200)
  expect((await call(owner, 'POST', '/owner-api/ice-lab/settings/telegram', { token: iceToken, body: { enabled: true, chatId: ICE_CHAT } })).status).toBe(200)
  await sql`update public.notification_outbox set status = 'not_configured' where status = 'pending'`
})
afterAll(async () => {
  await sql`update public.tenants set status = 'demo' where id in (${ids.graphite}, ${ids.iceLab})`
  await edge.end()
  await sql.end()
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  received = []
  respond = () => ({ status: 200, body: { ok: true, result: { message_id: 4242 } } })
})

describe('each studio notifies its own chat', () => {
  it('TEST 1: GRAPHITE booking -> GRAPHITE chat only', async () => {
    const b = await bookVia('graphite', 'detailing-wash')
    await dispatch()
    const mine = received.filter((r) => r.text.includes(b.ref))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ method: 'sendMessage', chat_id: GRAPHITE_CHAT })
    expect(received.some((r) => r.chat_id === ICE_CHAT)).toBe(false)
    expect((await outbox(b.id))[0]).toMatchObject({ status: 'sent' })
  })

  it('TEST 2: ICE LAB booking -> ICE LAB chat only, then cancellation -> ICE LAB chat', async () => {
    const b = await bookVia('ice-lab', 'express-detail')
    await dispatch()
    expect(received.map((r) => r.chat_id)).toEqual([ICE_CHAT])
    expect(received[0]!.text).toContain(b.ref)
    expect(received[0]!.text).toContain('/s/ice-lab/owner/bookings/')
    received = []
    expect((await call(pub, 'POST', `/public-api/manage/ice-lab/${b.token}/cancel`, { body: { reason: 'test' } })).status).toBe(200)
    await dispatch()
    expect(received.map((r) => r.chat_id)).toEqual([ICE_CHAT])
    expect(received[0]!.text).toContain('Запись отменена')
  })

  it('a booking of one studio never reaches the other studio’s chat, even if both are dispatched together', async () => {
    const g = await bookVia('graphite', 'detailing-wash', 1)
    const i = await bookVia('ice-lab', 'express-detail', 1)
    await Promise.all([dispatch(), dispatch()])
    expect(received.filter((r) => r.text.includes(g.ref)).map((r) => r.chat_id)).toEqual([GRAPHITE_CHAT])
    expect(received.filter((r) => r.text.includes(i.ref)).map((r) => r.chat_id)).toEqual([ICE_CHAT])
  })
})

describe('destination cannot be redirected to another studio', () => {
  it('TEST 3: GRAPHITE cannot take ICE LAB’s chat (owner API, RPC, and the table itself)', async () => {
    const r = await call(owner, 'POST', '/owner-api/graphite/settings/telegram', { token: graphiteToken, body: { enabled: true, chatId: ICE_CHAT } })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('TELEGRAM_CHAT_TAKEN')
    expect(await errorOf(asUser(sql, ids.graphiteOwner, (tx) => tx`select public.owner_set_telegram(${ids.graphite}, true, ${ICE_CHAT})`))).toBe('TELEGRAM_CHAT_TAKEN')
    // Even a privileged write cannot give one chat to two studios.
    expect(await errorOf(sql`update public.tenant_notification_settings set telegram_chat_id = ${ICE_CHAT} where tenant_id = ${ids.graphite}`)).toMatch(/duplicate key|unique/)
    const [g] = await sql`select telegram_chat_id from public.tenant_notification_settings where tenant_id = ${ids.graphite}`
    expect(g!.telegram_chat_id).toBe(GRAPHITE_CHAT)
  })

  it('TEST 3: a booking request cannot carry a destination (strict body)', async () => {
    const store = await call(pub, 'GET', '/public-api/storefront/graphite')
    const svc = store.body.services[0].id
    const body = { ...bookingBody(svc, new Date(Date.now() + 40 * 3_600_000).toISOString()), telegramChatId: ICE_CHAT }
    const r = await call(pub, 'POST', '/public-api/bookings/graphite', { body })
    expect(r.status).toBe(400)
  })

  it('TEST 4: GRAPHITE owner cannot read or change ICE LAB’s Telegram settings', async () => {
    const api = await call(owner, 'POST', '/owner-api/ice-lab/settings/telegram', { token: graphiteToken, body: { enabled: false, chatId: null } })
    expect(api.status).toBe(404)
    expect((await call(owner, 'POST', '/owner-api/ice-lab/settings/telegram/test', { token: graphiteToken, body: {} })).status).toBe(404)
    expect((await call(owner, 'GET', '/owner-api/ice-lab/settings', { token: graphiteToken })).status).toBe(404)
    expect(await errorOf(asUser(sql, ids.graphiteOwner, (tx) => tx`select public.owner_set_telegram(${ids.iceLab}, false, null)`))).toBe('NOT_FOUND')
    const visible = await asUser(sql, ids.graphiteOwner, (tx) => tx`select tenant_id from public.tenant_notification_settings`)
    expect(visible.map((r) => r.tenant_id)).toEqual([ids.graphite])
    expect(await errorOf(asUser(sql, ids.graphiteOwner, (tx) => tx`update public.tenant_notification_settings set telegram_chat_id = '-1009999999999' where tenant_id = ${ids.iceLab}`))).toMatch(/permission denied/)
    const [ice] = await sql`select telegram_enabled, telegram_chat_id from public.tenant_notification_settings where tenant_id = ${ids.iceLab}`
    expect(ice).toEqual({ telegram_enabled: true, telegram_chat_id: ICE_CHAT })
  })

  it('staff and managers cannot change the destination; staff cannot even read it', async () => {
    const t = await createTenant(sql)
    expect(await errorOf(asUser(sql, t.staffId, (tx) => tx`select public.owner_set_telegram(${t.id}, true, '-1003333333333')`))).toBe('NOT_FOUND')
    expect(await asUser(sql, t.staffId, (tx) => tx`select * from public.tenant_notification_settings`)).toEqual([])
  })

  it('anon has no access to Telegram settings', async () => {
    const [g] = await sql`select has_table_privilege('anon', 'public.tenant_notification_settings', 'SELECT') as s,
                                 has_function_privilege('anon', 'public.owner_set_telegram(uuid, boolean, text, boolean)', 'EXECUTE') as f`
    expect(g).toEqual({ s: false, f: false })
  })
})

describe('demo, missing configuration and outages never break bookings', () => {
  it('TEST 5: demo studio with token, chat and enabled -> zero Bot API calls', async () => {
    const t = await createTenant(sql, { status: 'demo', bays: 2 })
    await asUser(sql, t.ownerId, (tx) => tx`select public.owner_set_telegram(${t.id}, true, '-1004444444444')`)
    const start = hoursFromNow(50)
    const { booking_id } = await book(sql, { tenantId: t.id, serviceId: t.serviceId, start, end: addMinutes(start, 120) })
    await dispatch()
    expect(received).toEqual([])
    expect((await outbox(booking_id))[0]).toMatchObject({ status: 'suppressed_demo' })
  })

  it('TEST 6: no bot token -> booking succeeds, notification not_configured', async () => {
    const b = await bookVia('graphite', 'detailing-wash', 2)
    await dispatch(null)
    expect(received).toEqual([])
    expect((await outbox(b.id))[0]).toMatchObject({ status: 'not_configured', last_error: 'TELEGRAM_BOT_TOKEN is not set' })
  })

  it('disabled in studio settings -> not_configured, nothing sent', async () => {
    await call(owner, 'POST', '/owner-api/graphite/settings/telegram', { token: graphiteToken, body: { enabled: false } })
    const b = await bookVia('graphite', 'detailing-wash', 3)
    await dispatch()
    expect(received).toEqual([])
    expect((await outbox(b.id))[0]).toMatchObject({ status: 'not_configured', last_error: 'Telegram is disabled in studio settings' })
    const s = await call(owner, 'GET', '/owner-api/graphite/settings', { token: graphiteToken })
    expect(s.body.telegram).toMatchObject({ state: 'disabled', enabled: false, chatId: GRAPHITE_CHAT })
    await call(owner, 'POST', '/owner-api/graphite/settings/telegram', { token: graphiteToken, body: { enabled: true } })
  })

  it('TEST 7: Telegram unreachable -> booking stands, outbox retries, one message once it recovers, no duplicates', async () => {
    const b = await bookVia('graphite', 'detailing-wash', 4)
    await dispatch(provider('http://127.0.0.1:9')) // nothing listens on the discard port
    const [first] = await outbox(b.id)
    expect(first).toMatchObject({ status: 'pending', attempts: 1 })
    expect(first!.last_error).toMatch(/^network:/)
    expect((await sql`select count(*)::int as n from public.bookings where id = ${b.id} and status <> 'cancelled'`)[0]!.n).toBe(1)
    // Recovery: the same row is retried and delivered exactly once.
    await sql`update public.notification_outbox set next_attempt_at = now() where booking_id = ${b.id}`
    await Promise.all([dispatch(), dispatch()])
    expect(received.filter((r) => r.text.includes(b.ref))).toHaveLength(1)
    expect((await outbox(b.id))[0]).toMatchObject({ status: 'sent', attempts: 2 })
    expect((await sql`select count(*)::int as n from public.bookings where ref_code = ${b.ref}`)[0]!.n).toBe(1)
  })

  it('TEST 7: a permanently unreachable API ends in failed after the attempt limit; owner sees a delivery error', async () => {
    const b = await bookVia('graphite', 'detailing-wash', 5)
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sql`update public.notification_outbox set next_attempt_at = now() where booking_id = ${b.id} and status = 'pending'`
      await dispatch(provider('http://127.0.0.1:9'))
    }
    expect((await outbox(b.id))[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    const s = await call(owner, 'GET', '/owner-api/graphite/settings', { token: graphiteToken })
    expect(s.body.telegram.state).toBe('delivery_error')
    expect(s.body.telegram.problem).toMatch(/недоступен/)
  })
})

describe('test notification (server-side) and owner-visible state', () => {
  it('sends to the studio’s own chat and reports Connected', async () => {
    const r = await call(owner, 'POST', '/owner-api/graphite/settings/telegram/test', { token: graphiteToken, body: {} })
    expect(r.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ chat_id: GRAPHITE_CHAT })
    expect(received[0]!.text).toContain('Тестовое сообщение')
    const s = await call(owner, 'GET', '/owner-api/graphite/settings', { token: graphiteToken })
    expect(s.body.telegram).toMatchObject({ state: 'connected', botConfigured: true, botUsername: 'detailflow_test_bot', lastTest: { ok: true } })
  })

  it('a rejected test shows a server-generated explanation and Delivery error', async () => {
    respond = () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } })
    const r = await call(owner, 'POST', '/owner-api/ice-lab/settings/telegram/test', { token: iceToken, body: {} })
    expect(r.status).toBe(422)
    expect(r.body.error).toEqual({ code: 'TELEGRAM_TEST_FAILED', message: 'Чат не найден. Проверьте ID чата и что бот добавлен в этот чат.' })
    const s = await call(owner, 'GET', '/owner-api/ice-lab/settings', { token: iceToken })
    expect(s.body.telegram).toMatchObject({ state: 'delivery_error', lastTest: { ok: false } })
    respond = () => ({ status: 200, body: { ok: true, result: { message_id: 1 } } })
    expect((await call(owner, 'POST', '/owner-api/ice-lab/settings/telegram/test', { token: iceToken, body: {} })).status).toBe(200)
    expect((await call(owner, 'GET', '/owner-api/ice-lab/settings', { token: iceToken })).body.telegram.state).toBe('connected')
  })

  it('without a platform bot the test is refused and the state is Not configured', async () => {
    const noBot = createOwnerApi({ sql: edge, cors: CORS, auth: { jwtSecret: JWT_SECRET, issuer: JWT_ISSUER }, telegram: null, log })
    expect((await call(noBot, 'POST', '/owner-api/graphite/settings/telegram/test', { token: graphiteToken, body: {} })).body.error.code).toBe('TELEGRAM_NOT_CONFIGURED')
    expect((await call(noBot, 'GET', '/owner-api/graphite/settings', { token: graphiteToken })).body.telegram.state).toBe('not_configured')
    expect(received).toEqual([])
  })

  it('a new chat id resets the test result; invalid ids and enabling without a chat are rejected', async () => {
    const t = await createTenant(sql)
    const tok = await accessToken(t.ownerId)
    expect((await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram`, { token: tok, body: { enabled: true } })).body.error.code).toBe('TELEGRAM_CHAT_REQUIRED')
    expect((await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram`, { token: tok, body: { enabled: true, chatId: 'not-a-chat' } })).status).toBe(400)
    expect((await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram`, { token: tok, body: { enabled: true, chatId: '-1005555555555' } })).status).toBe(200)
    expect((await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram/test`, { token: tok, body: {} })).status).toBe(200)
    await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram`, { token: tok, body: { enabled: true, chatId: '-1006666666666' } })
    expect((await call(owner, 'GET', `/owner-api/${t.slug}/settings`, { token: tok })).body.telegram.lastTest).toBeNull()
    const staffTok = await accessToken(t.staffId)
    expect((await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram/test`, { token: staffTok, body: {} })).status).toBe(403)
    expect((await call(owner, 'GET', `/owner-api/${t.slug}/settings`, { token: staffTok })).body.telegram).toBeNull()
  })

  it('test messages are rate limited per studio', async () => {
    const t = await createTenant(sql)
    const tok = await accessToken(t.ownerId)
    await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram`, { token: tok, body: { enabled: true, chatId: '-1007777777777' } })
    const codes = []
    for (let i = 0; i < 7; i++) codes.push((await call(owner, 'POST', `/owner-api/${t.slug}/settings/telegram/test`, { token: tok, body: {} })).status)
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(codes.slice(5)).toEqual([429, 429])
  })
})

describe('TEST 8: the bot token never leaks', () => {
  it('not into the outbox, owner API responses, test results or logs — even when Telegram echoes the URL', async () => {
    const echo = `Not Found: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`
    respond = () => ({ status: 400, body: { ok: false, error_code: 400, description: echo } })
    const b = await bookVia('graphite', 'detailing-wash', 6)
    await dispatch()
    const test = await call(owner, 'POST', '/owner-api/graphite/settings/telegram/test', { token: graphiteToken, body: {} })
    await dispatch(provider('http://127.0.0.1:9'))
    const dispatcher = createDispatcher({ sql: edge, provider: provider(), appUrl: 'https://app.example', secret: 's3cret-dispatcher', log })
    const run = await dispatcher(new Request('http://x/notify-dispatcher', { method: 'POST', headers: { 'x-dispatcher-secret': 's3cret-dispatcher' } }))
    const settings = await call(owner, 'GET', '/owner-api/graphite/settings', { token: graphiteToken })
    const detail = await call(owner, 'GET', `/owner-api/graphite/bookings/${b.id}`, { token: graphiteToken })
    const db = await sql`select (select coalesce(string_agg(last_error, ' '), '') from public.notification_outbox) || ' ' ||
                                (select coalesce(string_agg(telegram_last_test_error, ' '), '') from public.tenant_notification_settings) as all_errors`
    const haystack = [JSON.stringify(test.body), await run.text(), JSON.stringify(settings.body), JSON.stringify(detail.body), db[0]!.all_errors, logs.join('\n')].join('\n')
    expect(haystack).toContain('bot<redacted>') // the echo was stored, scrubbed
    expect(haystack).not.toContain(BOT_TOKEN)
    expect(haystack).not.toContain(BOT_TOKEN.split(':')[1])
  })
})
