/**
 * LOCAL DEVELOPMENT GATEWAY (plays the role of Kong in the Supabase stack).
 * Serves the real function handlers on real Deno under /functions/v1/<name>
 * and proxies /auth/v1/* to the locally built Supabase Auth (GoTrue).
 * Not deployed: on hosted Supabase each function has its own entrypoint.
 */
import { createAssistant } from '../assistant/handler.ts'
import { createAnthropicAdapter } from '../assistant/llm.ts'
import { createDispatcher } from '../notify-dispatcher/handler.ts'
import { createOwnerApi } from '../owner-api/handler.ts'
import { createPublicApi } from '../public-api/handler.ts'
import { createSql } from '../_shared/db.ts'
import { assertLeastPrivilegeRole } from '../_shared/env.ts'
import { TelegramProvider } from '../_shared/notifications.ts'

const env = (k: string, d: string) => Deno.env.get(k) ?? d
// Same least-privilege role as production (scripts/local/stack.sh enable-edge-role).
const sql = createSql(env('DF_DB_URL', 'postgres://df_edge:local-edge-password@127.0.0.1:54322/postgres_df'))
await assertLeastPrivilegeRole(sql)
const cors = { allowedOrigins: env('DF_ALLOWED_ORIGINS', 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:8788').split(',') }
const authUpstream = env('DF_AUTH_UPSTREAM', 'http://127.0.0.1:54324')

const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN')
const dispatcherSecret = env('DF_DISPATCHER_SECRET', 'local-dispatcher-secret')
const dispatcher = createDispatcher({
  sql,
  provider: botToken ? new TelegramProvider(botToken, env('TELEGRAM_API_BASE', 'https://api.telegram.org')) : null,
  appUrl: env('DF_APP_URL', 'http://127.0.0.1:5173'),
  secret: dispatcherSecret,
})

const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
const assistant = createAssistant({
  sql,
  cors,
  llm: anthropicKey
    ? createAnthropicAdapter({ apiKey: anthropicKey, model: env('DF_AI_MODEL', 'claude-opus-5-5'), effort: env('DF_AI_EFFORT', 'low') as 'low' })
    : null,
})

const functions: Record<string, (req: Request) => Promise<Response>> = {
  assistant,
  'notify-dispatcher': dispatcher,
  'public-api': createPublicApi({
    sql,
    cors,
    manageTokenSecret: env('DF_MANAGE_TOKEN_SECRET', 'local-manage-token-secret-change-me'),
    bookingsPerIpPer10Min: Number(env('DF_BOOKING_RATE_LIMIT', '10')),
  }),
  'owner-api': createOwnerApi({ sql, cors, auth: { jwtSecret: env('DF_JWT_SECRET', 'super-secret-jwt-token-with-at-least-32-characters-long'), issuer: env('DF_JWT_ISSUER', 'http://127.0.0.1:54321/auth/v1') }, telegramConfigured: !!botToken }),
}

async function proxyAuth(req: Request, url: URL): Promise<Response> {
  const origin = req.headers.get('origin') ?? ''
  const corsHeaders: Record<string, string> = cors.allowedOrigins.includes(origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', vary: 'origin' }
    : {}
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  const target = `${authUpstream}${url.pathname.replace(/^\/auth\/v1/, '')}${url.search}`
  const headers = new Headers(req.headers)
  headers.delete('host')
  const upstream = await fetch(target, { method: req.method, headers, body: req.body, redirect: 'manual' })
  const res = new Response(upstream.body, upstream)
  for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v)
  return res
}

// Local stand-in for the Supabase cron schedule that invokes notify-dispatcher.
const dispatchEveryMs = Number(env('DF_DISPATCH_INTERVAL_MS', '15000'))
if (dispatchEveryMs > 0) {
  setInterval(() => {
    void dispatcher(new Request('http://local/functions/v1/notify-dispatcher', { method: 'POST', headers: { 'x-dispatcher-secret': dispatcherSecret } }))
  }, dispatchEveryMs)
}

const port = Number(env('DF_GATEWAY_PORT', '54321'))
Deno.serve({ port, hostname: '127.0.0.1', onListen: () => console.log(`gateway http://127.0.0.1:${port}`) }, (req) => {
  const url = new URL(req.url)
  if (url.pathname.startsWith('/auth/v1')) return proxyAuth(req, url)
  const m = /^\/functions\/v1\/([a-z-]+)/.exec(url.pathname)
  const fn = m ? functions[m[1]!] : undefined
  if (fn) return fn(req)
  return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), { status: 404, headers: { 'content-type': 'application/json' } })
})
