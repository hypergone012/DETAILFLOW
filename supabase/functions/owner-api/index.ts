import { createSql } from '../_shared/db.ts'
import { allowedOrigins, assertLeastPrivilegeRole, authConfig, databaseUrl } from '../_shared/env.ts'
import { TelegramProvider } from '../_shared/notifications.ts'
import { createOwnerApi } from './handler.ts'

const sql = createSql(databaseUrl())
// Fail closed: never serve with a role that can bypass RLS.
await assertLeastPrivilegeRole(sql)

const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')

const handler = createOwnerApi({
  sql,
  cors: { allowedOrigins: allowedOrigins() },
  auth: authConfig(),
  // Shared platform bot; each studio's destination chat comes from its own settings row.
  telegram: botToken ? new TelegramProvider(botToken) : null,
})

Deno.serve(handler)
