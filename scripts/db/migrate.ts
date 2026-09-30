/**
 * Applies supabase/migrations/*.sql in order and records them in
 * supabase_migrations.schema_migrations (same table the Supabase CLI uses),
 * so a database migrated locally is compatible with `supabase db push`.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations')

export async function migrate(databaseUrl: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key, statements text[], name text
      );`)
    const applied = new Set(
      (await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations`).map((r) => r.version),
    )
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()
    const done: string[] = []
    for (const file of files) {
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_')
      if (!version || applied.has(version)) continue
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      await sql.begin(async (tx) => {
        await tx.unsafe(body)
        await tx`insert into supabase_migrations.schema_migrations (version, name) values (${version}, ${rest.join('_')})`
      })
      log(`applied ${file}`)
      done.push(file)
    }
    return done
  } finally {
    await sql.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54322/postgres_df'
  migrate(url).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
