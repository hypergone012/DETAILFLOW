/**
 * pnpm tenant <command>:
 *   new <slug> --name "…" [--tz Europe/Moscow] [--accent #rrggbb]
 *   validate [slug…|--all]
 *   invite-owner <slug> <email> [--role owner|manager|staff]
 *   activate <slug>
 *   export <slug>             (writes tenants/<slug>/business.export.json)
 * Seeding: pnpm tenant:seed <slug…|--all>
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { LOCAL, env } from '../lib/env.ts'
import { TENANTS_DIR, loadTenant, tenantSlugs } from './load.ts'
import { activate, createTenantFromTemplate, exportTenant, inviteOwner } from './pipeline.ts'

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'))
const db = () => postgres(env('DATABASE_URL', LOCAL.databaseUrl), { max: 2, onnotice: () => {} })

async function main(): Promise<number> {
  switch (command) {
    case 'new': {
      const [slug] = positional
      const name = flag('name')
      if (!slug || !name) throw new Error('usage: tenant new <slug> --name "Studio"')
      const dir = createTenantFromTemplate({ slug, name, ...(flag('tz') ? { timezone: flag('tz')! } : {}), ...(flag('accent') ? { accent: flag('accent')! } : {}) })
      console.log(`created ${dir}\nnext: edit business.json and assets/, then: pnpm tenant validate ${slug}`)
      return 0
    }
    case 'validate': {
      const slugs = rest.includes('--all') || positional.length === 0 ? tenantSlugs() : positional
      let failed = 0
      for (const slug of slugs) {
        const r = loadTenant(slug)
        console.log(r.ok ? `✓ ${slug}` : `✗ ${slug}\n  ${r.errors.join('\n  ')}`)
        if (!r.ok) failed += 1
      }
      return failed ? 1 : 0
    }
    case 'invite-owner': {
      const [slug, email] = positional
      if (!slug || !email) throw new Error('usage: tenant invite-owner <slug> <email>')
      const sql = db()
      try {
        const r = await inviteOwner(sql, slug, email, (flag('role') as 'owner' | undefined) ?? 'owner')
        console.log(`member ${email} (${r.userId})${r.acceptLink ? `\ninvite link (send to the owner, single use): ${r.acceptLink}` : ' already registered'}`)
      } finally {
        await sql.end()
      }
      return 0
    }
    case 'activate': {
      const [slug] = positional
      if (!slug) throw new Error('usage: tenant activate <slug>')
      const sql = db()
      try {
        const r = await activate(sql, slug)
        for (const w of r.warnings) console.log(`! ${w}`)
        if (!r.ok) {
          console.log(`✗ ${slug} not activated:\n  ${r.problems.join('\n  ')}`)
          return 1
        }
        console.log(`✓ ${slug} is live`)
        return 0
      } finally {
        await sql.end()
      }
    }
    case 'export': {
      const [slug] = positional
      if (!slug) throw new Error('usage: tenant export <slug>')
      const loaded = loadTenant(slug)
      if (!loaded.business) throw new Error(`tenants/${slug}/business.json is invalid:\n  ${loaded.errors.join('\n  ')}`)
      const sql = db()
      try {
        const out = await exportTenant(sql, slug, loaded.business)
        const path = join(TENANTS_DIR, slug, 'business.export.json')
        writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
        console.log(`wrote ${path}`)
      } finally {
        await sql.end()
      }
      return 0
    }
    default:
      console.log('usage: tenant <new|validate|invite-owner|activate|export> …')
      return 2
  }
}

main().then((code) => process.exit(code), (err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
