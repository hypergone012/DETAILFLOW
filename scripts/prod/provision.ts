/**
 * Production provisioning for GitHub Actions (.github/workflows/deploy.yml).
 * Turns two account tokens into a running DETAILFLOW without manual setup:
 *
 *   tsx scripts/prod/provision.ts prepare
 *     Supabase project (found by name or created), Cloudflare Pages project,
 *     API keys, pooler URLs, generated secrets (kept in the project's Vault so
 *     re-runs reuse them) -> $GITHUB_ENV, every secret masked first.
 *   tsx scripts/prod/provision.ts configure      (after the migrations)
 *     df_edge login, Auth settings, Edge Function secrets, dispatcher schedule.
 *
 * Inputs: SUPABASE_ACCESS_TOKEN, CLOUDFLARE_API_TOKEN (required);
 * SUPABASE_PROJECT_REF, SUPABASE_ORG_SLUG, DF_PROJECT_NAME, DF_REGION,
 * CLOUDFLARE_ACCOUNT_ID, CF_PAGES_PROJECT, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY,
 * DF_AI_MODEL, DF_AI_EFFORT (optional).
 * Never prints a secret value.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { loadTenant } from '../tenant/load.ts'

const MGMT = 'https://api.supabase.com/v1'
const CF = 'https://api.cloudflare.com/client/v4'

/** Registers a value with the GitHub Actions log masker before it can appear anywhere. */
export function mask(value: string): string {
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${value}`)
  return value
}

/** URL-safe random secret: [A-Za-z0-9_-], safe inside connection strings and SQL literals. */
export const generateSecret = (bytes = 36): string => mask(randomBytes(bytes).toString('base64url'))

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

/** Writes NAME=value to $GITHUB_ENV for the following steps; secrets are masked in all logs first. */
export function exportEnv(name: string, value: string, secret: boolean): void {
  if (/[\r\n]/.test(value)) throw new Error(`${name}: multi-line values are not supported`)
  if (secret) mask(value)
  process.env[name] = value
  const file = process.env.GITHUB_ENV
  if (file) appendFileSync(file, `${name}=${value}\n`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function call<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    if (res.ok) return (text ? JSON.parse(text) : null) as T
    // Rate limits and transient gateway errors: back off and retry.
    if ((res.status === 429 || res.status >= 502) && attempt < 6) {
      await sleep(attempt * 5_000)
      continue
    }
    // Response bodies of these APIs never contain the caller's token; cap them anyway.
    throw new HttpError(res.status, `${method} ${base.includes('cloudflare') ? 'cloudflare' : 'supabase'}${path.replace(/\?.*/, '')} -> ${res.status}: ${text.slice(0, 500)}`)
  }
}

const supabase = <T>(method: string, path: string, body?: unknown) => call<T>(MGMT, need('SUPABASE_ACCESS_TOKEN'), method, path, body)
const cloudflare = async <T>(method: string, path: string, body?: unknown) =>
  (await call<{ result: T }>(CF, need('CLOUDFLARE_API_TOKEN'), method, path, body)).result

/** Runs SQL as the project's postgres role through the Management API (no database password needed). */
async function query<T = Record<string, unknown>>(ref: string, sql: string): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await supabase<T[]>('POST', `/projects/${ref}/database/query`, { query: sql })) ?? []
    } catch (err) {
      // Right after creation the database may still refuse connections.
      if (attempt < 10 && err instanceof HttpError && err.status >= 500) {
        await sleep(10_000)
        continue
      }
      throw err
    }
  }
}

interface Project {
  id: string
  ref: string
  name: string
  region: string
  status: string
  organization_slug?: string
}

async function ensureProject(): Promise<{ project: Project; dbPassword: string }> {
  const dbPassword = generateSecret(24)
  const given = process.env.SUPABASE_PROJECT_REF
  const name = process.env.DF_PROJECT_NAME || 'detailflow'
  let project: Project | undefined
  if (given) {
    project = await supabase<Project>('GET', `/projects/${given}`)
  } else {
    const all = (await supabase<Project[]>('GET', '/projects')).filter((p) => p.status !== 'REMOVED')
    console.log(`token sees ${all.length} Supabase project(s)`)
    project = all.find((p) => p.name.toLowerCase() === name.toLowerCase())
    // The operator may have created the project in the dashboard under another name: one project = that one.
    if (!project && all.length === 1) project = all[0]
    if (!project && all.length > 1) {
      throw new Error(`several Supabase projects (${all.map((p) => p.name).join(', ')}): set the repository variable SUPABASE_PROJECT_REF to the one to use`)
    }
  }
  if (!project) {
    type Org = { id: string; slug: string; name: string }
    const orgs = await supabase<Org[]>('GET', '/organizations')
    let org = process.env.SUPABASE_ORG_SLUG ? orgs.find((o) => o.slug === process.env.SUPABASE_ORG_SLUG) : orgs[0]
    if (!org && process.env.SUPABASE_ORG_SLUG) throw new Error(`organization ${process.env.SUPABASE_ORG_SLUG} is not available to this token`)
    // A brand-new account may have no organization yet.
    try {
      org ??= await supabase<Org>('POST', '/organizations', { name: 'DETAILFLOW' })
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        throw new Error('the Supabase account has no organization and this token may not create one: create it once at supabase.com/dashboard (New organization, Free plan), then re-run', { cause: err })
      }
      throw err
    }
    console.log(`creating Supabase project "${name}" in organization "${org.name}"`)
    project = await supabase<Project>('POST', '/projects', {
      name,
      organization_slug: org.slug,
      db_pass: dbPassword,
      region: process.env.DF_REGION || 'eu-central-1',
    })
    return { project: await waitHealthy(project.ref), dbPassword }
  }
  console.log(`using Supabase project "${project.name}" (${project.region})`)
  project = await waitHealthy(project.ref)
  // The postgres password is never stored: every run sets a fresh one and uses it only within the run.
  await supabase('PATCH', `/projects/${project.ref}/database/password`, { password: dbPassword })
  return { project, dbPassword }
}

async function waitHealthy(ref: string): Promise<Project> {
  const deadline = Date.now() + 20 * 60_000
  let restored = false
  for (;;) {
    const p = await supabase<Project>('GET', `/projects/${ref}`)
    if (p.status === 'ACTIVE_HEALTHY') return p
    if (p.status === 'INACTIVE' && !restored) {
      // Free-plan projects pause after a week without traffic.
      console.log('project is paused, restoring')
      await supabase('POST', `/projects/${ref}/restore`, {})
      restored = true
    }
    if (['INIT_FAILED', 'REMOVED', 'RESTORE_FAILED'].includes(p.status)) throw new Error(`project status ${p.status}`)
    if (Date.now() > deadline) throw new Error(`project not healthy after 20 min (status ${p.status})`)
    console.log(`waiting for the project (status ${p.status})`)
    await sleep(15_000)
  }
}

interface ApiKey {
  api_key: string | null
  type: 'legacy' | 'publishable' | 'secret' | null
  name: string
}

export function pickKeys(keys: ApiKey[]): { publishable: string; secret: string } {
  const by = (pred: (k: ApiKey) => boolean) => keys.find((k) => pred(k) && k.api_key)?.api_key ?? undefined
  const publishable = by((k) => k.type === 'publishable') ?? by((k) => k.type === 'legacy' && k.name === 'anon')
  const secret = by((k) => k.type === 'secret') ?? by((k) => k.type === 'legacy' && k.name === 'service_role')
  if (!publishable || !secret) throw new Error('project API keys not found')
  return { publishable, secret }
}

interface Pooler {
  database_type: string
  db_host: string
  db_name: string
  pool_mode: string
}

export function poolerUrls(p: { db_host: string; db_name: string }, ref: string, dbPassword: string, edgePassword: string) {
  return {
    // Session mode (5432): migrations, seed, verification — prepared statements allowed.
    admin: `postgres://postgres.${ref}:${dbPassword}@${p.db_host}:5432/${p.db_name}?sslmode=require`,
    // Transaction mode (6543): Edge Functions (prepare: false, every statement in a transaction).
    edge: `postgres://df_edge.${ref}:${edgePassword}@${p.db_host}:6543/${p.db_name}?sslmode=require`,
  }
}

async function ensurePagesProject(): Promise<{ accountId: string; project: string; url: string }> {
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) {
    const accounts = await cloudflare<Array<{ id: string; name: string }>>('GET', '/accounts')
    if (accounts.length === 0) throw new Error('CLOUDFLARE_API_TOKEN has no account access (needs Account > Cloudflare Pages > Edit)')
    accountId = accounts[0]!.id
  }
  const name = process.env.CF_PAGES_PROJECT || 'detailflow'
  let project: { name: string; subdomain: string }
  try {
    project = await cloudflare('GET', `/accounts/${accountId}/pages/projects/${name}`)
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err
    console.log(`creating Cloudflare Pages project "${name}"`)
    project = await cloudflare('POST', `/accounts/${accountId}/pages/projects`, { name, production_branch: 'main' })
  }
  return { accountId, project: project.name, url: `https://${project.subdomain}` }
}

const VAULT = {
  edgePassword: 'df_edge_password',
  manageSecret: 'df_manage_token_secret',
  dispatcherSecret: 'df_dispatcher_secret',
  projectUrl: 'df_project_url',
  iceOwnerPassword: 'df_smoke_ice_owner_password',
} as const

/** Reads a Vault secret, creating it with `make()` when absent (or replacing it when `value` is given). */
async function vaultSecret(ref: string, name: string, make: () => string, value?: string, secret = true): Promise<string> {
  const [row] = await query<{ id: string; secret: string }>(ref, `select id, decrypted_secret as secret from vault.decrypted_secrets where name = ${sqlLiteral(name)}`)
  if (row && secret) mask(row.secret)
  if (row && (value === undefined || row.secret === value)) return row.secret
  const v = value ?? make()
  if (row) await query(ref, `select vault.update_secret(${sqlLiteral(row.id)}::uuid, ${sqlLiteral(v)})`)
  else await query(ref, `select vault.create_secret(${sqlLiteral(v)}, ${sqlLiteral(name)}, 'DETAILFLOW (deploy workflow)')`)
  return v
}

function ownerEmail(slug: string): string {
  const t = loadTenant(slug)
  if (!t.ok) throw new Error(`${slug}: invalid business.json`)
  return t.business!.owners.find((o) => o.role === 'owner')!.email
}

async function prepare(): Promise<void> {
  const ownerPassword = need('DF_OWNER_PASSWORD')
  if (ownerPassword.length < 8) throw new Error('DF_OWNER_PASSWORD must be at least 8 characters')
  mask(ownerPassword)
  const { project, dbPassword } = await ensureProject()
  const ref = project.ref
  const apiUrl = `https://${ref}.supabase.co`
  const keys = pickKeys(await supabase<ApiKey[]>('GET', `/projects/${ref}/api-keys?reveal=true`))
  const poolers = await supabase<Pooler[]>('GET', `/projects/${ref}/config/database/pooler`)
  const pooler = poolers.find((p) => p.database_type === 'PRIMARY') ?? poolers[0]
  if (!pooler) throw new Error('no connection pooler configuration')
  const pages = await ensurePagesProject()

  const edgePassword = await vaultSecret(ref, VAULT.edgePassword, () => generateSecret(24))
  const manageSecret = await vaultSecret(ref, VAULT.manageSecret, () => generateSecret(48))
  const dispatcherSecret = await vaultSecret(ref, VAULT.dispatcherSecret, () => generateSecret(36))
  await vaultSecret(ref, VAULT.projectUrl, () => apiUrl, apiUrl, false)
  const icePassword = await vaultSecret(ref, VAULT.iceOwnerPassword, () => generateSecret(18))
  const urls = poolerUrls(pooler, ref, dbPassword, edgePassword)

  exportEnv('SUPABASE_PROJECT_REF', ref, false)
  exportEnv('PROD_SUPABASE_URL', apiUrl, false)
  exportEnv('VITE_SUPABASE_URL', apiUrl, false)
  exportEnv('VITE_SUPABASE_PUBLISHABLE_KEY', keys.publishable, false)
  exportEnv('PROD_SUPABASE_PUBLISHABLE_KEY', keys.publishable, false)
  exportEnv('SUPABASE_SERVICE_ROLE_KEY', keys.secret, true)
  exportEnv('AUTH_URL', `${apiUrl}/auth/v1`, false)
  exportEnv('DATABASE_URL', urls.admin, true)
  exportEnv('PROD_DATABASE_URL', urls.admin, true)
  exportEnv('DF_DB_URL', urls.edge, true)
  exportEnv('DF_EDGE_PASSWORD', edgePassword, true)
  exportEnv('DF_MANAGE_TOKEN_SECRET', manageSecret, true)
  exportEnv('DF_DISPATCHER_SECRET', dispatcherSecret, true)
  exportEnv('CLOUDFLARE_ACCOUNT_ID', pages.accountId, false)
  exportEnv('CF_PAGES_PROJECT', pages.project, false)
  exportEnv('DF_APP_URL', pages.url, false)
  exportEnv('PROD_APP_URL', pages.url, false)
  exportEnv('DF_ALLOWED_ORIGINS', pages.url, false)
  exportEnv('PROD_GRAPHITE_OWNER_EMAIL', ownerEmail('graphite'), false)
  exportEnv('PROD_GRAPHITE_OWNER_PASSWORD', ownerPassword, true)
  exportEnv('DF_OWNER_PASSWORD_GRAPHITE', ownerPassword, true)
  exportEnv('PROD_ICE_OWNER_EMAIL', ownerEmail('ice-lab'), false)
  exportEnv('PROD_ICE_OWNER_PASSWORD', icePassword, true)
  exportEnv('DF_OWNER_PASSWORD_ICE_LAB', icePassword, true)
  console.log(`Supabase project ${ref} ready; app URL ${pages.url}`)
}

async function configure(): Promise<void> {
  const ref = need('SUPABASE_PROJECT_REF')
  const app = need('DF_APP_URL')

  // Least-privilege role used by the functions (created by migration 0005 without LOGIN).
  await query(ref, `alter role df_edge with login password ${sqlLiteral(need('DF_EDGE_PASSWORD'))}`)

  // Staff accounts are invited only; no self-signup, no anonymous users.
  await supabase('PATCH', `/projects/${ref}/config/auth`, {
    site_url: app,
    uri_allow_list: `${app}/**`,
    disable_signup: true,
    external_anonymous_users_enabled: false,
    external_email_enabled: true,
  })

  const secrets: Array<{ name: string; value: string }> = [
    { name: 'DF_DB_URL', value: need('DF_DB_URL') },
    { name: 'DF_MANAGE_TOKEN_SECRET', value: need('DF_MANAGE_TOKEN_SECRET') },
    { name: 'DF_DISPATCHER_SECRET', value: need('DF_DISPATCHER_SECRET') },
    { name: 'DF_ALLOWED_ORIGINS', value: need('DF_ALLOWED_ORIGINS') },
    { name: 'DF_APP_URL', value: app },
  ]
  for (const optional of ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'DF_AI_MODEL', 'DF_AI_EFFORT', 'DF_TRUSTED_PROXY_HOPS']) {
    const v = process.env[optional]
    if (v) secrets.push({ name: optional, value: v })
  }
  await supabase('POST', `/projects/${ref}/secrets`, secrets)
  console.log(`function secrets set: ${secrets.map((s) => s.name).join(', ')}`)

  // Notification dispatcher every minute: pg_cron + pg_net, URL and secret read from Vault.
  await query(ref, 'create extension if not exists pg_cron; create extension if not exists pg_net;')
  await query(ref, `
    select cron.unschedule(jobid) from cron.job where jobname = 'df-notify-dispatcher';
    select cron.schedule('df-notify-dispatcher', '* * * * *', $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = '${VAULT.projectUrl}') || '/functions/v1/notify-dispatcher',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-dispatcher-secret', (select decrypted_secret from vault.decrypted_secrets where name = '${VAULT.dispatcherSecret}')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
      );
    $cron$);`)
  console.log('dispatcher scheduled (every minute)')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const step = process.argv[2]
  const run = step === 'prepare' ? prepare : step === 'configure' ? configure : null
  if (!run) {
    console.error('usage: provision.ts prepare|configure')
    process.exit(2)
  }
  run().catch((err: unknown) => {
    console.error(`provision ${step} failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
