import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDispatcher } from '../../supabase/functions/notify-dispatcher/handler.ts'
import { MAX_ATTEMPTS, TelegramProvider, dispatchOutbox } from '../../supabase/functions/_shared/notifications.ts'
import { addMinutes, book, createTenant, hoursFromNow, type TenantFixture } from '../db/fixtures.ts'
import { asUser, connect, edgeConnect, errorOf, type Sql } from '../db/harness.ts'

/**
 * Local server implementing the Telegram Bot API sendMessage contract
 * (request shape and ok/error envelopes), so the real TelegramProvider HTTP
 * code path is exercised. It is a test double for the external service only.
 */
interface Received { token: string; chat_id: string; text: string }
let server: Server
let apiBase: string
let received: Received[] = []
let respond: (r: Received) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, result: { message_id: 1 } } })

let sql: Sql
// Handlers run as df_edge, the least-privilege role used in production.
let edge: Sql
let active: TenantFixture
let demo: TenantFixture

async function outboxFor(bookingId: string) {
  return sql<{ id: string; status: string; attempts: number; last_error: string | null; provider_message_id: string | null; next_attempt_at: Date }[]>`
    select id, status, attempts, last_error, provider_message_id, next_attempt_at from public.notification_outbox where booking_id = ${bookingId}`
}

async function newBooking(t: TenantFixture, h: number) {
  const s = hoursFromNow(h)
  return (await book(sql, { tenantId: t.id, serviceId: t.serviceId, start: s, end: addMinutes(s, 120) })).booking_id
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const token = /\/bot([^/]+)\/sendMessage$/.exec(req.url ?? '')?.[1] ?? ''
      const body = JSON.parse(raw || '{}') as { chat_id: string; text: string }
      const r = { token, chat_id: String(body.chat_id), text: body.text }
      received.push(r)
      const out = respond(r)
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  sql = connect(10)
  edge = edgeConnect()
  active = await createTenant(sql, { status: 'active', bays: 5 })
  demo = await createTenant(sql, { status: 'demo', bays: 5 })
  await sql`update public.tenant_settings set telegram_chat_id = '123456789' where tenant_id in (${active.id}, ${demo.id})`
  // Drain rows created by other test files so each test sees only its own.
  await sql`update public.notification_outbox set status = 'not_configured' where status = 'pending'`
})
afterAll(async () => {
  await edge.end()
  await sql.end()
  await new Promise((r) => server.close(r))
})
beforeEach(() => {
  received = []
  respond = () => ({ status: 200, body: { ok: true, result: { message_id: 4242 } } })
})

const provider = () => new TelegramProvider('TEST_TOKEN', apiBase)
const run = (p: TelegramProvider | null = provider()) => dispatchOutbox(edge, { provider: p, appUrl: 'https://app.example' })

describe('demo never sends', () => {
  it('suppresses demo tenant notifications even with a bot token and a chat id', async () => {
    const id = await newBooking(demo, 30)
    await run()
    expect(received).toEqual([])
    expect((await outboxFor(id))[0]).toMatchObject({ status: 'suppressed_demo' })
  })
})

describe('honest configuration state', () => {
  it('marks not_configured when the platform has no bot token', async () => {
    const id = await newBooking(active, 31)
    await run(null)
    expect((await outboxFor(id))[0]).toMatchObject({ status: 'not_configured', last_error: 'TELEGRAM_BOT_TOKEN is not set' })
  })

  it('marks not_configured when the studio has no chat id', async () => {
    const t = await createTenant(sql, { status: 'active' })
    const id = await newBooking(t, 32)
    await run()
    expect(received).toEqual([])
    expect((await outboxFor(id))[0]).toMatchObject({ status: 'not_configured', last_error: 'studio has no Telegram chat id' })
  })
})

describe('telegram delivery', () => {
  it('sends to the studio chat through the Bot API and stores the message id', async () => {
    const id = await newBooking(active, 33)
    const [{ ref_code }] = (await sql`select ref_code from public.bookings where id = ${id}`) as unknown as [{ ref_code: string }]
    const summary = await run()
    expect(summary.sent).toBe(1)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ token: 'TEST_TOKEN', chat_id: '123456789' })
    expect(received[0]!.text).toContain(`Новая запись · ${ref_code}`)
    expect(received[0]!.text).toContain(`https://app.example/s/${active.slug}/owner/bookings/${id}`)
    expect((await outboxFor(id))[0]).toMatchObject({ status: 'sent', provider_message_id: '4242' })
  })

  it('retries 429 with Telegram’s retry_after and gives up after max attempts', async () => {
    const id = await newBooking(active, 34)
    respond = () => ({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } })
    await run()
    const [first] = await outboxFor(id)
    expect(first).toMatchObject({ status: 'pending', attempts: 1 })
    expect(first!.next_attempt_at.getTime() - Date.now()).toBeGreaterThan(4_000)
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await sql`update public.notification_outbox set next_attempt_at = now() where id = ${first!.id}`
      await run()
    }
    expect((await outboxFor(id))[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
  })

  it('does not retry permanent errors (chat not found)', async () => {
    const id = await newBooking(active, 35)
    respond = () => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } })
    await run()
    expect((await outboxFor(id))[0]).toMatchObject({ status: 'failed', last_error: 'Bad Request: chat not found', attempts: 1 })
  })

  it('two concurrent dispatchers never send the same notification twice', async () => {
    const ids = await Promise.all([36, 37, 38, 39, 40, 41].map((h) => newBooking(active, h)))
    await Promise.all([run(), run(), run()])
    const rows = (await Promise.all(ids.map(outboxFor))).flat()
    expect(rows.every((r) => r.status === 'sent')).toBe(true)
    expect(received).toHaveLength(ids.length)
  })
})

describe('dispatcher endpoint & owner settings', () => {
  it('requires the scheduler secret', async () => {
    const handler = createDispatcher({ sql: edge, provider: provider(), appUrl: 'https://app.example', secret: 's3cret', log: () => {} })
    expect((await handler(new Request('http://x/notify-dispatcher', { method: 'POST' }))).status).toBe(401)
    const ok = await handler(new Request('http://x/notify-dispatcher', { method: 'POST', headers: { 'x-dispatcher-secret': 's3cret' } }))
    expect(ok.status).toBe(200)
  })

  it('only the studio owner can set its Telegram chat', async () => {
    await asUser(sql, active.ownerId, (tx) => tx`select public.owner_set_telegram_chat(${active.id}, '-1001234567890')`)
    const [s] = await sql`select telegram_chat_id from public.tenant_settings where tenant_id = ${active.id}`
    expect(s!.telegram_chat_id).toBe('-1001234567890')
    expect(await errorOf(asUser(sql, active.staffId, (tx) => tx`select public.owner_set_telegram_chat(${active.id}, '1234')`))).toBe('NOT_FOUND')
    expect(await errorOf(asUser(sql, demo.ownerId, (tx) => tx`select public.owner_set_telegram_chat(${active.id}, '1234')`))).toBe('NOT_FOUND')
    await sql`update public.tenant_settings set telegram_chat_id = '123456789' where tenant_id = ${active.id}`
  })
})
