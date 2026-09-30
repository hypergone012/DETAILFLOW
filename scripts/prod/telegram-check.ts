/**
 * Live Telegram check (never prints the token):
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… pnpm prod:telegram-check
 * 1) getMe: the token is valid; 2) sendMessage through the same provider
 * code the dispatcher uses.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TelegramProvider } from '../../supabase/functions/_shared/notifications.ts'

const token = process.env.TELEGRAM_BOT_TOKEN
const chat = process.env.TELEGRAM_CHAT_ID
const out = join(import.meta.dirname, '../../docs/smoke')
mkdirSync(out, { recursive: true })
const save = (r: unknown) => writeFileSync(join(out, 'telegram-check.json'), JSON.stringify({ at: new Date().toISOString(), ...(r as object) }, null, 2) + '\n')

if (!token || !chat) {
  console.log('NOT VERIFIED: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required')
  save({ verified: false, reason: 'missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID' })
  process.exit(2)
}
const api = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org'
try {
  const me = (await (await fetch(`${api}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) })).json()) as { ok: boolean; result?: { username: string } }
  if (!me.ok) throw new Error('getMe failed: token rejected')
  const sent = await new TelegramProvider(token, api).send(chat, `DETAILFLOW: проверка уведомлений ${new Date().toISOString()}`)
  save({ verified: sent.ok, bot: me.result?.username, chat, result: sent })
  console.log(sent.ok ? `VERIFIED: @${me.result?.username} delivered message ${sent.providerMessageId}` : `FAILED: ${sent.error}`)
  process.exit(sent.ok ? 0 : 1)
} catch (err) {
  const msg = (err instanceof Error ? err.message : String(err)).split(token).join('<redacted>')
  save({ verified: false, error: msg })
  console.log(`FAILED: ${msg}`)
  process.exit(1)
}
