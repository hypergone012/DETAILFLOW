import { createSql } from '../_shared/db.ts'
import { allowedOrigins, requireEnv } from '../_shared/env.ts'
import { createAssistant } from './handler.ts'
import { createAnthropicAdapter } from './llm.ts'

const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
const effort = (Deno.env.get('DF_AI_EFFORT') ?? 'low') as 'low' | 'medium' | 'high'

Deno.serve(
  createAssistant({
    sql: createSql(requireEnv('SUPABASE_DB_URL')),
    cors: { allowedOrigins: allowedOrigins() },
    llm: apiKey ? createAnthropicAdapter({ apiKey, model: Deno.env.get('DF_AI_MODEL') ?? 'claude-opus-5-5', effort }) : null,
  }),
)
