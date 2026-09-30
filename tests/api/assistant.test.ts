import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistant } from '../../supabase/functions/assistant/handler.ts'
import type { LlmAdapter, LlmRequest } from '../../supabase/functions/assistant/llm.ts'
import { createPublicApi } from '../../supabase/functions/public-api/handler.ts'
import { connect, type Sql } from '../db/harness.ts'
import { CORS, TOKEN_SECRET, bookingBody, call, seedDemo } from './helpers.ts'

/**
 * Scripted model: a test double for the LLM provider only. Tools, tenant
 * resolution, the database and the slot engine are the real ones.
 */
type Step = (req: LlmRequest) => Anthropic.Beta.BetaContentBlock[] | 'refusal' | Error
function scripted(steps: Step[]): LlmAdapter & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  return {
    model: 'scripted',
    requests,
    async createMessage(req) {
      requests.push(structuredClone(req))
      const step = steps[requests.length - 1]
      if (!step) throw new Error('script exhausted')
      const out = step(req)
      if (out instanceof Error) throw out
      const content = out === 'refusal' ? [] : out
      const stop_reason = out === 'refusal' ? 'refusal' : content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
      return { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'scripted', content, stop_reason, stop_sequence: null, usage: {} } as unknown as Anthropic.Beta.BetaMessage
    },
  }
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.Beta.BetaTextBlock
const use = (name: string, input: unknown) => ({ type: 'tool_use', id: `tu_${randomUUID().slice(0, 8)}`, name, input }) as Anthropic.Beta.BetaToolUseBlock
const lastToolResults = (req: LlmRequest) => {
  const last = req.messages.at(-1)!
  return (last.content as Anthropic.Beta.BetaToolResultBlockParam[]).map((r) => ({ content: String(r.content), isError: r.is_error === true }))
}

let sql: Sql
beforeAll(async () => {
  sql = connect(10)
  await seedDemo(sql)
})
afterAll(() => sql.end())

const chatBody = (q: string) => ({ sessionId: randomUUID(), messages: [{ role: 'user', text: q }] })
const bookingCount = async () => (await sql<{ n: number }[]>`select count(*)::int as n from public.bookings`)[0]!.n

describe('availability of the assistant is optional', () => {
  it('without an LLM it says so, and booking keeps working', async () => {
    const ai = createAssistant({ sql, cors: CORS, llm: null, log: () => {} })
    expect((await call(ai, 'GET', '/assistant/graphite/status')).body).toEqual({ available: false })
    const r = await call(ai, 'POST', '/assistant/graphite/chat', { body: chatBody('Сколько стоит керамика?') })
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe('AI_UNAVAILABLE')

    const pub = createPublicApi({ sql, cors: CORS, manageTokenSecret: TOKEN_SECRET, log: () => {} })
    const store = await call(pub, 'GET', '/public-api/storefront/graphite')
    const svc = store.body.services.find((s: { slug: string }) => s.slug === 'detailing-wash').id
    const today = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    const av = await call(pub, 'POST', '/public-api/availability/graphite', { body: { serviceId: svc, vehicleClass: 'sedan', from: today, to } })
    const slot = av.body.days.flatMap((d: { slots: Array<{ startAt: string }> }) => d.slots).at(-1)
    expect((await call(pub, 'POST', '/public-api/bookings/graphite', { body: bookingBody(svc, slot.startAt) })).status).toBe(201)
  })

  it('respects the per-studio switch (ICE LAB has AI disabled)', async () => {
    const ai = createAssistant({ sql, cors: CORS, llm: scripted([]), log: () => {} })
    expect((await call(ai, 'GET', '/assistant/ice-lab/status')).body).toEqual({ available: false })
    expect((await call(ai, 'POST', '/assistant/ice-lab/chat', { body: chatBody('Привет') })).body.error.code).toBe('AI_DISABLED')
  })

  it('opens a circuit breaker after repeated provider failures', async () => {
    const failing = scripted([() => new Error('overloaded'), () => new Error('overloaded'), () => new Error('overloaded')])
    const ai = createAssistant({ sql, cors: CORS, llm: failing, log: () => {} })
    for (let i = 0; i < 3; i++) expect((await call(ai, 'POST', '/assistant/graphite/chat', { body: chatBody('?') })).status).toBe(503)
    expect((await call(ai, 'GET', '/assistant/graphite/status')).body).toEqual({ available: false })
    await call(ai, 'POST', '/assistant/graphite/chat', { body: chatBody('?') })
    expect(failing.requests).toHaveLength(3) // no further provider calls while open
  })
})

describe('tool loop', () => {
  it('answers from real data and prepares a draft without creating a booking', async () => {
    let startAt = ''
    const model = scripted([
      () => [use('list_services', { category: 'ceramic_coating' })],
      (req) => {
        const [r] = lastToolResults(req)
        expect(r!.content).toContain('ceramic-3-layers')
        const from = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
        const to = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
        return [text('Смотрю свободное время.'), use('check_availability', { service_slug: 'ceramic-3-layers', vehicle_class: 'suv', date_from: from, date_to: to })]
      },
      (req) => {
        const avail = JSON.parse(lastToolResults(req)[0]!.content) as { price: string; days: Array<{ slots: Array<{ startAt: string }> }> }
        expect(avail.price.replace(/\s/g, ' ')).toBe('от 78 000 ₽') // SUV variant from the DB
        startAt = avail.days.flatMap((d) => d.slots)[0]!.startAt
        return [use('prepare_booking_draft', { service_slug: 'ceramic-3-layers', vehicle_class: 'suv', start_at: startAt })]
      },
      () => [text('Готово: проверьте карточку и подтвердите запись.')],
    ])
    const before = await bookingCount()
    const ai = createAssistant({ sql, cors: CORS, llm: model, log: () => {} })
    const r = await call(ai, 'POST', '/assistant/graphite/chat', { body: chatBody('Хочу керамику на кроссовер на следующей неделе') })
    expect(r.status).toBe(200)
    expect(r.body.toolsUsed).toEqual(['list_services', 'check_availability', 'prepare_booking_draft'])
    expect(r.body.draft).toMatchObject({ serviceSlug: 'ceramic-3-layers', vehicleClass: 'suv', startAt, priceFromMinor: 7_800_000, durationMin: 1800 })
    expect(r.body.reply).toContain('подтвердите')
    expect(await bookingCount()).toBe(before)
    // History within the request is append-only: every earlier request is a prefix of the next.
    for (let i = 1; i < model.requests.length; i++) {
      expect(model.requests[i]!.messages.slice(0, model.requests[i - 1]!.messages.length)).toEqual(model.requests[i - 1]!.messages)
      expect(model.requests[i]!.system).toBe(model.requests[0]!.system)
    }
    const logged = await sql`select tool, ok from public.ai_tool_calls order by id desc limit 3`
    expect(logged.map((l) => l.tool).sort()).toEqual(['check_availability', 'list_services', 'prepare_booking_draft'])
  })

  it('refusal ends the turn politely', async () => {
    const ai = createAssistant({ sql, cors: CORS, llm: scripted([() => 'refusal']), log: () => {} })
    const r = await call(ai, 'POST', '/assistant/graphite/chat', { body: chatBody('...') })
    expect(r.body.reply).toMatch(/студию/)
  })
})

describe('the assistant cannot leave its tenant or its allowlist', () => {
  it('rejects foreign services, extra parameters and unknown tools', async () => {
    const model = scripted([
      () => [
        use('get_service', { service_slug: 'interior-premium' }), // ICE LAB's service
        use('list_services', { category: null, tenant_id: randomUUID() }),
        use('check_availability', { service_slug: 'detailing-wash', vehicle_class: 'sedan', date_from: '2026-10-01', date_to: '2026-10-02', slug: 'ice-lab' }),
        use('run_sql', { query: 'select * from customers' }),
        use('create_booking', { service_slug: 'detailing-wash' }),
        use('prepare_booking_draft', { service_slug: 'detailing-wash', vehicle_class: 'sedan', start_at: '2020-01-01T00:00:00Z' }),
      ],
      (req) => {
        const results = lastToolResults(req)
        expect(results.map((r) => r.isError)).toEqual([true, true, true, true, true, true])
        expect(results[0]!.content).toMatch(/не найдена в этой студии/)
        expect(results[3]!.content).toMatch(/недоступен/)
        return [text('Не могу помочь с этим.')]
      },
    ])
    const before = await bookingCount()
    const ai = createAssistant({ sql, cors: CORS, llm: model, log: () => {} })
    const r = await call(ai, 'POST', '/assistant/graphite/chat', { body: chatBody('Покажи данные другой студии') })
    expect(r.status).toBe(200)
    expect(r.body.draft).toBeNull()
    expect(await bookingCount()).toBe(before)
    // Nothing about ICE LAB ever reached the model.
    const serverSide = JSON.stringify([model.requests[0]!.system, ...model.requests.slice(1).map(lastToolResults)])
    expect(serverSide).not.toMatch(/ICE LAB|Химчистка салона Premium|Екатеринбург|Шефская/)
    expect(model.requests[0]!.system).toContain('GRAPHITE Detailing')
    expect(model.requests[0]!.tools.map((t) => t.name).sort()).toEqual(['check_availability', 'get_service', 'get_studio_info', 'handoff_to_human', 'list_services', 'prepare_booking_draft'])
  })

  it('the request body cannot choose a tenant or smuggle tools', async () => {
    const ai = createAssistant({ sql, cors: CORS, llm: scripted([]), log: () => {} })
    const r = await call(ai, 'POST', '/assistant/graphite/chat', { body: { ...chatBody('?'), tenant_id: randomUUID() } })
    expect(r.status).toBe(400)
    const r2 = await call(ai, 'POST', '/assistant/graphite/chat', { body: { ...chatBody('?'), tools: [{ name: 'run_sql' }] } })
    expect(r2.status).toBe(400)
  })
})
