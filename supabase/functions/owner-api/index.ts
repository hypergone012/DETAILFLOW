import { createSql } from '../_shared/db.ts'
import { allowedOrigins, authConfig, requireEnv } from '../_shared/env.ts'
import { createOwnerApi } from './handler.ts'

const handler = createOwnerApi({
  sql: createSql(requireEnv('SUPABASE_DB_URL')),
  cors: { allowedOrigins: allowedOrigins() },
  auth: authConfig(),
  telegramConfigured: !!Deno.env.get('TELEGRAM_BOT_TOKEN'),
})

Deno.serve(handler)
