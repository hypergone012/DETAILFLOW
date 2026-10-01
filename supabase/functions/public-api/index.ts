import { createSql } from '../_shared/db.ts'
import { configureClientIp } from '../_shared/http.ts'
import { allowedOrigins, assertLeastPrivilegeRole, databaseUrl, manageTokenSecret } from '../_shared/env.ts'
import { createPublicApi } from './handler.ts'

const sql = createSql(databaseUrl())
// Fail closed: never serve with a role that can bypass RLS.
await assertLeastPrivilegeRole(sql)
configureClientIp({ trustedProxyHops: Number(Deno.env.get('DF_TRUSTED_PROXY_HOPS') ?? '1'), header: Deno.env.get('DF_CLIENT_IP_HEADER') ?? null })

const handler = createPublicApi({
  sql,
  cors: { allowedOrigins: allowedOrigins() },
  manageTokenSecret: manageTokenSecret(),
})

Deno.serve(handler)
