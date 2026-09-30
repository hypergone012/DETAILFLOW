import { describe, expect, it } from 'vitest'
import { TelegramProvider } from './notifications.ts'

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

describe('TelegramProvider never leaks the bot token', () => {
  it('scrubs the token from network errors (Deno puts the URL in the message)', async () => {
    const failingFetch = (async (url: string) => {
      throw new TypeError(`error sending request for url (${url}): connection refused`)
    }) as unknown as typeof fetch
    const r = await new TelegramProvider(TOKEN, 'https://api.telegram.org', failingFetch).send('1', 'x')
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(JSON.stringify(r)).not.toContain('AAHdqTcv')
  })

  it('scrubs the token from API error descriptions', async () => {
    const echoFetch = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized: bot${TOKEN}` }), { status: 401 })) as unknown as typeof fetch
    const r = await new TelegramProvider(TOKEN, 'https://api.telegram.org', echoFetch).send('1', 'x')
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(r).toMatchObject({ ok: false, retryable: false })
  })
})
