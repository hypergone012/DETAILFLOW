import { createSql } from '../_shared/db.ts'
import { configureClientIp } from '../_shared/http.ts'
import { allowedOrigins, assertLeastPrivilegeRole, databaseUrl } from '../_shared/env.ts'
import { createAssistant } from './handler.ts'
import { createAnthropicAdapter } from './llm.ts'

const sql = createSql(databaseUrl())
// Fail closed: never serve with a role that can bypass RLS.
await assertLeastPrivilegeRole(sql)
configureClientIp({ trustedProxyHops: Number(Deno.env.get('DF_TRUSTED_PROXY_HOPS') ?? '1'), header: Deno.env.get('DF_CLIENT_IP_HEADER') ?? null })

const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
const effort = (Deno.env.get('DF_AI_EFFORT') ?? 'low') as 'low' | 'medium' | 'high'

Deno.serve(
  createAssistant({
    sql,
    cors: { allowedOrigins: allowedOrigins() },
    llm: apiKey ? createAnthropicAdapter({ apiKey, model: Deno.env.get('DF_AI_MODEL') ?? 'claude-opus-5-5', effort }) : null,
  }),
)
