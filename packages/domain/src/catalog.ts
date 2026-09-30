export const SERVICE_CATEGORIES = [
  'detailing_wash',
  'paint_correction',
  'ceramic_coating',
  'ppf',
  'interior_detailing',
  'leather_protection',
  'pre_sale_preparation',
] as const
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  detailing_wash: 'Детейлинг-мойка',
  paint_correction: 'Полировка кузова',
  ceramic_coating: 'Керамика',
  ppf: 'Плёнка PPF',
  interior_detailing: 'Химчистка салона',
  leather_protection: 'Защита кожи',
  pre_sale_preparation: 'Предпродажная подготовка',
}

export const VEHICLE_CLASSES = ['compact', 'sedan', 'suv', 'large_suv', 'van', 'other'] as const
export type VehicleClass = (typeof VEHICLE_CLASSES)[number]

export const VEHICLE_CLASS_LABELS: Record<VehicleClass, { label: string; hint: string }> = {
  compact: { label: 'Компакт', hint: 'Polo, Rio, Golf' },
  sedan: { label: 'Седан', hint: 'Camry, 5 Series, E-Class' },
  suv: { label: 'Кроссовер', hint: 'RAV4, X3, Tiguan' },
  large_suv: { label: 'Большой SUV', hint: 'X7, LX, Tahoe' },
  van: { label: 'Минивэн', hint: 'V-Class, Alphard' },
  other: { label: 'Другое', hint: 'Пикап, спорткар' },
}

export const RESOURCE_TYPES = ['wash_bay', 'detail_bay', 'ppf_booth', 'paint_booth', 'interior_station'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export interface PricedTiming {
  durationMin: number
  priceFromMinor: number
}

export interface ServiceVariant extends PricedTiming {
  vehicleClass: VehicleClass
}

/** Price "from" and duration for a vehicle class: variant if defined, else base. */
export function resolveVariant(
  base: PricedTiming,
  variants: readonly ServiceVariant[],
  vehicleClass: VehicleClass,
): PricedTiming {
  const v = variants.find((x) => x.vehicleClass === vehicleClass)
  return v ? { durationMin: v.durationMin, priceFromMinor: v.priceFromMinor } : { ...base }
}

/** "~2 ч", "~1 ч 30 мин", "2–3 дня" style labels. */
export function formatDuration(minutes: number, multiDay: boolean, workdayMin = 600): string {
  if (multiDay) {
    const days = Math.max(1, Math.ceil(minutes / workdayMin))
    return days === 1 ? '1 день' : `${days} ${plural(days, 'день', 'дня', 'дней')}`
  }
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} мин`
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}
