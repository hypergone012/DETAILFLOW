/**
 * Links a studio's Telegram chat during a deploy (workflow input), so the
 * operator does not have to open the owner settings for the first studio:
 *   DATABASE_URL=… tsx scripts/prod/link-telegram-chat.ts graphite -1001234567890
 * Same rules as the owner settings: numeric chat id, one chat per studio
 * (unique index), destination stored on the studio's own row.
 */
import postgres from 'postgres'
import { env } from '../lib/env.ts'

const [slug, chatId] = process.argv.slice(2)
if (!slug || !chatId || !/^-?\d{3,20}$/.test(chatId)) {
  console.error('usage: link-telegram-chat.ts <slug> <numeric chat id>')
  process.exit(2)
}
const sql = postgres(env('DATABASE_URL'), { max: 1, onnotice: () => {} })
try {
  const rows = await sql`
    update public.tenant_notification_settings n set telegram_enabled = true, telegram_chat_id = ${chatId}
    from public.tenants t where t.id = n.tenant_id and t.slug = ${slug} returning n.tenant_id`
  if (rows.length !== 1) throw new Error(`studio ${slug} not found`)
  console.log(`${slug}: Telegram chat ••••${chatId.slice(-4)} linked and enabled`)
} catch (err) {
  const e = err as { code?: string; message?: string }
  console.error(e.code === '23505' ? 'this chat is already linked to another studio' : e.message ?? String(err))
  process.exitCode = 1
} finally {
  await sql.end()
}
