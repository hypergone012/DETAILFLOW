import type { AvailabilityResponse } from '@detailflow/domain'
import { useMemo, useState } from 'react'
import { dayLabelDate, formatDay, formatDayShort, formatTime, formatWeekday } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/ui/skeleton'

type Day = AvailabilityResponse['days'][number]
export type PickedSlot = { startAt: string; endAt: string }

interface Props {
  tz: string
  days: Day[] | undefined
  loading: boolean
  selected: PickedSlot | null
  onSelect: (slot: PickedSlot) => void
  multiDay: boolean
}

/** Day strip + time grid. Times are shown in the studio's timezone. */
export function SlotPicker({ tz, days, loading, selected, onSelect, multiDay }: Props) {
  const firstWithSlots = useMemo(() => days?.find((d) => d.slots.length > 0)?.date ?? null, [days])
  const [activeDate, setActiveDate] = useState<string | null>(null)
  const current = activeDate ?? (selected ? days?.find((d) => d.slots.some((s) => s.startAt === selected.startAt))?.date : null) ?? firstWithSlots
  const day = days?.find((d) => d.date === current)

  if (loading || !days) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="flex gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 w-14" />)}</div>
        <div className="grid grid-cols-4 gap-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-11" />)}</div>
      </div>
    )
  }
  if (!firstWithSlots) {
    return <p className="rounded-md border border-line bg-surface-1 p-4 text-sm text-muted-foreground">В ближайшие дни свободного времени нет. Позвоните в студию — подберём вариант.</p>
  }

  return (
    <div>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2" role="tablist" aria-label="Дата">
        {days.map((d) => {
          const available = d.slots.length > 0
          const active = d.date === current
          return (
            <button
              key={d.date}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={!available}
              onClick={() => setActiveDate(d.date)}
              className={cn(
                'flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-md border text-center transition-colors active:translate-y-px',
                active ? 'border-accent bg-accent-subtle text-foreground' : 'border-line bg-surface-1 text-muted-foreground hover:border-line-strong',
                !available && 'border-transparent bg-transparent opacity-35',
              )}
            >
              <span className="text-[11px] uppercase">{formatWeekday(dayLabelDate(d.date), 'UTC')}</span>
              <span className="font-mono text-sm tabular">{formatDayShort(dayLabelDate(d.date), 'UTC').replace('.', '')}</span>
            </button>
          )
        })}
      </div>
      {day && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-muted-foreground">{formatDay(dayLabelDate(day.date), 'UTC')}</p>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Время">
            {day.slots.map((s) => {
              const checked = selected?.startAt === s.startAt
              return (
                <button
                  key={s.startAt}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => onSelect({ startAt: s.startAt, endAt: s.endAt })}
                  className={cn(
                    'h-11 rounded-md border font-mono text-sm tabular transition-colors active:translate-y-px',
                    checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-surface-1 hover:border-foreground/40',
                  )}
                >
                  {s.time}
                </button>
              )
            })}
          </div>
          {selected && multiDay && (
            <p className="mt-4 rounded-md border border-line bg-surface-1 p-3 text-sm">
              Сдать авто: <span className="font-mono tabular">{formatDay(selected.startAt, tz)}, {formatTime(selected.startAt, tz)}</span>
              <br />
              Готово ориентировочно: <span className="font-mono tabular">{formatDay(selected.endAt, tz)}, {formatTime(selected.endAt, tz)}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
