const cache = new Map<string, Intl.DateTimeFormat>()

function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts)
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, ...opts })
    cache.set(key, f)
  }
  return f
}

export const formatTime = (iso: string | Date, tz: string) => fmt(tz, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
export const formatDay = (iso: string | Date, tz: string) => fmt(tz, { weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(iso))
export const formatDayShort = (iso: string | Date, tz: string) => fmt(tz, { day: 'numeric', month: 'short' }).format(new Date(iso))
export const formatWeekday = (iso: string | Date, tz: string) => fmt(tz, { weekday: 'short' }).format(new Date(iso))

/** Local date YYYY-MM-DD at noon UTC — for labelling engine days without TZ drift. */
export const dayLabelDate = (date: string) => `${date}T12:00:00Z`

export function formatWindow(startIso: string, endIso: string, tz: string, multiDay: boolean): string {
  if (multiDay) return `${formatDay(startIso, tz)}, ${formatTime(startIso, tz)} → ${formatDay(endIso, tz)}, ≈${formatTime(endIso, tz)}`
  return `${formatDay(startIso, tz)}, ${formatTime(startIso, tz)}–${formatTime(endIso, tz)}`
}

export function todayIn(tz: string): string {
  return fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('.').reverse().join('-')
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
