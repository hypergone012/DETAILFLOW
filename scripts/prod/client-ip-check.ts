/**
 * Verifies that rate limits key on the real client address behind the
 * platform's proxies (DF_TRUSTED_PROXY_HOPS, docs/PRODUCTION.md §10.4).
 *
 * Sends one availability request with a forged X-Forwarded-For prefix and
 * looks up which hashed key the function charged:
 *   - this machine's public IP  -> correct
 *   - the forged address        -> client-controlled: FAIL (security)
 *   - anything else             -> a proxy address: every customer would share
 *                                  one bucket; FAIL (raise DF_TRUSTED_PROXY_HOPS)
 * Env: PROD_SUPABASE_URL, PROD_SUPABASE_PUBLISHABLE_KEY, DATABASE_URL, PUBLIC_IP (optional).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { env } from '../lib/env.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const FORGED = '198.51.100.77'
const api = env('PROD_SUPABASE_URL')
const headers = { apikey: process.env.PROD_SUPABASE_PUBLISHABLE_KEY ?? '', 'content-type': 'application/json' }
const label = process.env.SMOKE_LABEL ?? 'production'

const publicIp = process.env.PUBLIC_IP ?? (await (await fetch('https://api.ipify.org')).text()).trim()
const store = (await (await fetch(`${api}/functions/v1/public-api/storefront/graphite`, { headers })).json()) as { services: Array<{ id: string }> }
const day = new Date().toISOString().slice(0, 10)
const res = await fetch(`${api}/functions/v1/public-api/availability/graphite`, {
  method: 'POST',
  headers: { ...headers, 'x-forwarded-for': FORGED },
  body: JSON.stringify({ serviceId: store.services[0]!.id, vehicleClass: 'sedan', from: day, to: day }),
})

const sql = postgres(env('DATABASE_URL'), { max: 1, onnotice: () => {} })
const keys = (await sql<{ key: string }[]>`
  select key from private.rate_limit_buckets where key like 'avail:%' and window_start > now() - interval '3 minutes'`).map((r) => r.key.slice('avail:'.length))
await sql.end()

const verdict = keys.includes(sha(publicIp)) ? 'client-ip' : keys.includes(sha(FORGED)) ? 'forged' : 'proxy'
const ok = res.status === 200 && verdict === 'client-ip'
const out = join(import.meta.dirname, '../../docs/smoke')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, `client-ip-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), status: res.status, verdict, ok }, null, 2) + '\n')
console.log(
  verdict === 'client-ip' ? 'PASS  rate limits key on the client address (forged X-Forwarded-For prefix ignored)'
  : verdict === 'forged' ? 'FAIL  rate limit key is client-controlled: lower DF_TRUSTED_PROXY_HOPS'
  : 'FAIL  rate limit key is a proxy address (all customers would share it): raise DF_TRUSTED_PROXY_HOPS',
)
process.exit(ok ? 0 : 1)
