import { TZDate } from '@date-fns/tz'

/**
 * DETAILFLOW slot engine.
 *
 * Pure and deterministic: every input (including `now`) is explicit. All
 * instants are absolute (Date); wall-clock values are interpreted in the
 * tenant's IANA timezone, so DST transitions are handled by construction:
 *  - a wall time that does not exist (spring forward) is never offered;
 *  - an ambiguous wall time (fall back) resolves to the standard-time instant.
 *
 * The database remains the final arbiter of occupancy (exclusion constraint);
 * this engine decides which windows are *offered* and computes their end.
 */

export type LocalDate = string // YYYY-MM-DD
export type LocalTime = string // HH:MM

export interface WeeklyHours {
  weekday: number // ISO: 1 = Monday … 7 = Sunday
  opens: LocalTime
  closes: LocalTime
}

export interface DateException {
  date: LocalDate
  closed: boolean
  opens?: LocalTime | null
  closes?: LocalTime | null
}

export interface BusyInterval {
  resourceId: string
  start: Date
  end: Date
}

export interface ServiceTiming {
  durationMin: number
  bufferBeforeMin: number
  bufferAfterMin: number
  multiDay: boolean
}

export interface BookingPolicy {
  slotStepMin: number
  minNoticeMin: number
  horizonDays: number
}

export interface Calendar {
  timezone: string
  hours: readonly WeeklyHours[]
  exceptions: readonly DateException[]
}

export interface AvailabilityInput extends Calendar {
  service: ServiceTiming
  policy: BookingPolicy
  resources: readonly string[]
  busy: readonly BusyInterval[]
  now: Date
  from: LocalDate
  to: LocalDate
}

export interface Slot {
  start: Date
  end: Date
  /** Wall-clock start in the tenant timezone, for display. */
  localDate: LocalDate
  localTime: LocalTime
  freeResourceIds: string[]
}

export interface DayAvailability {
  date: LocalDate
  open: boolean
  slots: Slot[]
}

const MINUTE = 60_000
const MAX_MULTI_DAY_SPAN_DAYS = 30

// ---------------------------------------------------------------------------
// Local date/time helpers
// ---------------------------------------------------------------------------

export function parseLocalDate(date: LocalDate): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new RangeError(`invalid local date: ${date}`)
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

export function parseLocalTime(time: LocalTime): { h: number; min: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) throw new RangeError(`invalid local time: ${time}`)
  const h = Number(match[1])
  const min = Number(match[2])
  if (h > 23 || min > 59) throw new RangeError(`invalid local time: ${time}`)
  return { h, min }
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { y, m, d } = parseLocalDate(date)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export function isoWeekday(date: LocalDate): number {
  const { y, m, d } = parseLocalDate(date)
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return js === 0 ? 7 : js
}

/** Absolute instant of a wall-clock time, or null if it does not exist (DST gap). */
export function zonedInstant(date: LocalDate, time: LocalTime, timezone: string): Date | null {
  const { y, m, d } = parseLocalDate(date)
  const { h, min } = parseLocalTime(time)
  const z = new TZDate(y, m - 1, d, h, min, timezone)
  if (z.getFullYear() !== y || z.getMonth() !== m - 1 || z.getDate() !== d || z.getHours() !== h || z.getMinutes() !== min) {
    return null
  }
  return new Date(z.getTime())
}

export function toLocal(instant: Date, timezone: string): { date: LocalDate; time: LocalTime } {
  const z = new TZDate(instant.getTime(), timezone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`,
    time: `${pad(z.getHours())}:${pad(z.getMinutes())}`,
  }
}

export function localToday(now: Date, timezone: string): LocalDate {
  return toLocal(now, timezone).date
}

// ---------------------------------------------------------------------------
// Working intervals
// ---------------------------------------------------------------------------

export interface Interval {
  start: Date
  end: Date
}

/** Wall-clock intervals for one local date (exception overrides weekly hours). */
export function localIntervalsFor(calendar: Calendar, date: LocalDate): Array<{ opens: LocalTime; closes: LocalTime }> {
  const exception = calendar.exceptions.find((e) => e.date === date)
  if (exception) {
    if (exception.closed || !exception.opens || !exception.closes) return []
    return [{ opens: exception.opens, closes: exception.closes }]
  }
  const weekday = isoWeekday(date)
  return calendar.hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ opens: h.opens, closes: h.closes }))
    .sort((a, b) => a.opens.localeCompare(b.opens))
}

/** Absolute working intervals for one local date. */
export function workingIntervals(calendar: Calendar, date: LocalDate): Interval[] {
  const out: Interval[] = []
  for (const { opens, closes } of localIntervalsFor(calendar, date)) {
    const start = zonedInstant(date, opens, calendar.timezone) ?? nextValidInstant(date, opens, calendar.timezone)
    const end = zonedInstant(date, closes, calendar.timezone) ?? nextValidInstant(date, closes, calendar.timezone)
    if (start && end && end > start) out.push({ start, end })
  }
  return out
}

/** For an interval edge falling into a DST gap, the first valid minute after it. */
function nextValidInstant(date: LocalDate, time: LocalTime, timezone: string): Date | null {
  const { h, min } = parseLocalTime(time)
  for (let add = 1; add <= 120; add++) {
    const total = h * 60 + min + add
    if (total >= 24 * 60) return null
    const t = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    const instant = zonedInstant(date, t, timezone)
    if (instant) return instant
  }
  return null
}

/**
 * End of a multi-day job: consumes `durationMin` working minutes starting at
 * `start`, skipping closed hours and days. Returns null if it cannot finish
 * within the maximum span.
 */
export function multiDayEnd(calendar: Calendar, start: Date, durationMin: number): Date | null {
  let remaining = durationMin * MINUTE
  let date = toLocal(start, calendar.timezone).date
  for (let day = 0; day <= MAX_MULTI_DAY_SPAN_DAYS; day++, date = addDays(date, 1)) {
    for (const interval of workingIntervals(calendar, date)) {
      if (interval.end <= start) continue
      const from = interval.start > start ? interval.start : start
      const available = interval.end.getTime() - from.getTime()
      if (available >= remaining) return new Date(from.getTime() + remaining)
      remaining -= available
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** End of the service window starting at `start`, or null if it does not fit the calendar. */
export function serviceEnd(calendar: Calendar, service: ServiceTiming, start: Date, container: Interval): Date | null {
  if (service.multiDay) return multiDayEnd(calendar, start, service.durationMin)
  const end = new Date(start.getTime() + service.durationMin * MINUTE)
  return end <= container.end ? end : null
}

export function occupancyWindow(service: ServiceTiming, start: Date, end: Date): Interval {
  return {
    start: new Date(start.getTime() - service.bufferBeforeMin * MINUTE),
    end: new Date(end.getTime() + service.bufferAfterMin * MINUTE),
  }
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

function freeResources(input: AvailabilityInput, window: Interval): string[] {
  return input.resources.filter(
    (id) => !input.busy.some((b) => b.resourceId === id && overlaps(window, { start: b.start, end: b.end })),
  )
}

export function computeAvailability(input: AvailabilityInput): DayAvailability[] {
  const earliest = new Date(input.now.getTime() + input.policy.minNoticeMin * MINUTE)
  const latest = new Date(input.now.getTime() + input.policy.horizonDays * 24 * 60 * MINUTE)
  const step = input.policy.slotStepMin * MINUTE
  const days: DayAvailability[] = []

  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const intervals = workingIntervals(input, date)
    const slots: Slot[] = []
    for (const interval of intervals) {
      for (let t = interval.start.getTime(); t < interval.end.getTime(); t += step) {
        const start = new Date(t)
        if (start < earliest || start > latest) continue
        const end = serviceEnd(input, input.service, start, interval)
        if (!end) continue
        const free = freeResources(input, occupancyWindow(input.service, start, end))
        if (free.length === 0) continue
        const local = toLocal(start, input.timezone)
        slots.push({ start, end, localDate: local.date, localTime: local.time, freeResourceIds: free })
      }
    }
    days.push({ date, open: intervals.length > 0, slots })
  }
  return days
}

/**
 * Server-side validation of a requested start: returns the offered slot
 * (with the server-computed end) or null. Used before calling the DB.
 */
export function findOfferedSlot(input: Omit<AvailabilityInput, 'from' | 'to'>, start: Date): Slot | null {
  const date = toLocal(start, input.timezone).date
  const [day] = computeAvailability({ ...input, from: date, to: date })
  return day?.slots.find((s) => s.start.getTime() === start.getTime()) ?? null
}
