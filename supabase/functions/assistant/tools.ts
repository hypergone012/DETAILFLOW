import type Anthropic from '@anthropic-ai/sdk'
import {
  CATEGORY_LABELS,
  SERVICE_CATEGORIES,
  VEHICLE_CLASSES,
  formatDuration,
  formatPriceFrom,
  resolveVariant,
  type Storefront,
  type VehicleClass,
} from '@detailflow/domain'
import { z } from 'zod'
import { availabilityDays, loadEngineContext, requireOfferedSlot } from '../_shared/booking-core.ts'
import type { Sql } from '../_shared/db.ts'
import { HttpError } from '../_shared/http.ts'

/**
 * The complete allowlist of what the assistant can do. Every tool is
 * read-only and bound to the tenant resolved by the server from the URL slug:
 * no tool accepts a tenant, a price, a duration or SQL, and unknown input keys
 * are rejected. Prices and durations come from the database via the domain
 * engine, never from the model.
 */
export interface ToolContext {
  sql: Sql
  tenantId: string
  storefront: Storefront
  now: () => Date
}

export interface BookingDraft {
  serviceSlug: string
  serviceName: string
  vehicleClass: VehicleClass
  startAt: string
  endAt: string
  priceFromMinor: number
  durationMin: number
}

export interface ToolOutcome {
  content: string
  isError: boolean
  draft?: BookingDraft
}

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const INPUTS = {
  list_services: z.strictObject({ category: z.enum(SERVICE_CATEGORIES).nullable() }),
  get_service: z.strictObject({ service_slug: z.string().max(80) }),
  get_studio_info: z.strictObject({}),
  check_availability: z.strictObject({ service_slug: z.string().max(80), vehicle_class: z.enum(VEHICLE_CLASSES), date_from: localDate, date_to: localDate }),
  prepare_booking_draft: z.strictObject({ service_slug: z.string().max(80), vehicle_class: z.enum(VEHICLE_CLASSES), start_at: z.iso.datetime({ offset: true }) }),
  handoff_to_human: z.strictObject({ reason: z.string().max(300) }),
} as const
export type ToolName = keyof typeof INPUTS

const str = { type: 'string' } as const
const slug = { type: 'string', description: 'slug услуги из list_services' } as const
const vehicleClass = { type: 'string', enum: [...VEHICLE_CLASSES], description: 'класс автомобиля клиента' } as const

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_services',
    description: 'Каталог услуг этой студии: slug, название, цена «от», длительность. Можно отфильтровать по категории.',
    strict: true,
    input_schema: { type: 'object', properties: { category: { type: ['string', 'null'], enum: [...SERVICE_CATEGORIES, null] } }, required: ['category'], additionalProperties: false },
  },
  {
    name: 'get_service',
    description: 'Подробности услуги: описание, требования к подготовке, цены и длительность по классам автомобилей.',
    strict: true,
    input_schema: { type: 'object', properties: { service_slug: slug }, required: ['service_slug'], additionalProperties: false },
  },
  {
    name: 'get_studio_info',
    description: 'Адрес, часы работы, телефон, правила отмены и переноса этой студии.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'check_availability',
    description: 'Свободное время для услуги и класса авто в диапазоне дат (не более 7 дней). Даты — YYYY-MM-DD по времени студии.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { service_slug: slug, vehicle_class: vehicleClass, date_from: str, date_to: str },
      required: ['service_slug', 'vehicle_class', 'date_from', 'date_to'],
      additionalProperties: false,
    },
  },
  {
    name: 'prepare_booking_draft',
    description: 'Проверяет, что время свободно, и готовит черновик записи. НЕ создаёт запись: клиент подтверждает её сам в форме записи.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { service_slug: slug, vehicle_class: vehicleClass, start_at: { type: 'string', description: 'startAt из check_availability (ISO 8601)' } },
      required: ['service_slug', 'vehicle_class', 'start_at'],
      additionalProperties: false,
    },
  },
  {
    name: 'handoff_to_human',
    description: 'Передать вопрос сотруднику студии: вернёт контакты. Используй для вопросов вне компетенции, жалоб и нестандартных случаев.',
    strict: true,
    input_schema: { type: 'object', properties: { reason: str }, required: ['reason'], additionalProperties: false },
  },
]

export function isAllowedTool(name: string): name is ToolName {
  return Object.hasOwn(INPUTS, name)
}

function serviceBySlug(ctx: ToolContext, serviceSlug: string) {
  const s = ctx.storefront.services.find((x) => x.slug === serviceSlug)
  if (!s) throw new ToolError(`Услуга «${serviceSlug}» не найдена в этой студии. Используй list_services.`)
  return s
}

class ToolError extends Error {}

export async function executeTool(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  if (!isAllowedTool(name)) return { content: `Инструмент ${name} недоступен.`, isError: true }
  const parsed = INPUTS[name].safeParse(rawInput)
  if (!parsed.success) {
    return { content: `Некорректные параметры: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`, isError: true }
  }
  const input = parsed.data as Record<string, unknown>
  const sf = ctx.storefront
  try {
    switch (name) {
      case 'list_services': {
        const list = sf.services.filter((s) => !input.category || s.category === input.category)
        return { isError: false, content: JSON.stringify(list.map((s) => ({
          slug: s.slug, name: s.name, category: CATEGORY_LABELS[s.category], price: formatPriceFrom(s.price_from_minor),
          duration: formatDuration(s.duration_min, s.multi_day), summary: s.summary, multi_day: s.multi_day,
        }))) }
      }
      case 'get_service': {
        const s = serviceBySlug(ctx, input.service_slug as string)
        return { isError: false, content: JSON.stringify({
          slug: s.slug, name: s.name, description: s.description, requirements: s.requirements,
          base: { price: formatPriceFrom(s.price_from_minor), duration: formatDuration(s.duration_min, s.multi_day) },
          by_vehicle_class: s.variants.map((v) => ({ vehicle_class: v.vehicle_class, price: formatPriceFrom(v.price_from_minor), duration: formatDuration(v.duration_min, s.multi_day) })),
          multi_day: s.multi_day, requires_confirmation: s.requires_confirmation,
          note: 'Цены «от»: итог мастер называет после осмотра.',
        }) }
      }
      case 'get_studio_info':
        return { isError: false, content: JSON.stringify({
          name: sf.tenant.name, address: sf.profile.address, phone: sf.profile.phone_display, timezone: sf.tenant.timezone,
          hours: sf.hours, cancel_cutoff_hours: sf.policy.cancel_cutoff_hours, min_notice_min: sf.policy.min_notice_min,
          telegram: sf.profile.telegram_url, whatsapp: sf.profile.whatsapp_url,
        }) }
      case 'check_availability': {
        const s = serviceBySlug(ctx, input.service_slug as string)
        const from = input.date_from as string
        const to = input.date_to as string
        if (to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 7) throw new ToolError('Диапазон — не больше 7 дней.')
        const engine = await loadEngineContext(ctx.sql, ctx.tenantId, s.id, input.vehicle_class as VehicleClass, { now: ctx.now() })
        const days = availabilityDays(engine, from, to)
        return { isError: false, content: JSON.stringify({
          timezone: engine.input.timezone,
          price: formatPriceFrom(engine.priceFromMinor),
          duration: formatDuration(engine.durationMin, s.multi_day),
          days: days.map((d) => ({ date: d.date, open: d.open, slots: d.slots.slice(0, 12).map((x) => ({ time: x.time, startAt: x.startAt })) })),
        }) }
      }
      case 'prepare_booking_draft': {
        const s = serviceBySlug(ctx, input.service_slug as string)
        const cls = input.vehicle_class as VehicleClass
        const engine = await loadEngineContext(ctx.sql, ctx.tenantId, s.id, cls, { now: ctx.now() })
        const slot = requireOfferedSlot(engine, input.start_at as string)
        const priced = resolveVariant(
          { durationMin: s.duration_min, priceFromMinor: s.price_from_minor },
          s.variants.map((v) => ({ vehicleClass: v.vehicle_class, durationMin: v.duration_min, priceFromMinor: v.price_from_minor })),
          cls,
        )
        const draft: BookingDraft = {
          serviceSlug: s.slug, serviceName: s.name, vehicleClass: cls,
          startAt: slot.start.toISOString(), endAt: slot.end.toISOString(),
          priceFromMinor: priced.priceFromMinor, durationMin: priced.durationMin,
        }
        return { isError: false, draft, content: JSON.stringify({ ok: true, draft_shown_to_customer: true, price: formatPriceFrom(draft.priceFromMinor), note: 'Клиент увидит карточку и подтвердит запись сам.' }) }
      }
      case 'handoff_to_human':
        return { isError: false, content: JSON.stringify({ phone: sf.profile.phone_display, telegram: sf.profile.telegram_url, whatsapp: sf.profile.whatsapp_url }) }
    }
  } catch (err) {
    if (err instanceof ToolError) return { content: err.message, isError: true }
    if (err instanceof HttpError) return { content: err.message, isError: true }
    throw err
  }
  return { content: 'unreachable', isError: true }
}
