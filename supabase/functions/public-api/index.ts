import { createSql } from '../_shared/db.ts'
import { allowedOrigins, requireEnv } from '../_shared/env.ts'
import { createPublicApi } from './handler.ts'

const handler = createPublicApi({
  sql: createSql(requireEnv('SUPABASE_DB_URL')),
  cors: { allowedOrigins: allowedOrigins() },
  manageTokenSecret: requireEnv('DF_MANAGE_TOKEN_SECRET'),
})

Deno.serve(handler)
