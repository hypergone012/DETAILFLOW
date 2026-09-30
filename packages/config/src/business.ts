import { RESOURCE_TYPES, SERVICE_CATEGORIES, VEHICLE_CLASSES } from '@detailflow/domain'
import { z } from 'zod'

/** Authoring format for a studio: tenants/{slug}/business.json. */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
const dayHours = z.array(z.tuple([time, time])).max(4)
const assetPath = z.string().regex(/^assets\/[a-z0-9._-]+\.(svg|jpg|jpeg|png|webp)$/, 'assets/<file>.(svg|jpg|png|webp)')
const rubles = z.number().int().min(0).max(10_000_000)

export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export const businessSchema = z.strictObject({
  $schema: z.string().optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/),
  name: z.string().min(1).max(120),
  status: z.enum(['draft', 'demo', 'active']),
  timezone: z.string().min(3),
  currency: z.literal('RUB'),
  locale: z.literal('ru-RU'),
  branding: z.strictObject({
    accent: z.string().regex(/^#[0-9a-f]{6}$/, 'lowercase #rrggbb'),
    logo: assetPath.optional(),
    hero: assetPath,
    tagline: z.string().min(1).max(140),
    about: z.string().max(1200),
    gallery: z.array(z.strictObject({ src: assetPath, caption: z.string().max(120) })).max(12),
    /** Honest labelling: true when imagery is demo artwork, not the studio's own photos. */
    demoArtwork: z.boolean(),
  }),
  contacts: z.strictObject({
    address: z.string().min(1).max(200),
    mapUrl: z.url().optional(),
    phoneDisplay: z.string().max(40).optional(),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
    telegramUrl: z.url().optional(),
    whatsappUrl: z.url().optional(),
  }),
  policy: z.strictObject({
    slotStepMin: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    minNoticeMin: z.number().int().min(0).max(10080),
    horizonDays: z.number().int().min(1).max(365),
    cancelCutoffHours: z.number().int().min(0).max(336),
    requiresConfirmation: z.boolean(),
    maxActiveBookingsPerPhone: z.number().int().min(1).max(50),
  }),
  hours: z.strictObject(Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, dayHours])) as Record<(typeof WEEKDAY_KEYS)[number], typeof dayHours>),
  exceptions: z.array(z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    closed: z.boolean(),
    opens: time.optional(),
    closes: time.optional(),
    note: z.string().max(200).optional(),
  })),
  resources: z.array(z.strictObject({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/),
    type: z.enum(RESOURCE_TYPES),
    name: z.string().min(1).max(60),
  })).min(1),
  services: z.array(z.strictObject({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/),
    category: z.enum(SERVICE_CATEGORIES),
    name: z.string().min(1).max(120),
    summary: z.string().max(200),
    description: z.string().max(2000),
    requirements: z.array(z.string().max(200)).max(8),
    resourceType: z.enum(RESOURCE_TYPES),
    durationMin: z.number().int().min(15).max(14400),
    priceFrom: rubles,
    bufferBeforeMin: z.number().int().min(0).max(240),
    bufferAfterMin: z.number().int().min(0).max(240),
    multiDay: z.boolean(),
    requiresConfirmation: z.boolean().optional(),
    variants: z.partialRecord(z.enum(VEHICLE_CLASSES), z.strictObject({ durationMin: z.number().int().min(15).max(14400), priceFrom: rubles })),
  })).min(1),
  owners: z.array(z.strictObject({ email: z.email(), role: z.enum(['owner', 'manager', 'staff']) })).min(1),
  ai: z.strictObject({ enabled: z.boolean() }),
})
export type Business = z.infer<typeof businessSchema>
