import { createSql } from '../_shared/db.ts'
import { allowedOrigins, assertLeastPrivilegeRole, authConfig, databaseUrl } from '../_shared/env.ts'
import { createOwnerApi } from './handler.ts'

const sql = createSql(databaseUrl())
// Fail closed: never serve with a role that can bypass RLS.
await assertLeastPrivilegeRole(sql)

const handler = createOwnerApi({
  sql,
  cors: { allowedOrigins: allowedOrigins() },
  auth: authConfig(),
  telegramConfigured: !!Deno.env.get('TELEGRAM_BOT_TOKEN'),
})

Deno.serve(handler)
