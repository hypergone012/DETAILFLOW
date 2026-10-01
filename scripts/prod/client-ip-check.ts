/**
 * Verifies — and with --tune, configures — how the functions find the real
 * client address behind the platform's proxies (rate limits must key on the
 * customer, not on a proxy all customers share, and never on a value the
 * client can forge). docs/PRODUCTION.md §10.4.
 *
 * Probe: one availability request with forged X-Forwarded-For / X-Real-IP /
 * CF-Connecting-IP values; the hit counters in private.rate_limit_buckets show
 * which hashed key the function charged:
 *   this machine's public IP -> correct
 *   the forged address       -> client-controlled (rejected)
 *   anything else            -> a proxy address (rejected)
 *
 * --tune: tries DF_TRUSTED_PROXY_HOPS 1..3 and the platform headers
 * cf-connecting-ip / x-real-ip (function secrets + redeploy), keeps the first
 * configuration that passes, redeploys the assistant with it.
 *
 * Env: PROD_SUPABASE_URL, PROD_SUPABASE_PUBLISHABLE_KEY, DATABASE_URL,
 * SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (--tune), PUBLIC_IP (optional).
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { env } from '../lib/env.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const api = env('PROD_SUPABASE_URL')
const headers = { apikey: process.env.PROD_SUPABASE_PUBLISHABLE_KEY ?? '', 'content-type': 'application/json' }
const label = process.env.SMOKE_LABEL ?? 'production'
const tune = process.argv.includes('--tune')

type Verdict = 'client-ip' | 'forged' | 'proxy' | 'error'
interface Candidate { hops: string; header: string }

const publicIp = process.env.PUBLIC_IP ?? (await (await fetch('https://api.ipify.org')).text()).trim()
const sql = postgres(env('DATABASE_URL'), { max: 1, onnotice: () => {} })
const store = (await (await fetch(`${api}/functions/v1/public-api/storefront/graphite`, { headers })).json()) as { services: Array<{ id: string }> }
const day = new Date().toISOString().slice(0, 10)

async function hits(ip: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select coalesce(sum(hits), 0)::int as n from private.rate_limit_buckets where key = ${`avail:${sha(ip)}`}`
  return r!.n
}

async function probe(c: Candidate): Promise<Verdict> {
  const forged = `198.51.100.${randomInt(1, 254)}`
  const [mineBefore, forgedBefore] = [await hits(publicIp), await hits(forged)]
  const forgedHeaders: Record<string, string> = { 'x-forwarded-for': forged, 'x-real-ip': forged }
  if (c.header !== 'none') forgedHeaders[c.header] = forged
  const res = await fetch(`${api}/functions/v1/public-api/availability/graphite`, {
    method: 'POST',
    headers: { ...headers, ...forgedHeaders },
    body: JSON.stringify({ serviceId: store.services[0]!.id, vehicleClass: 'sedan', from: day, to: day }),
  })
  if (res.status !== 200) return 'error'
  if ((await hits(forged)) > forgedBefore) return 'forged'
  if ((await hits(publicIp)) > mineBefore) return 'client-ip'
  return 'proxy'
}

async function apply(c: Candidate, fns: string[]): Promise<void> {
  const ref = env('SUPABASE_PROJECT_REF')
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env('SUPABASE_ACCESS_TOKEN')}`, 'content-type': 'application/json' },
    body: JSON.stringify([{ name: 'DF_TRUSTED_PROXY_HOPS', value: c.hops }, { name: 'DF_CLIENT_IP_HEADER', value: c.header }]),
  })
  if (!res.ok) throw new Error(`secrets ${res.status}`)
  for (const fn of fns) {
    const r = spawnSync('supabase', ['functions', 'deploy', fn, '--project-ref', ref, '--use-api'], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`deploy ${fn} failed`)
  }
}

const tried: Array<Candidate & { verdict: Verdict }> = []
let chosen: Candidate | null = null
try {
  const current: Candidate = { hops: process.env.DF_TRUSTED_PROXY_HOPS ?? 'current', header: 'none' }
  const first = await probe(current)
  tried.push({ ...current, verdict: first })
  if (first === 'client-ip') chosen = current
  if (!chosen && tune) {
    const candidates: Candidate[] = [
      { hops: '2', header: 'none' }, { hops: '3', header: 'none' },
      { hops: '1', header: 'cf-connecting-ip' }, { hops: '1', header: 'x-real-ip' },
    ]
    for (const c of candidates) {
      await apply(c, ['public-api'])
      let verdict: Verdict = 'error'
      // A fresh deploy can take a few seconds to replace the running instance.
      for (let i = 0; i < 4 && verdict !== 'client-ip'; i++) {
        await sleep(8_000)
        verdict = await probe(c)
        if (verdict === 'forged') break
      }
      tried.push({ ...c, verdict })
      console.log(`candidate hops=${c.hops} header=${c.header}: ${verdict}`)
      if (verdict === 'client-ip') {
        chosen = c
        await apply(c, ['assistant'])
        break
      }
    }
    if (!chosen) await apply({ hops: '1', header: 'none' }, ['public-api'])
  }
} finally {
  await sql.end()
}

const out = join(import.meta.dirname, '../../docs/smoke')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, `client-ip-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), ok: !!chosen, chosen, tried }, null, 2) + '\n')
console.log(chosen
  ? `PASS  rate limits key on the client address (hops=${chosen.hops}, header=${chosen.header}); forged headers ignored`
  : `FAIL  no configuration keyed on the client address: ${tried.map((t) => `${t.hops}/${t.header}=${t.verdict}`).join(', ')}`)
process.exit(chosen ? 0 : 1)
