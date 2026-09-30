/**
 * Copies packages/domain/src (runtime files only) into
 * supabase/functions/_vendor/domain so every Edge Function import stays inside
 * supabase/functions — what the Supabase CLI bundles on deploy. Generated,
 * git-ignored; run by functions:check / functions:serve / deploy.
 */
import { cpSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '../../packages/domain/src')
const OUT = join(import.meta.dirname, '../../supabase/functions/_vendor/domain')
rmSync(OUT, { recursive: true, force: true })
cpSync(SRC, OUT, { recursive: true, filter: (p) => !p.endsWith('.test.ts') })
console.log(`vendored @detailflow/domain (${readdirSync(OUT).length} files)`)
