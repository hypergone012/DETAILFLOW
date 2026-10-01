/**
 * Waits until the scheduled notification dispatcher (pg_cron -> pg_net ->
 * notify-dispatcher) answers 200 after this deploy, and prints the recent
 * call results. Fails with the observed statuses if it does not within 4 min.
 * Env: DATABASE_URL (postgres role).
 */
import postgres from 'postgres'
import { env } from '../lib/env.ts'

const sql = postgres(env('DATABASE_URL'), { max: 1, onnotice: () => {} })
const started = new Date()
let ok = false
try {
  for (let i = 0; i < 24 && !ok; i++) {
    const rows = await sql<{ status_code: number | null; error_msg: string | null; created: Date }[]>`
      select status_code, error_msg, created from net._http_response where created > ${started} order by created desc limit 3`
    ok = rows.some((r) => r.status_code === 200)
    if (rows.length) console.log(`dispatcher calls since deploy: ${rows.map((r) => r.status_code ?? r.error_msg?.slice(0, 80) ?? '?').join(', ')}`)
    if (!ok) await new Promise((r) => setTimeout(r, 10_000))
  }
  const [job] = await sql<{ active: boolean; schedule: string }[]>`select active, schedule from cron.job where jobname = 'df-notify-dispatcher'`
  console.log(`cron job: ${job ? `${job.schedule} active=${job.active}` : 'missing'}`)
} finally {
  await sql.end()
}
console.log(ok ? 'PASS  dispatcher answers 200 on schedule' : 'FAIL  dispatcher did not answer 200 within 4 minutes')
process.exit(ok ? 0 : 1)
