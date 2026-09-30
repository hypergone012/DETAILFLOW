import { STATUS_LABELS, formatPriceFrom, type BookingStatus } from '@detailflow/domain'
import { asService, type Sql } from './db.ts'

/** Channel-agnostic contract. Telegram is the first real implementation. */
export interface NotificationProvider {
  readonly channel: 'telegram'
  send(target: string, text: string): Promise<SendResult>
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; error: string; retryAfterSec?: number }

/** Telegram Bot API sendMessage (https://core.telegram.org/bots/api#sendmessage). */
export class TelegramProvider implements NotificationProvider {
  readonly channel = 'telegram' as const
  constructor(
    private readonly botToken: string,
    private readonly apiBase = 'https://api.telegram.org',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The bot token is part of the URL: scrub it from anything that could be stored or logged. */
  private redact(message: string): string {
    return message.split(this.botToken).join('<redacted>').replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>')
  }

  async send(chatId: string, text: string): Promise<SendResult> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.apiBase}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      return { ok: false, retryable: true, error: this.redact(`network: ${err instanceof Error ? err.message : String(err)}`) }
    }
    const body = (await res.json().catch(() => null)) as
      | { ok: true; result: { message_id: number } }
      | { ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number } }
      | null
    if (body?.ok) return { ok: true, providerMessageId: String(body.result.message_id) }
    const description = this.redact(body && !body.ok ? body.description ?? `HTTP ${res.status}` : `HTTP ${res.status}`)
    const retryAfter = body && !body.ok ? body.parameters?.retry_after : undefined
    return {
      ok: false,
      // 4xx other than 429 (bad chat id, bot blocked) will not fix themselves.
      retryable: res.status === 429 || res.status >= 500,
      error: description,
      ...(retryAfter !== undefined ? { retryAfterSec: retryAfter } : {}),
    }
  }
}

export interface OutboxRow {
  id: string
  event: string
  attempts: number
  tenant_slug: string
  tenant_name: string
  tenant_status: 'draft' | 'demo' | 'active' | 'suspended'
  timezone: string
  telegram_chat_id: string | null
  booking: {
    booking_id: string
    ref_code: string
    status: BookingStatus
    start_at: string
    end_at: string
    service_name: string
    multi_day: boolean
    price_from_minor: number
    contact_name: string
    contact_phone_e164: string
    vehicle: { make: string; model: string; plate: string | null }
    is_demo: boolean
  } | null
}

const EVENT_TITLES: Record<string, string> = {
  'booking.created': 'Новая запись',
  'booking.confirmed': 'Запись подтверждена',
  'booking.cancelled': 'Запись отменена',
  'booking.rescheduled': 'Запись перенесена',
}

export function formatNotification(row: OutboxRow, appUrl: string): string {
  const b = row.booking
  if (!b) return `${EVENT_TITLES[row.event] ?? row.event} · ${row.tenant_name}`
  const when = new Intl.DateTimeFormat('ru-RU', { timeZone: row.timezone, weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(b.start_at))
  return [
    `${EVENT_TITLES[row.event] ?? row.event} · ${b.ref_code}`,
    b.service_name,
    `${when}${b.multi_day ? ' (сдача авто)' : ''}`,
    `${b.vehicle.make} ${b.vehicle.model}${b.vehicle.plate ? ` · ${b.vehicle.plate}` : ''}`,
    `${b.contact_name}, ${b.contact_phone_e164}`,
    `${formatPriceFrom(Number(b.price_from_minor))} · ${STATUS_LABELS[b.status]}`,
    `${appUrl}/s/${row.tenant_slug}/owner/bookings/${b.booking_id}`,
  ].join('\n')
}

export type Decision =
  | { action: 'suppress_demo' }
  | { action: 'not_configured'; reason: string }
  | { action: 'send'; target: string }

/** Demo is checked first and unconditionally: a demo tenant never reaches a provider. */
export function decide(row: OutboxRow, provider: NotificationProvider | null): Decision {
  if (row.tenant_status === 'demo' || row.booking?.is_demo) return { action: 'suppress_demo' }
  if (!provider) return { action: 'not_configured', reason: 'TELEGRAM_BOT_TOKEN is not set' }
  if (!row.telegram_chat_id) return { action: 'not_configured', reason: 'studio has no Telegram chat id' }
  return { action: 'send', target: row.telegram_chat_id }
}

export const MAX_ATTEMPTS = 5

export interface DispatchSummary {
  claimed: number
  sent: number
  suppressed_demo: number
  not_configured: number
  retry: number
  failed: number
}

export async function dispatchOutbox(
  sql: Sql,
  opts: { provider: NotificationProvider | null; appUrl: string; limit?: number; now?: () => Date },
): Promise<DispatchSummary> {
  const now = opts.now ?? (() => new Date())
  const rows = await asService(sql, (tx) => tx<OutboxRow[]>`select * from private.claim_notifications(${opts.limit ?? 50})`)
  const summary: DispatchSummary = { claimed: rows.length, sent: 0, suppressed_demo: 0, not_configured: 0, retry: 0, failed: 0 }
  for (const row of rows) {
    const decision = decide(row, opts.provider)
    let status: 'sent' | 'failed' | 'suppressed_demo' | 'not_configured' | 'pending'
    let error: string | null = null
    let messageId: string | null = null
    let retryAt: Date | null = null
    if (decision.action === 'suppress_demo') {
      status = 'suppressed_demo'
    } else if (decision.action === 'not_configured') {
      status = 'not_configured'
      error = decision.reason
    } else {
      const result = await opts.provider!.send(decision.target, formatNotification(row, opts.appUrl))
      if (result.ok) {
        status = 'sent'
        messageId = result.providerMessageId
      } else if (result.retryable && row.attempts < MAX_ATTEMPTS) {
        status = 'pending'
        error = result.error
        const backoffSec = result.retryAfterSec ?? 30 * 2 ** (row.attempts - 1)
        retryAt = new Date(now().getTime() + backoffSec * 1000)
      } else {
        status = 'failed'
        error = result.error
      }
    }
    await asService(sql, (tx) => tx`select private.complete_notification(${row.id}, ${status}::public.notification_status, ${error}, ${messageId}, ${retryAt})`)
    if (status === 'pending') summary.retry += 1
    else summary[status] += 1
  }
  return summary
}
