/**
 * Fails if the built frontend contains anything that must stay server-side:
 * Supabase secret/service keys, Anthropic keys, Telegram bot tokens, DB URLs,
 * server-only env names. Run after `pnpm build` (CI does).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = join(import.meta.dirname, '../../apps/web/dist')

const RULES: Array<[string, RegExp]> = [
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{10,}/],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['Postgres URL', /postgres(ql)?:\/\/[^\s"'`]+@/],
  ['server-only env name', /\b(SUPABASE_SERVICE_ROLE_KEY|DF_MANAGE_TOKEN_SECRET|DF_DISPATCHER_SECRET|TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY|DF_DB_URL|DF_JWT_SECRET)\b/],
]

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

/** JWTs embedded in the bundle must never carry role=service_role. */
function serviceRoleJwts(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
    try {
      const claims = JSON.parse(Buffer.from(m[1]!, 'base64url').toString()) as { role?: string }
      if (claims.role === 'service_role') found.push(m[0].slice(0, 20) + '…')
    } catch {
      // not a JWT
    }
  }
  return found
}

const problems: string[] = []
for (const file of files(DIST).filter((f) => /\.(js|html|css|json|webmanifest|map)$/.test(f) || f.endsWith('_headers'))) {
  const text = readFileSync(file, 'utf8')
  for (const [name, re] of RULES) if (re.test(text)) problems.push(`${name} in ${file.replace(DIST, 'dist')}`)
  for (const jwt of serviceRoleJwts(text)) problems.push(`service_role JWT ${jwt} in ${file.replace(DIST, 'dist')}`)
}
if (problems.length) {
  console.error(`bundle secret scan FAILED:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`bundle secret scan: clean (${files(DIST).length} files)`)
