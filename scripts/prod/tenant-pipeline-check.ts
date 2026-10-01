/**
 * Connecting a new studio without touching the core, checked end to end against
 * a deployed environment (or the local stack), then removed again:
 *
 *   new (from tenants/_template) -> validate -> seed (draft, not public)
 *   -> invite owner (Supabase Auth invite link) -> owner accepts and sets a
 *   password -> owner API sees exactly this studio -> activate refused while the
 *   template's demo artwork is in place -> activate -> public storefront + app page
 *   -> cleanup (tenant rows and the owner's auth user).
 *
 * The throwaway studio "pipeline-check" passes the artwork gate only by declaring
 * its (template) artwork final; that is the one step a real studio does by
 * replacing assets/. Report: docs/smoke/tenant-pipeline-<label>.json.
 *
 * Env: DATABASE_URL, AUTH_URL, SUPABASE_SERVICE_ROLE_KEY (hosted), PROD_SUPABASE_URL,
 * PROD_SUPABASE_PUBLISHABLE_KEY, PROD_APP_URL (optional page check), SMOKE_LABEL.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import type { Business } from '@detailflow/config'
import { LOCAL, env } from '../lib/env.ts'
import { adminHeaders, serviceRoleKey } from '../lib/gotrue.ts'
import { TENANTS_DIR, loadTenant } from '../tenant/load.ts'
import { activate, createTenantFromTemplate, inviteOwner } from '../tenant/pipeline.ts'
import { seedTenant } from '../tenant/seed.ts'

const SLUG = 'pipeline-check'
const label = process.env.SMOKE_LABEL ?? 'production'
const api = env('PROD_SUPABASE_URL', 'http://127.0.0.1:54321')
const apikey = process.env.PROD_SUPABASE_PUBLISHABLE_KEY ?? ''
const authUrl = env('AUTH_URL', LOCAL.authUrl)
const steps: Array<{ step: string; ok: boolean; detail?: string }> = []

function record(step: string, ok: boolean, detail?: string): void {
  steps.push({ step, ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`)
  if (!ok) throw new Error(`${step} failed`)
}

const publicGet = (path: string) => fetch(`${api}/functions/v1/public-api/${path}`, { headers: apikey ? { apikey } : {} })

async function cleanup(sql: postgres.Sql, userIds: string[]): Promise<void> {
  await sql`delete from public.tenants where slug = ${SLUG}`
  const key = await serviceRoleKey()
  for (const id of userIds) await fetch(`${authUrl}/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders(key) })
}

async function main(): Promise<void> {
  const sql = postgres(env('DATABASE_URL', LOCAL.databaseUrl), { max: 2, onnotice: () => {} })
  const dir = mkdtempSync(join(tmpdir(), 'df-tenants-'))
  const users: string[] = []
  try {
    // A previous interrupted run must not leave anything behind.
    const stale = await sql<{ user_id: string }[]>`select m.user_id from public.tenant_members m join public.tenants t on t.id = m.tenant_id where t.slug = ${SLUG}`
    await cleanup(sql, stale.map((r) => r.user_id))

    cpSync(join(TENANTS_DIR, '_template'), join(dir, '_template'), { recursive: true })
    createTenantFromTemplate({ slug: SLUG, name: 'Pipeline Check', timezone: 'Asia/Novosibirsk', accent: '#7fd18b', dir })
    record('new from template', true, 'Asia/Novosibirsk, accent #7fd18b')

    const loaded = loadTenant(SLUG, dir)
    record('validate business.json', loaded.ok, loaded.ok ? undefined : loaded.errors.join('; '))

    await seedTenant(sql, loaded.business!)
    record('seed as draft', (await publicGet(`storefront/${SLUG}`)).status === 404, 'draft studio is not public (404)')

    const email = `owner+${Date.now()}@${SLUG}.test`
    const invite = await inviteOwner(sql, SLUG, email)
    users.push(invite.userId)
    const tokenHash = invite.acceptLink ? new URL(invite.acceptLink).searchParams.get('token_hash') : null
    record('owner invite link', !!tokenHash && invite.acceptLink!.includes(`/s/${SLUG}/owner/accept?`))

    // What the accept page does: verify the one-time token, then set a password.
    const verified = await fetch(`${authUrl}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apikey ? { apikey } : {}) },
      body: JSON.stringify({ type: 'invite', token_hash: tokenHash }),
    })
    const session = (await verified.json()) as { access_token?: string }
    record('owner accepts the invite', verified.ok && !!session.access_token)
    const password = `pc-${Math.random().toString(36).slice(2)}-${Date.now()}`
    const setPw = await fetch(`${authUrl}/user`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}`, ...(apikey ? { apikey } : {}) },
      body: JSON.stringify({ password }),
    })
    record('owner sets a password', setPw.ok)
    const replay = await fetch(`${authUrl}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apikey ? { apikey } : {}) },
      body: JSON.stringify({ type: 'invite', token_hash: tokenHash }),
    })
    record('invite link cannot be reused', !replay.ok)
    const login = await fetch(`${authUrl}/token?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apikey ? { apikey } : {}) },
      body: JSON.stringify({ email, password }),
    })
    const token = ((await login.json()) as { access_token?: string }).access_token
    record('owner logs in with the password', login.ok && !!token)
    const me = (await (await fetch(`${api}/functions/v1/owner-api/me`, { headers: { authorization: `Bearer ${token}`, ...(apikey ? { apikey } : {}) } })).json()) as { memberships?: Array<{ slug: string }> }
    const slugs = (me.memberships ?? []).map((m) => m.slug)
    record('owner API: membership of exactly this studio', slugs.length === 1 && slugs[0] === SLUG, slugs.join(','))
    const foreign = await fetch(`${api}/functions/v1/owner-api/graphite/bookings`, { headers: { authorization: `Bearer ${token}`, ...(apikey ? { apikey } : {}) } })
    record('owner API: other studio is 404', foreign.status === 404)

    const refused = await activate(sql, SLUG, dir)
    record('activate refused with template artwork', !refused.ok && refused.problems.some((p) => p.includes('demoArtwork')), refused.problems.join('; '))

    // The real-studio step: own photos in assets/ and demoArtwork=false (here: the throwaway studio declares them final).
    const path = join(dir, SLUG, 'business.json')
    const b = JSON.parse(readFileSync(path, 'utf8')) as Business
    b.branding.demoArtwork = false
    b.contacts.phone ??= '+73832000000'
    writeFileSync(path, JSON.stringify(b, null, 2) + '\n')
    await seedTenant(sql, loadTenant(SLUG, dir).business!)
    const activated = await activate(sql, SLUG, dir)
    record('activate', activated.ok, activated.problems.join('; '))
    const store = await publicGet(`storefront/${SLUG}`)
    const body = (await store.json()) as { tenant?: { status: string; timezone: string } }
    record('published: public storefront', store.status === 200 && body.tenant?.status === 'active' && body.tenant.timezone === 'Asia/Novosibirsk')
    if (process.env.PROD_APP_URL) {
      const page = await fetch(`${process.env.PROD_APP_URL}/s/${SLUG}`)
      record('published: app page served', page.status === 200)
    }
  } finally {
    await cleanup(sql, users).catch((err: unknown) => console.error('cleanup failed', err))
    const [left] = await sql`select count(*)::int as n from public.tenants where slug = ${SLUG}`
    steps.push({ step: 'cleanup', ok: left!.n === 0 })
    await sql.end()
    rmSync(dir, { recursive: true, force: true })
    const out = join(import.meta.dirname, '../../docs/smoke')
    mkdirSync(out, { recursive: true })
    const passed = steps.every((s) => s.ok)
    writeFileSync(join(out, `tenant-pipeline-${label}.json`), JSON.stringify({ label, at: new Date().toISOString(), passed, steps }, null, 2) + '\n')
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
