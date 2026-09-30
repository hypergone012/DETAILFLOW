import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { migrate } from '../../scripts/db/migrate.ts'

const ROOT = join(import.meta.dirname, '../..')
export const TEST_DB = process.env.DF_TEST_DB ?? 'df_test'

/**
 * Fresh database for every run: Supabase platform bootstrap + real Supabase Auth
 * migrations (GoTrue binary) + project migrations. No mocks of Postgres or RLS.
 */
export default async function setup(project: TestProject): Promise<void> {
  const port = process.env.DF_PG_PORT ?? '54322'
  execFileSync(join(ROOT, 'scripts/local/stack.sh'), ['createdb', TEST_DB], { stdio: 'pipe' })
  const url = `postgres://postgres@127.0.0.1:${port}/${TEST_DB}`
  await migrate(url, () => {})
  project.provide('databaseUrl', url)
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}
