import { STATUS_LABELS, isoWeekday, zonedInstant } from '@detailflow/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ChevronLeft, ChevronRight, Lock, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { errorMessage } from '@/lib/api'
import { addDaysIso, dayLabelDate, formatDay, formatTime, todayIn } from '@/lib/format'
import { STATUS_BAR, STATUS_TONE } from '@/lib/status'
import { cn } from '@/lib/utils'
import { ownerApi, type DayView, type OwnerBookingRow } from '@/owner/api'
import { useTenant } from '@/tenant/context'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet'
import { Skeleton } from '@/ui/skeleton'

const ACTIVE = new Set(['requested', 'confirmed', 'checked_in', 'in_progress', 'ready'])

export function TodayPage() {
  const { slug, storefront } = useTenant()
  const tz = storefront.tenant.timezone
  const [params, setParams] = useSearchParams()
  const today = todayIn(tz)
  const date = params.get('date') ?? today
  const day = useQuery({ queryKey: ['owner', slug, 'day', date], queryFn: () => ownerApi.day(slug, date), refetchInterval: 30_000 })
  const [blockOpen, setBlockOpen] = useState(false)

  const setDate = (d: string) => setParams(d === today ? {} : { date: d })

  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center">
          <Button variant="ghost" size="icon" onClick={() => setDate(addDaysIso(date, -1))} aria-label="Предыдущий день"><ChevronLeft /></Button>
          <Button variant="ghost" size="icon" onClick={() => setDate(addDaysIso(date, 1))} aria-label="Следующий день"><ChevronRight /></Button>
        </div>
        <h1 className="text-lg font-medium">
          {date === today ? 'Сегодня' : formatDay(dayLabelDate(date), 'UTC')}
          <span className="ml-2 font-mono text-xs text-muted-foreground">{date}</span>
        </h1>
        {date !== today && <Button variant="outline" size="sm" onClick={() => setDate(today)}>Сегодня</Button>}
        <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="ml-auto h-9 w-40 font-mono text-sm" aria-label="Дата" />
        <Button variant="secondary" size="sm" onClick={() => setBlockOpen(true)}><Lock /> Блокировка</Button>
      </div>

      {day.isPending && <Skeleton className="mt-4 h-72" />}
      {day.isError && <p className="mt-6 text-danger">{errorMessage(day.error)}</p>}
      {day.data && (
        <>
          <Counters data={day.data} />
          <Timeline data={day.data} tz={tz} date={date} slug={slug} hours={storefront.hours} />
          <Agenda data={day.data} tz={tz} slug={slug} />
          <BlockSheet open={blockOpen} onOpenChange={setBlockOpen} data={day.data} tz={tz} date={date} slug={slug} />
        </>
      )}
    </main>
  )
}

function Counters({ data }: { data: DayView }) {
  const arriving = data.bookings.filter((b) => ['requested', 'confirmed'].includes(b.status)).length
  const items = [
    { label: 'Ждут подтверждения', value: data.counters.awaiting_confirmation, tone: data.counters.awaiting_confirmation ? 'text-warning' : '' },
    { label: 'Приезжают в этот день', value: arriving, tone: '' },
    { label: 'В работе', value: data.counters.in_work, tone: '' },
    { label: 'Готовы к выдаче', value: data.counters.ready_for_pickup, tone: data.counters.ready_for_pickup ? 'text-accent' : '' },
  ]
  return (
    <div className="mt-4">
      <dl className="grid grid-cols-2 divide-line overflow-hidden rounded-md border border-line bg-surface-1 sm:grid-cols-4 sm:divide-x">
        {items.map((i) => (
          <div key={i.label} className="border-line px-4 py-3 not-last:border-b sm:not-last:border-b-0">
            <dt className="text-xs text-muted-foreground">{i.label}</dt>
            <dd className={cn('mt-1 font-mono text-2xl tabular', i.tone)}>{i.value}</dd>
          </div>
        ))}
      </dl>
      {data.notifications.not_configured + data.notifications.failed > 0 && (
        <p className="mt-2 flex items-center gap-2 text-xs text-warning">
          <AlertTriangle className="size-3.5" />
          Уведомления в Telegram: {data.notifications.not_configured > 0 && `не настроены (${data.notifications.not_configured})`}
          {data.notifications.failed > 0 && ` ошибки отправки (${data.notifications.failed})`}
        </p>
      )}
    </div>
  )
}

function Timeline({ data, tz, date, slug, hours }: { data: DayView; tz: string; date: string; slug: string; hours: Array<{ weekday: number; opens: string; closes: string }> }) {
  const todays = hours.filter((h) => h.weekday === isoWeekday(date))
  const opens = todays.length ? todays.map((h) => h.opens).sort()[0]! : '08:00'
  const closes = todays.length ? todays.map((h) => h.closes).sort().at(-1)! : '21:00'
  const startH = Math.max(0, Number(opens.slice(0, 2)) - 1)
  const endH = Math.min(24, Number(closes.slice(0, 2)) + (closes.endsWith(':00') ? 1 : 2))
  const dayStart = zonedInstant(date, `${String(startH).padStart(2, '0')}:00`, tz)?.getTime() ?? Date.parse(`${date}T00:00:00Z`)
  const span = (endH - startH) * 3_600_000
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - dayStart) / span) * 100))
  const now = Date.now()
  const hoursAxis = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i)

  return (
    <section className="mt-5 hidden overflow-hidden rounded-md border border-line md:block" aria-label="Загрузка боксов">
      <div className="grid grid-cols-[9rem_1fr] border-b border-line bg-surface-1 font-mono text-[10px] text-faint-foreground">
        <div className="px-3 py-1.5">БОКС</div>
        <div className="relative h-6">
          {hoursAxis.map((h) => (
            <span key={h} className={cn('absolute top-1.5', h === startH ? 'translate-x-1' : h === endH ? '-translate-x-[calc(100%+4px)]' : '-translate-x-1/2')} style={{ left: `${((h - startH) / (endH - startH)) * 100}%` }}>
              {String(h).padStart(2, '0')}
            </span>
          ))}
        </div>
      </div>
      {data.resources.map((r) => {
        const bookings = data.bookings.filter((b) => b.resource_id === r.id)
        const blocks = data.blocks.filter((b) => b.resource_id === r.id)
        return (
          <div key={r.id} className="grid grid-cols-[9rem_1fr] border-b border-line last:border-0">
            <div className="flex items-center px-3 text-sm">{r.name}</div>
            <div className="relative h-16">
              {hoursAxis.slice(1, -1).map((h) => (
                <div key={h} className="absolute inset-y-0 w-px bg-line" style={{ left: `${((h - startH) / (endH - startH)) * 100}%` }} aria-hidden />
              ))}
              {blocks.map((k) => (
                <div key={k.id} title={k.reason} className="absolute inset-y-1.5 rounded-sm border border-line-strong bg-[repeating-linear-gradient(135deg,var(--surface-2),var(--surface-2)_6px,var(--surface-3)_6px,var(--surface-3)_12px)] px-2 py-1 text-[11px] text-muted-foreground"
                  style={{ left: `${pct(Date.parse(k.starts_at))}%`, width: `${pct(Date.parse(k.ends_at)) - pct(Date.parse(k.starts_at))}%` }}>
                  <Lock className="mr-1 inline size-3" />{k.reason || 'Блокировка'}
                </div>
              ))}
              {bookings.map((b) => {
                const left = pct(Date.parse(b.start_at))
                const right = pct(Date.parse(b.end_at))
                return (
                  <Link key={b.id} to={`/s/${slug}/owner/bookings/${b.id}`}
                    className={cn('absolute inset-y-1.5 overflow-hidden rounded-sm border px-2 py-1 text-[11px] leading-tight transition-[filter] hover:brightness-125', STATUS_BAR[b.status])}
                    style={{ left: `${left}%`, width: `max(${right - left}%, 2.5rem)` }}>
                    <span className="block truncate font-medium text-foreground">{b.vehicle.make} {b.vehicle.model} {b.vehicle.plate && <span className="font-mono">{b.vehicle.plate}</span>}</span>
                    <span className="block truncate text-muted-foreground">{formatTime(b.start_at, tz)} · {b.service_name}{Date.parse(b.end_at) > dayStart + span ? ' →' : ''}</span>
                  </Link>
                )
              })}
              {now > dayStart && now < dayStart + span && (
                <div className="pointer-events-none absolute inset-y-0 w-px bg-accent" style={{ left: `${pct(now)}%` }} aria-hidden />
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function Agenda({ data, tz, slug }: { data: DayView; tz: string; slug: string }) {
  const rows = [...data.bookings].sort((a, b) => Number(!ACTIVE.has(a.status)) - Number(!ACTIVE.has(b.status)) || a.start_at.localeCompare(b.start_at))
  return (
    <section className="mt-5" aria-label="Записи дня">
      <h2 className="mb-2 font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Очередь · {rows.length}</h2>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-line-strong p-6 text-center text-sm text-muted-foreground">Записей на этот день нет</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface-1">
          {rows.map((b) => <AgendaRow key={b.id} b={b} tz={tz} slug={slug} />)}
        </ul>
      )}
    </section>
  )
}

function AgendaRow({ b, tz, slug }: { b: OwnerBookingRow; tz: string; slug: string }) {
  return (
    <li>
      <Link to={`/s/${slug}/owner/bookings/${b.id}`} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-3 py-3 hover:bg-surface-2 active:bg-surface-3">
        <span className="font-mono text-sm tabular">{formatTime(b.start_at, tz)}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {b.vehicle.make} {b.vehicle.model} {b.vehicle.plate && <span className="font-mono text-xs text-muted-foreground">{b.vehicle.plate}</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{b.service_name} · {b.contact_name} · {b.resource_name ?? '—'}</span>
        </span>
        <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABELS[b.status]}</Badge>
      </Link>
    </li>
  )
}

function BlockSheet({ open, onOpenChange, data, tz, date, slug }: { open: boolean; onOpenChange: (o: boolean) => void; data: DayView; tz: string; date: string; slug: string }) {
  const queryClient = useQueryClient()
  const [resourceId, setResourceId] = useState(data.resources[0]?.id ?? '')
  const [from, setFrom] = useState('12:00')
  const [to, setTo] = useState('14:00')
  const [reason, setReason] = useState('')
  const create = useMutation({
    mutationFn: () => {
      const startsAt = zonedInstant(date, from, tz)
      const endsAt = zonedInstant(date, to, tz)
      if (!startsAt || !endsAt) throw new Error('bad time')
      return ownerApi.createBlock(slug, { resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['owner', slug] })
      onOpenChange(false)
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => ownerApi.removeBlock(slug, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['owner', slug] }),
  })
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-4 overflow-y-auto p-5">
        <SheetTitle>Блокировка бокса</SheetTitle>
        <SheetDescription>На это время бокс исчезнет из онлайн-записи. Поверх существующей записи блокировку поставить нельзя.</SheetDescription>
        <div className="space-y-1.5">
          <Label htmlFor="block-resource">Бокс</Label>
          <select id="block-resource" value={resourceId} onChange={(e) => setResourceId(e.target.value)} className="h-11 w-full rounded-md border border-input bg-surface-1 px-3 text-sm">
            {data.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label htmlFor="block-from">С</Label><Input id="block-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="font-mono" /></div>
          <div className="space-y-1.5"><Label htmlFor="block-to">До</Label><Input id="block-to" type="time" value={to} onChange={(e) => setTo(e.target.value)} className="font-mono" /></div>
        </div>
        <div className="space-y-1.5"><Label htmlFor="block-reason">Причина</Label><Input id="block-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Обслуживание, личная запись…" /></div>
        {create.isError && <p role="alert" className="text-sm text-danger">{errorMessage(create.error)}</p>}
        <Button disabled={create.isPending || !resourceId || from >= to} onClick={() => create.mutate()}><Plus /> Заблокировать {date}</Button>
        {data.blocks.length > 0 && (
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Блокировки в этот день</p>
            <ul className="divide-y divide-line rounded-md border border-line">
              {data.blocks.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span>
                    <span className="font-mono tabular">{formatTime(k.starts_at, tz)}–{formatTime(k.ends_at, tz)}</span>{' '}
                    {data.resources.find((r) => r.id === k.resource_id)?.name} · {k.reason || '—'}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(k.id)}>Снять</Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
