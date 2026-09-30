import { STATUS_LABELS, VEHICLE_CLASS_LABELS, formatPriceFrom } from '@detailflow/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, CheckCircle2, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { SlotPicker, type PickedSlot } from '@/booking/SlotPicker'
import { ApiError, errorMessage, publicApi } from '@/lib/api'
import { addDaysIso, formatDay, formatTime, formatWindow, todayIn } from '@/lib/format'
import { STATUS_TONE } from '@/lib/status'
import { useTenant } from '@/tenant/context'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'


export function ManagePage() {
  const { slug, storefront } = useTenant()
  const { token = '' } = useParams()
  const location = useLocation()
  const justCreated = (location.state as { created?: boolean } | null)?.created === true
  const tz = storefront.tenant.timezone
  const queryClient = useQueryClient()
  const key = ['managed', slug, token]
  const booking = useQuery({ queryKey: key, queryFn: ({ signal }) => publicApi.managed(slug, token, signal) })
  const [sheet, setSheet] = useState<'reschedule' | 'cancel' | null>(null)
  const [slot, setSlot] = useState<PickedSlot | null>(null)
  const [reason, setReason] = useState('')

  const from = todayIn(tz)
  const to = addDaysIso(from, Math.min(storefront.policy.horizon_days, 21))
  const options = useQuery({
    queryKey: ['manage-availability', slug, token, from, to],
    queryFn: () => publicApi.manageAvailability(slug, token, { from, to }),
    enabled: sheet === 'reschedule',
  })
  const reschedule = useMutation({
    mutationFn: () => publicApi.reschedule(slug, token, slot!.startAt),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data)
      setSheet(null)
      setSlot(null)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) void options.refetch()
    },
  })
  const cancel = useMutation({
    mutationFn: () => publicApi.cancel(slug, token, reason.trim() || undefined),
    onSuccess: (data) => {
      queryClient.setQueryData(key, data)
      setSheet(null)
    },
  })

  if (booking.isPending) {
    return (
      <main className="mx-auto max-w-lg space-y-3 px-4 py-8">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full" />
      </main>
    )
  }
  if (booking.isError) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <h1 className="font-display text-xl">Запись не найдена</h1>
        <p className="mt-2 text-muted-foreground">{errorMessage(booking.error)}</p>
        <Link to={`/s/${slug}`} className="mt-6 inline-block text-accent">На страницу студии</Link>
      </main>
    )
  }
  const b = booking.data
  return (
    <main className="mx-auto max-w-lg px-4 pt-6 pb-16">
      {justCreated && (
        <div className="mb-6 flex gap-3 rounded-md border border-success/40 bg-success/10 p-4">
          <CheckCircle2 className="size-5 shrink-0 text-success" />
          <div className="text-sm">
            <p className="font-medium text-foreground">{b.status === 'requested' ? 'Заявка отправлена' : 'Вы записаны'}</p>
            <p className="mt-1 text-muted-foreground">
              Сохраните эту страницу в закладки — по ней можно перенести или отменить запись.
              {b.is_demo && ' Демо-режим: студия не получит уведомление.'}
            </p>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs tracking-[0.14em] text-muted-foreground">ЗАПИСЬ № <span className="text-foreground">{b.ref_code}</span></p>
          <h1 className="mt-2 font-display text-xl leading-tight uppercase">{b.service_name}</h1>
        </div>
        <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABELS[b.status]}</Badge>
      </div>

      <dl className="mt-6 divide-y divide-line rounded-md border border-line bg-surface-1 text-sm">
        <Row k={b.multi_day ? 'Сдать авто' : 'Когда'} v={b.multi_day ? `${formatDay(b.start_at, tz)}, ${formatTime(b.start_at, tz)}` : formatWindow(b.start_at, b.end_at, tz, false)} />
        {b.multi_day && <Row k="Готово ≈" v={`${formatDay(b.end_at, tz)}, ${formatTime(b.end_at, tz)}`} />}
        <Row k="Автомобиль" v={`${b.vehicle.make} ${b.vehicle.model}${b.vehicle.year ? `, ${b.vehicle.year}` : ''}`} />
        <Row k="Класс" v={VEHICLE_CLASS_LABELS[b.vehicle_class].label} />
        {b.vehicle.plate && <Row k="Госномер" v={<span className="font-mono">{b.vehicle.plate}</span>} />}
        <Row k="Стоимость" v={<span className="font-mono tabular">{formatPriceFrom(b.price_from_minor)}</span>} />
        <Row k="Контакт" v={<span>{b.contact_name} · <span className="font-mono">{b.contact_phone_masked}</span></span>} />
        <Row k="Адрес" v={storefront.profile.address} />
      </dl>

      {b.can_modify ? (
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={() => setSheet('reschedule')}>
            <CalendarClock /> Перенести
          </Button>
          <Button variant="danger" onClick={() => setSheet('cancel')}>
            <X /> Отменить
          </Button>
        </div>
      ) : (
        ['requested', 'confirmed'].includes(b.status) && (
          <p className="mt-6 text-sm text-muted-foreground">
            Изменить запись онлайн можно не позднее чем за {storefront.policy.cancel_cutoff_hours} ч до визита.
            {storefront.profile.phone_display && ` Позвоните: ${storefront.profile.phone_display}`}
          </p>
        )
      )}

      <Sheet open={sheet === 'reschedule'} onOpenChange={(o) => setSheet(o ? 'reschedule' : null)}>
        <SheetContent className="px-4 pt-5 pb-safe">
          <SheetTitle>Перенос записи</SheetTitle>
          <SheetDescription className="mt-1">Выберите новое время. Текущее сохранится, если новое не удастся занять.</SheetDescription>
          <div className="mt-5 overflow-y-auto">
            <SlotPicker tz={tz} days={options.data?.days} loading={options.isPending} selected={slot} onSelect={setSlot} multiDay={b.multi_day} />
          </div>
          {reschedule.isError && <p role="alert" className="mt-3 text-sm text-danger">{errorMessage(reschedule.error)}</p>}
          <Button className="mt-5 w-full" size="lg" disabled={!slot || reschedule.isPending} onClick={() => reschedule.mutate()}>
            {reschedule.isPending && <Loader2 className="animate-spin" />} Перенести
          </Button>
        </SheetContent>
      </Sheet>

      <Sheet open={sheet === 'cancel'} onOpenChange={(o) => setSheet(o ? 'cancel' : null)}>
        <SheetContent className="px-4 pt-5 pb-safe">
          <SheetTitle>Отменить запись?</SheetTitle>
          <SheetDescription className="mt-1">Время освободится для других клиентов.</SheetDescription>
          <Textarea className="mt-4" placeholder="Причина (необязательно)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          {cancel.isError && <p role="alert" className="mt-3 text-sm text-danger">{errorMessage(cancel.error)}</p>}
          <Button className="mt-5 w-full" size="lg" variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending && <Loader2 className="animate-spin" />} Отменить запись
          </Button>
        </SheetContent>
      </Sheet>

      <Link to={`/s/${slug}`} className="mt-10 inline-block text-sm text-muted-foreground hover:text-foreground">← {storefront.tenant.name}</Link>
    </main>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 px-4 py-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}
