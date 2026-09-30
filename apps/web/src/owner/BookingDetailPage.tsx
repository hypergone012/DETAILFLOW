import { ACTION_LABELS, STATUS_LABELS, TRANSITIONS, VEHICLE_CLASS_LABELS, formatPhone, formatPriceFrom, formatRub, type BookingStatus } from '@detailflow/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CalendarClock, Loader2, Phone } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { SlotPicker, type PickedSlot } from '@/booking/SlotPicker'
import { errorMessage } from '@/lib/api'
import { addDaysIso, formatDay, formatTime, formatWindow, todayIn } from '@/lib/format'
import { STATUS_TONE } from '@/lib/status'
import { ownerApi } from '@/owner/api'
import { useTenant } from '@/tenant/context'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'

const EVENT_LABELS: Record<string, string> = {
  created: 'Создана',
  status_changed: 'Статус',
  rescheduled: 'Перенесена',
  final_price_set: 'Итоговая цена',
}
const ACTOR_LABELS: Record<string, string> = { customer: 'клиент', owner: 'студия', assistant: 'ассистент', system: 'система' }
const NOTIFY_LABELS: Record<string, string> = {
  pending: 'в очереди',
  sent: 'отправлено',
  failed: 'ошибка',
  suppressed_demo: 'не отправлено (демо)',
  not_configured: 'Telegram не настроен',
}

export function BookingDetailPage() {
  const { slug, storefront } = useTenant()
  const tz = storefront.tenant.timezone
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const detail = useQuery({ queryKey: ['owner', slug, 'booking', id], queryFn: () => ownerApi.booking(slug, id) })
  const [sheet, setSheet] = useState<'reschedule' | 'cancel' | null>(null)
  const [slot, setSlot] = useState<PickedSlot | null>(null)
  const [reason, setReason] = useState('')
  const [price, setPrice] = useState<string | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['owner', slug] })

  const transition = useMutation({
    mutationFn: ({ to, reason: r }: { to: BookingStatus; reason?: string }) => ownerApi.transition(slug, id, to, r),
    onSuccess: () => {
      setSheet(null)
      refresh()
    },
  })
  const from = todayIn(tz)
  const options = useQuery({
    queryKey: ['owner', slug, 'reschedule', id, from],
    queryFn: () => ownerApi.rescheduleOptions(slug, id, from, addDaysIso(from, 30)),
    enabled: sheet === 'reschedule',
  })
  const reschedule = useMutation({
    mutationFn: () => ownerApi.reschedule(slug, id, slot!.startAt),
    onSuccess: () => {
      setSheet(null)
      setSlot(null)
      refresh()
    },
    onError: () => void options.refetch(),
  })
  const savePrice = useMutation({
    mutationFn: (rub: number | null) => ownerApi.finalPrice(slug, id, rub === null ? null : Math.round(rub * 100)),
    onSuccess: () => {
      setPrice(null)
      refresh()
    },
  })

  if (detail.isPending) return <Skeleton className="m-4 h-96" />
  if (detail.isError) return <p className="p-6 text-danger">{errorMessage(detail.error)}</p>
  const { booking: b, customer, vehicle, events, notifications } = detail.data
  const next = TRANSITIONS[b.status].filter((s) => s !== 'cancelled')
  const canCancel = TRANSITIONS[b.status].includes('cancelled')
  const canMove = ['requested', 'confirmed'].includes(b.status)

  return (
    <main className="mx-auto max-w-5xl px-4 py-4">
      <Link to={`/s/${slug}/owner`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> К расписанию</Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">№ <span className="text-foreground">{b.ref_code}</span>{b.is_demo && ' · демо'}</p>
          <h1 className="mt-1 text-xl font-medium">{vehicle.make} {vehicle.model} {vehicle.plate && <span className="ml-1 rounded-sm border border-line-strong px-1.5 font-mono text-base">{vehicle.plate}</span>}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{b.service_name} · {formatWindow(b.start_at, b.end_at, tz, b.multi_day)} · {b.resource_name ?? 'бокс не назначен'}</p>
        </div>
        <Badge tone={STATUS_TONE[b.status]} className="text-xs">{STATUS_LABELS[b.status]}</Badge>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {next.map((to) => (
          <Button key={to} variant={to === 'no_show' ? 'outline' : 'primary'} disabled={transition.isPending} onClick={() => transition.mutate({ to })}>
            {ACTION_LABELS[to]}
          </Button>
        ))}
        {canMove && <Button variant="secondary" onClick={() => setSheet('reschedule')}><CalendarClock /> Перенести</Button>}
        {canCancel && <Button variant="danger" onClick={() => setSheet('cancel')}>Отменить</Button>}
      </div>
      {transition.isError && <p role="alert" className="mt-2 text-sm text-danger">{errorMessage(transition.error)}</p>}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Клиент</h2>
          <p className="mt-2 font-medium">{customer.name}</p>
          <a href={`tel:${customer.phone_e164}`} className="mt-1 flex items-center gap-2 font-mono text-sm text-accent"><Phone className="size-3.5" />{formatPhone(customer.phone_e164)}</a>
          {customer.email && <p className="mt-1 text-sm text-muted-foreground">{customer.email}</p>}
          <p className="mt-2 text-xs text-muted-foreground">Завершённых визитов: <span className="font-mono">{customer.completed_visits}</span></p>
          {b.contact_name !== customer.name && <p className="mt-1 text-xs text-warning">В этой записи указано имя: {b.contact_name}</p>}
          {b.customer_comment && <p className="mt-3 border-l-2 border-accent/60 pl-2 text-sm">{b.customer_comment}</p>}
          <Link to={`/s/${slug}/owner/customers/${customer.id}`} className="mt-3 inline-block text-sm text-accent">Карточка клиента →</Link>
        </section>

        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Автомобиль</h2>
          <dl className="mt-2 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Модель</dt><dd>{vehicle.make} {vehicle.model}</dd>
            <dt className="text-muted-foreground">Год</dt><dd className="font-mono">{vehicle.year ?? '—'}</dd>
            <dt className="text-muted-foreground">Цвет</dt><dd>{vehicle.color || '—'}</dd>
            <dt className="text-muted-foreground">Класс</dt><dd>{VEHICLE_CLASS_LABELS[vehicle.vehicle_class].label}</dd>
            <dt className="text-muted-foreground">Номер</dt><dd className="font-mono">{vehicle.plate ?? '—'}</dd>
          </dl>
          {vehicle.notes && <p className="mt-3 border-l-2 border-accent/60 pl-2 text-sm">{vehicle.notes}</p>}
        </section>

        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Стоимость</h2>
          <p className="mt-2 text-sm text-muted-foreground">При записи: <span className="font-mono text-foreground">{formatPriceFrom(Number(b.price_from_minor))}</span></p>
          <p className="mt-1 text-sm text-muted-foreground">Итог: <span className="font-mono text-foreground">{b.final_price_minor ? formatRub(Number(b.final_price_minor)) : 'не указан'}</span></p>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (price !== null && price !== '') savePrice.mutate(Number(price)) }}>
            <Label htmlFor="final-price" className="sr-only">Итоговая цена, ₽</Label>
            <Input id="final-price" inputMode="numeric" placeholder="Итог, ₽" className="h-10 font-mono" value={price ?? ''} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} />
            <Button type="submit" size="sm" className="h-10" disabled={!price || savePrice.isPending}>Сохранить</Button>
          </form>
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">История</h2>
          <ol className="mt-2 space-y-1.5 text-sm">
            {events.map((e, i) => (
              <li key={i} className="grid grid-cols-[7.5rem_1fr] gap-2">
                <span className="font-mono text-xs text-muted-foreground tabular">{formatDay(e.at, tz).replace(/^\S+ /, '')} {formatTime(e.at, tz)}</span>
                <span>
                  {EVENT_LABELS[e.type] ?? e.type}
                  {e.to_status && e.type === 'status_changed' && `: ${STATUS_LABELS[e.to_status]}`}
                  {e.type === 'rescheduled' && typeof e.data.to === 'object' && e.data.to && ` на ${formatDay((e.data.to as { start_at: string }).start_at, tz)} ${formatTime((e.data.to as { start_at: string }).start_at, tz)}`}
                  {e.type === 'final_price_set' && typeof e.data.amount_minor === 'number' && `: ${formatRub(e.data.amount_minor)}`}
                  <span className="text-muted-foreground"> · {ACTOR_LABELS[e.actor] ?? e.actor}</span>
                  {typeof e.data.reason === 'string' && <span className="block text-xs text-muted-foreground">«{e.data.reason}»</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Уведомления студии</h2>
          {notifications.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Нет</p> : (
            <ul className="mt-2 space-y-1 text-sm">
              {notifications.map((n, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="font-mono text-xs">{n.event}</span>
                  <span className={n.status === 'sent' ? 'text-success' : n.status === 'failed' ? 'text-danger' : 'text-muted-foreground'}>{NOTIFY_LABELS[n.status] ?? n.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Sheet open={sheet === 'reschedule'} onOpenChange={(o) => setSheet(o ? 'reschedule' : null)}>
        <SheetContent side="right" className="overflow-y-auto p-5">
          <SheetTitle>Перенос записи</SheetTitle>
          <SheetDescription className="mt-1">Сейчас: {formatWindow(b.start_at, b.end_at, tz, b.multi_day)}. Если новое время не удастся занять, запись останется на месте.</SheetDescription>
          <div className="mt-5">
            <SlotPicker tz={tz} days={options.data?.days} loading={options.isPending} selected={slot} onSelect={setSlot} multiDay={b.multi_day} />
          </div>
          {reschedule.isError && <p role="alert" className="mt-3 text-sm text-danger">{errorMessage(reschedule.error)}</p>}
          <Button className="mt-5 w-full" disabled={!slot || reschedule.isPending} onClick={() => reschedule.mutate()}>
            {reschedule.isPending && <Loader2 className="animate-spin" />} Перенести
          </Button>
        </SheetContent>
      </Sheet>

      <Sheet open={sheet === 'cancel'} onOpenChange={(o) => setSheet(o ? 'cancel' : null)}>
        <SheetContent side="right" className="p-5">
          <SheetTitle>Отменить запись {b.ref_code}?</SheetTitle>
          <SheetDescription className="mt-1">Бокс освободится для онлайн-записи.</SheetDescription>
          <Textarea className="mt-4" placeholder="Причина" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button className="mt-4 w-full" variant="danger" disabled={transition.isPending} onClick={() => transition.mutate({ to: 'cancelled', ...(reason.trim() ? { reason: reason.trim() } : {}) })}>Отменить запись</Button>
        </SheetContent>
      </Sheet>
    </main>
  )
}
