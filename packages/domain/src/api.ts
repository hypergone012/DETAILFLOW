import { z } from 'zod'
import { SERVICE_CATEGORIES, VEHICLE_CLASSES } from './catalog.ts'
import { BOOKING_STATUSES } from './status.ts'

/**
 * Wire contracts shared by the web app and the Edge Functions.
 * Request schemas are strict: unknown keys (tenant_id, price, status, …) are
 * rejected with 400 instead of being silently ignored.
 */

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const instant = z.iso.datetime({ offset: true })

export const vehicleInputSchema = z.strictObject({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  year: z.number().int().min(1950).max(2100).nullable(),
  color: z.string().trim().max(40),
  vehicleClass: z.enum(VEHICLE_CLASSES),
  plate: z.string().trim().max(16).nullable(),
  notes: z.string().trim().max(1000),
})
export type VehicleInput = z.infer<typeof vehicleInputSchema>

export const customerInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(5).max(32),
  email: z.email().max(200).nullable(),
  consent: z.literal(true),
})
export type CustomerInput = z.infer<typeof customerInputSchema>

export const createBookingRequestSchema = z.strictObject({
  serviceId: z.uuid(),
  startAt: instant,
  vehicle: vehicleInputSchema,
  customer: customerInputSchema,
  comment: z.string().trim().max(1000),
  idempotencyKey: z.uuid(),
  /** Honeypot: must stay empty. */
  website: z.string().max(0).optional(),
})
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>

export const availabilityRequestSchema = z
  .strictObject({
    serviceId: z.uuid(),
    vehicleClass: z.enum(VEHICLE_CLASSES),
    from: localDate,
    to: localDate,
  })
  .refine((v) => v.from <= v.to, { message: 'from must be <= to' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 31, { message: 'range too long' })
export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>

export const rescheduleRequestSchema = z.strictObject({ startAt: instant })
export const cancelRequestSchema = z.strictObject({ reason: z.string().trim().max(500).optional() })

export const ownerTransitionRequestSchema = z.strictObject({
  to: z.enum(BOOKING_STATUSES),
  reason: z.string().trim().max(500).optional(),
})
export const ownerFinalPriceRequestSchema = z.strictObject({ amountMinor: z.number().int().min(0).max(1e10).nullable() })
export const ownerBlockRequestSchema = z.strictObject({
  resourceId: z.uuid(),
  startsAt: instant,
  endsAt: instant,
  reason: z.string().trim().max(200),
})
export const ownerCustomerNotesRequestSchema = z.strictObject({ internalNotes: z.string().max(4000) })

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const storefrontServiceSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  category: z.enum(SERVICE_CATEGORIES),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  requirements: z.array(z.string()),
  duration_min: z.number(),
  price_from_minor: z.number(),
  multi_day: z.boolean(),
  image_url: z.string().nullable(),
  requires_confirmation: z.boolean(),
  variants: z.array(z.object({ vehicle_class: z.enum(VEHICLE_CLASSES), duration_min: z.number(), price_from_minor: z.number() })),
})
export type StorefrontService = z.infer<typeof storefrontServiceSchema>

export const storefrontSchema = z.object({
  tenant: z.object({
    slug: z.string(),
    name: z.string(),
    status: z.enum(['demo', 'active', 'suspended']),
    timezone: z.string(),
    currency: z.string(),
    locale: z.string(),
  }),
  profile: z.object({
    accent_hex: z.string(),
    tagline: z.string(),
    about: z.string(),
    address: z.string(),
    map_url: z.string().nullable(),
    phone_display: z.string().nullable(),
    phone_e164: z.string().nullable(),
    telegram_url: z.string().nullable(),
    whatsapp_url: z.string().nullable(),
    logo_url: z.string().nullable(),
    hero_url: z.string().nullable(),
    gallery: z.array(z.object({ url: z.string(), caption: z.string().optional() })),
  }),
  policy: z.object({
    slot_step_min: z.number(),
    min_notice_min: z.number(),
    horizon_days: z.number(),
    cancel_cutoff_hours: z.number(),
  }),
  ai_enabled: z.boolean(),
  hours: z.array(z.object({ weekday: z.number(), opens: z.string(), closes: z.string() })),
  services: z.array(storefrontServiceSchema),
})
export type Storefront = z.infer<typeof storefrontSchema>

export const availabilityResponseSchema = z.object({
  timezone: z.string(),
  durationMin: z.number(),
  priceFromMinor: z.number(),
  days: z.array(
    z.object({
      date: localDate,
      open: z.boolean(),
      slots: z.array(z.object({ startAt: instant, endAt: instant, time: z.string() })),
    }),
  ),
})
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>

export const createBookingResponseSchema = z.object({
  refCode: z.string(),
  status: z.enum(BOOKING_STATUSES),
  manageToken: z.string(),
  replayed: z.boolean(),
  isDemo: z.boolean(),
})
export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>

export const managedBookingSchema = z.object({
  ref_code: z.string(),
  status: z.enum(BOOKING_STATUSES),
  start_at: z.string(),
  end_at: z.string(),
  service_id: z.uuid(),
  service_name: z.string(),
  vehicle_class: z.enum(VEHICLE_CLASSES),
  multi_day: z.boolean(),
  price_from_minor: z.number(),
  currency: z.string(),
  vehicle: z.object({
    make: z.string(),
    model: z.string(),
    year: z.number().nullable(),
    color: z.string(),
    plate: z.string().nullable(),
  }),
  contact_name: z.string(),
  contact_phone_masked: z.string(),
  customer_comment: z.string(),
  is_demo: z.boolean(),
  cancel_cutoff_at: z.string(),
  can_modify: z.boolean(),
})
export type ManagedBooking = z.infer<typeof managedBookingSchema>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_MESSAGES: Record<string, string> = {
  SLOT_TAKEN: 'Это время только что заняли. Выберите другое.',
  IDEMPOTENCY_CONFLICT: 'Запрос уже обработан с другими данными. Обновите страницу.',
  TENANT_UNAVAILABLE: 'Онлайн-запись в студию временно недоступна.',
  SERVICE_NOT_FOUND: 'Услуга недоступна.',
  INVALID_WINDOW: 'Некорректное время записи.',
  OUTSIDE_BOOKING_WINDOW: 'На это время записаться нельзя.',
  SLOT_NOT_OFFERED: 'Это время недоступно. Выберите другое.',
  TOO_MANY_ACTIVE_BOOKINGS: 'У вас уже есть несколько активных записей. Свяжитесь со студией.',
  BOOKING_NOT_FOUND: 'Запись не найдена.',
  INVALID_TRANSITION: 'Это действие недоступно для текущего статуса.',
  CUTOFF_PASSED: 'Изменить запись онлайн уже нельзя — позвоните в студию.',
  INVALID_PHONE: 'Проверьте номер телефона.',
  VALIDATION_FAILED: 'Проверьте введённые данные.',
  RATE_LIMITED: 'Слишком много запросов. Попробуйте через минуту.',
  UNAUTHORIZED: 'Нужно войти заново.',
  FORBIDDEN: 'Нет доступа.',
  NOT_FOUND: 'Не найдено.',
  TELEGRAM_CHAT_INVALID: 'ID чата — это число, например -1001234567890.',
  TELEGRAM_CHAT_REQUIRED: 'Чтобы включить уведомления, укажите ID чата.',
  TELEGRAM_CHAT_TAKEN: 'Этот чат уже привязан к другой студии. Создайте отдельный чат для этой студии.',
  TELEGRAM_NOT_CONFIGURED: 'Бот платформы не подключён: сообщение отправить нельзя.',
  TELEGRAM_TEST_FAILED: 'Telegram не принял тестовое сообщение.',
  INTERNAL: 'Что-то пошло не так. Попробуйте ещё раз.',
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}
