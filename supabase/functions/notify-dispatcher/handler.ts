import { type Sql } from '../_shared/db.ts'
import { HttpError, errorResponse, json } from '../_shared/http.ts'
import { dispatchOutbox, type NotificationProvider } from '../_shared/notifications.ts'

export interface DispatcherDeps {
  sql: Sql
  provider: NotificationProvider | null
  appUrl: string
  secret: string
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

/** Invoked by a scheduler (Supabase cron / pg_net) with the shared secret header. */
export function createDispatcher(deps: DispatcherDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((msg, extra) => console.error(JSON.stringify({ fn: 'notify-dispatcher', msg, ...extra })))
  return async (req) => {
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'NOT_FOUND')
      if (req.headers.get('x-dispatcher-secret') !== deps.secret) throw new HttpError(401, 'UNAUTHORIZED')
      const summary = await dispatchOutbox(deps.sql, { provider: deps.provider, appUrl: deps.appUrl })
      if (summary.claimed) log('dispatched', { ...summary })
      return json(summary)
    } catch (err) {
      return errorResponse(err, log)
    }
  }
}
