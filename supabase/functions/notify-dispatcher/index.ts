import { createSql } from '../_shared/db.ts'
import { requireEnv } from '../_shared/env.ts'
import { TelegramProvider } from '../_shared/notifications.ts'
import { createDispatcher } from './handler.ts'

const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')

Deno.serve(
  createDispatcher({
    sql: createSql(requireEnv('SUPABASE_DB_URL')),
    // No token => rows are marked not_configured; nothing pretends to be sent.
    provider: botToken ? new TelegramProvider(botToken) : null,
    appUrl: requireEnv('DF_APP_URL'),
    secret: requireEnv('DF_DISPATCHER_SECRET'),
  }),
)
