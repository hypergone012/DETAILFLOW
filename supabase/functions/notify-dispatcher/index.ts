import { createSql } from '../_shared/db.ts'
import { assertLeastPrivilegeRole, databaseUrl, requireEnv } from '../_shared/env.ts'
import { TelegramProvider } from '../_shared/notifications.ts'
import { createDispatcher } from './handler.ts'

const sql = createSql(databaseUrl())
// Fail closed: never serve with a role that can bypass RLS.
await assertLeastPrivilegeRole(sql)

const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')

Deno.serve(
  createDispatcher({
    sql,
    // No token => rows are marked not_configured; nothing pretends to be sent.
    provider: botToken ? new TelegramProvider(botToken) : null,
    appUrl: requireEnv('DF_APP_URL'),
    secret: requireEnv('DF_DISPATCHER_SECRET'),
  }),
)
