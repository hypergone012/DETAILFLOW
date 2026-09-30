import {
  CATEGORY_LABELS,
  SERVICE_CATEGORIES,
  VEHICLE_CLASSES,
  VEHICLE_CLASS_LABELS,
  formatDuration,
  formatPriceFrom,
  normalizePhone,
  resolveVariant,
  vehicleInputSchema,
  type StorefrontService,
  type VehicleClass,
  type VehicleInput,
} from '@detailflow/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { SlotPicker, type PickedSlot } from '@/booking/SlotPicker'
import { savedBookings, savedContact, savedVehicles, sessionDraft } from '@/booking/storage'
import { ApiError, errorMessage, publicApi } from '@/lib/api'
import { addDaysIso, formatWindow, todayIn } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DemoBanner } from '@/public/PublicLayout'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Label } from '@/ui/label'
import { Textarea } from '@/ui/textarea'

type Step = 'service' | 'vehicle' | 'time' | 'contact' | 'review'
const STEPS: Step[] = ['service', 'vehicle', 'time', 'contact', 'review']
const STEP_TITLES: Record<Step, string> = {
  service: 'Услуга',
  vehicle: 'Автомобиль',
  time: 'Дата и время',
  contact: 'Контакты',
  review: 'Подтверждение',
}

interface Draft {
  serviceSlug: string | null
  vehicle: VehicleInput
  slot: PickedSlot | null
  contact: { name: string; phone: string; email: string }
  comment: string
  consent: boolean
  /** Generated at the first submit; dropped whenever the request content changes. */
  idempotencyKey: string | null
}

const EMPTY_VEHICLE: VehicleInput = { make: '', model: '', year: null, color: '', vehicleClass: 'sedan', plate: null, notes: '' }

export function BookingPage() {
  const { slug, storefront } = useTenant()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const store = useMemo(() => sessionDraft<Draft & { step: Step }>(`df:draft:${slug}`), [slug])

  const [draft, setDraft] = useState<Draft>(() => {
    const saved = store.load()
    const preselected = params.get('service')
    const contact = savedContact.get(slug)
    const base: Draft = saved ?? {
      serviceSlug: null,
      vehicle: savedVehicles.list(slug)[0] ?? EMPTY_VEHICLE,
      slot: null,
      contact: contact ?? { name: '', phone: '', email: '' },
      comment: '',
      consent: false,
      idempotencyKey: null,
    }
    if (preselected && storefront.services.some((s) => s.slug === preselected) && preselected !== base.serviceSlug) {
      return { ...base, serviceSlug: preselected, slot: null, idempotencyKey: null }
    }
    return base
  })
  const [step, setStep] = useState<Step>(() => store.load()?.step ?? (draft.serviceSlug ? 'vehicle' : 'service'))
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => store.save({ ...draft, step }), [draft, step, store])

  /** Any change to what is being booked invalidates the idempotency key. */
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch, idempotencyKey: null }))

  const service = storefront.services.find((s) => s.slug === draft.serviceSlug) ?? null
  const tz = storefront.tenant.timezone
  const priced = service
    ? resolveVariant(
        { durationMin: service.duration_min, priceFromMinor: service.price_from_minor },
        service.variants.map((v) => ({ vehicleClass: v.vehicle_class, durationMin: v.duration_min, priceFromMinor: v.price_from_minor })),
        draft.vehicle.vehicleClass,
      )
    : null

  const from = todayIn(tz)
  const to = addDaysIso(from, Math.min(storefront.policy.horizon_days, 21))
  const availability = useQuery({
    queryKey: ['availability', slug, service?.id, draft.vehicle.vehicleClass, from, to],
    queryFn: ({ signal }) => publicApi.availability(slug, { serviceId: service!.id, vehicleClass: draft.vehicle.vehicleClass, from, to }, signal),
    enabled: step === 'time' && !!service,
    staleTime: 15_000,
  })

  const book = useMutation({
    mutationFn: async () => {
      const key = draft.idempotencyKey ?? crypto.randomUUID()
      if (!draft.idempotencyKey) setDraft((d) => ({ ...d, idempotencyKey: key }))
      const honeypot = (document.getElementById('df-website') as HTMLInputElement | null)?.value ?? ''
      return publicApi.createBooking(slug, {
        serviceId: service!.id,
        startAt: draft.slot!.startAt,
        vehicle: draft.vehicle,
        customer: { name: draft.contact.name.trim(), phone: draft.contact.phone, email: draft.contact.email.trim() || null, consent: true },
        comment: draft.comment,
        idempotencyKey: key,
        ...(honeypot ? { website: honeypot } : {}),
      })
    },
    onSuccess: (res) => {
      savedVehicles.remember(slug, draft.vehicle)
      savedContact.set(slug, draft.contact)
      savedBookings.add(slug, { token: res.manageToken, ref: res.refCode, startAt: draft.slot!.startAt, service: service!.name })
      store.clear()
      void queryClient.invalidateQueries({ queryKey: ['availability', slug] })
      navigate(`/s/${slug}/b/${res.manageToken}`, { replace: true, state: { created: true } })
    },
    onError: (err) => {
      if (err instanceof ApiError && ['SLOT_TAKEN', 'SLOT_NOT_OFFERED', 'OUTSIDE_BOOKING_WINDOW'].includes(err.code)) {
        update({ slot: null })
        setNotice(err.message)
        setStep('time')
        void queryClient.invalidateQueries({ queryKey: ['availability', slug] })
      }
    },
  })

  const index = STEPS.indexOf(step)
  const go = (s: Step) => {
    setNotice(null)
    setStep(s)
    window.scrollTo({ top: 0 })
  }
  const back = () => (index > 0 && !(index === 1 && params.get('service')) ? go(STEPS[index - 1]!) : navigate(`/s/${slug}`))

  return (
    <div className="flex min-h-dvh flex-col">
      {storefront.tenant.status === 'demo' && <DemoBanner />}
      <header className="sticky top-0 z-30 border-b border-line bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-lg items-center gap-3 px-2">
          <Button variant="ghost" size="icon" onClick={back} aria-label="Назад">
            <ArrowLeft className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
              Шаг {index + 1} из {STEPS.length} · {storefront.tenant.name}
            </p>
            <h1 className="truncate text-base font-medium">{STEP_TITLES[step]}</h1>
          </div>
        </div>
        <div className="flex h-0.5 gap-0.5 bg-transparent" aria-hidden>
          {STEPS.map((s, i) => (
            <div key={s} className={cn('flex-1 transition-colors', i <= index ? 'bg-accent' : 'bg-line')} />
          ))}
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 px-4 pt-5 pb-36">
        {notice && (
          <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
            {notice}
          </p>
        )}
        {step === 'service' && (
          <ServiceStep
            services={storefront.services}
            selected={draft.serviceSlug}
            onSelect={(s) => {
              update({ serviceSlug: s, slot: null })
              go('vehicle')
            }}
          />
        )}
        {step === 'vehicle' && <VehicleStep slug={slug} service={service} vehicle={draft.vehicle} onChange={(v) => update({ vehicle: v, slot: null })} />}
        {step === 'time' && service && (
          <SlotPicker
            tz={tz}
            days={availability.data?.days}
            loading={availability.isPending}
            selected={draft.slot}
            onSelect={(slot) => update({ slot })}
            multiDay={service.multi_day}
          />
        )}
        {step === 'time' && availability.isError && <p className="mt-4 text-sm text-danger">{errorMessage(availability.error)}</p>}
        {step === 'contact' && (
          <ContactStep
            contact={draft.contact}
            comment={draft.comment}
            consent={draft.consent}
            onChange={(patch) => update(patch)}
          />
        )}
        {step === 'review' && service && draft.slot && priced && (
          <ReviewStep service={service} draft={draft} tz={tz} priceFromMinor={priced.priceFromMinor} error={book.isError && !notice ? errorMessage(book.error) : null} />
        )}
      </main>

      <StickyBar
        summary={
          service && priced ? (
            <>
              <p className="truncate text-sm">{service.name}</p>
              <p className="font-mono text-xs text-muted-foreground tabular">
                {formatPriceFrom(priced.priceFromMinor)} · {formatDuration(priced.durationMin, service.multi_day)}
              </p>
            </>
          ) : null
        }
      >
        {step === 'service' && null}
        {step === 'vehicle' && (
          <Button size="lg" disabled={!vehicleInputSchema.safeParse(draft.vehicle).success} onClick={() => go('time')}>
            Дальше
          </Button>
        )}
        {step === 'time' && (
          <Button size="lg" disabled={!draft.slot} onClick={() => go('contact')}>
            Дальше
          </Button>
        )}
        {step === 'contact' && (
          <Button size="lg" disabled={!contactValid(draft)} onClick={() => go('review')}>
            Проверить
          </Button>
        )}
        {step === 'review' && (
          <Button size="lg" disabled={book.isPending} onClick={() => book.mutate()}>
            {book.isPending ? <Loader2 className="animate-spin" /> : <Check />} Записаться
          </Button>
        )}
      </StickyBar>
    </div>
  )
}

function contactValid(d: Draft): boolean {
  return d.contact.name.trim().length > 0 && !!normalizePhone(d.contact.phone) && d.consent && (!d.contact.email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.contact.email))
}

function StickyBar({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  if (!children && !summary) return null
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-background/95 px-4 pt-3 pb-safe backdrop-blur-md">
      <div className="mx-auto flex max-w-lg items-center justify-between gap-4">
        <div className="min-w-0">{summary}</div>
        {children}
      </div>
    </div>
  )
}

function ServiceStep({ services, selected, onSelect }: { services: StorefrontService[]; selected: string | null; onSelect: (slug: string) => void }) {
  return (
    <div className="space-y-6">
      {SERVICE_CATEGORIES.filter((c) => services.some((s) => s.category === c)).map((c) => (
        <section key={c}>
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">{CATEGORY_LABELS[c]}</h2>
          <div className="mt-2 space-y-2">
            {services.filter((s) => s.category === c).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.slug)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md border bg-surface-1 p-3.5 text-left transition-colors active:translate-y-px',
                  selected === s.slug ? 'border-accent' : 'border-line hover:border-line-strong',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.name}</p>
                  <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{s.summary}</p>
                </div>
                <div className="shrink-0 text-right font-mono text-xs tabular">
                  <p>{formatPriceFrom(s.price_from_minor)}</p>
                  <p className="text-muted-foreground">{formatDuration(s.duration_min, s.multi_day)}</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-faint-foreground">{hint}</p>}
    </div>
  )
}

function VehicleStep({ slug, service, vehicle, onChange }: { slug: string; service: StorefrontService | null; vehicle: VehicleInput; onChange: (v: VehicleInput) => void }) {
  const saved = savedVehicles.list(slug)
  const set = <K extends keyof VehicleInput>(k: K, v: VehicleInput[K]) => onChange({ ...vehicle, [k]: v })
  return (
    <div className="space-y-6">
      {saved.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Ваши автомобили на этом устройстве</p>
          <div className="flex flex-wrap gap-2">
            {saved.map((v) => (
              <button key={`${v.make}${v.model}${v.plate}`} type="button" onClick={() => onChange(v)} className="rounded-sm border border-line-strong px-3 py-1.5 text-sm hover:border-accent">
                {v.make} {v.model} {v.plate && <span className="font-mono text-xs text-muted-foreground">{v.plate}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <fieldset>
        <legend className="text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">Класс автомобиля</legend>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {VEHICLE_CLASSES.map((c: VehicleClass) => {
            const variant = service?.variants.find((v) => v.vehicle_class === c)
            return (
              <button
                key={c}
                type="button"
                aria-pressed={vehicle.vehicleClass === c}
                onClick={() => set('vehicleClass', c)}
                className={cn(
                  'rounded-md border p-3 text-left transition-colors active:translate-y-px',
                  vehicle.vehicleClass === c ? 'border-accent bg-accent-subtle' : 'border-line bg-surface-1 hover:border-line-strong',
                )}
              >
                <p className="text-sm font-medium">{VEHICLE_CLASS_LABELS[c].label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{VEHICLE_CLASS_LABELS[c].hint}</p>
                {service && (
                  <p className="mt-1.5 font-mono text-[11px] text-muted-foreground tabular">
                    {formatPriceFrom(variant?.price_from_minor ?? service.price_from_minor)}
                  </p>
                )}
              </button>
            )
          })}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Марка">{(id) => <Input id={id} value={vehicle.make} onChange={(e) => set('make', e.target.value)} placeholder="BMW" autoComplete="off" />}</Field>
        <Field label="Модель">{(id) => <Input id={id} value={vehicle.model} onChange={(e) => set('model', e.target.value)} placeholder="X5" autoComplete="off" />}</Field>
        <Field label="Год">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={vehicle.year ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, '').slice(0, 4))
                set('year', n ? n : null)
              }}
              placeholder="2021"
            />
          )}
        </Field>
        <Field label="Цвет">{(id) => <Input id={id} value={vehicle.color} onChange={(e) => set('color', e.target.value)} placeholder="Чёрный" />}</Field>
      </div>
      <Field label="Госномер" hint="Необязательно — поможет узнать авто при приёмке">
        {(id) => <Input id={id} className="font-mono uppercase" value={vehicle.plate ?? ''} onChange={(e) => set('plate', e.target.value || null)} placeholder="А123ВС77" />}
      </Field>
      <Field label="Что важно знать">
        {(id) => <Textarea id={id} value={vehicle.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Сколы на капоте, запах в салоне, особые пожелания" maxLength={1000} />}
      </Field>
    </div>
  )
}

function ContactStep({
  contact,
  comment,
  consent,
  onChange,
}: {
  contact: Draft['contact']
  comment: string
  consent: boolean
  onChange: (patch: Partial<Draft>) => void
}) {
  const phoneOk = !contact.phone || !!normalizePhone(contact.phone)
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">Аккаунт не нужен. Ссылку для управления записью покажем после подтверждения.</p>
      <Field label="Имя">{(id) => <Input id={id} value={contact.name} onChange={(e) => onChange({ contact: { ...contact, name: e.target.value } })} autoComplete="name" />}</Field>
      <Field label="Телефон">
        {(id) => (
          <Input
            id={id}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            aria-invalid={!phoneOk}
            value={contact.phone}
            onChange={(e) => onChange({ contact: { ...contact, phone: e.target.value } })}
            placeholder="+7 900 000-00-00"
            className="font-mono"
          />
        )}
      </Field>
      {!phoneOk && <p className="-mt-3 text-xs text-danger">Проверьте номер телефона</p>}
      <Field label="Email" hint="Необязательно">
        {(id) => <Input id={id} type="email" autoComplete="email" value={contact.email} onChange={(e) => onChange({ contact: { ...contact, email: e.target.value } })} />}
      </Field>
      <Field label="Комментарий">{(id) => <Textarea id={id} value={comment} onChange={(e) => onChange({ comment: e.target.value })} maxLength={1000} />}</Field>
      {/* Honeypot: invisible to people, filled by bots. */}
      <input id="df-website" name="website" tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" />
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-line bg-surface-1 p-3 text-sm">
        <input type="checkbox" checked={consent} onChange={(e) => onChange({ consent: e.target.checked })} className="mt-0.5 size-4 accent-[var(--tenant-accent)]" />
        <span className="text-muted-foreground">Согласен на обработку персональных данных для записи и связи со мной по этой записи (152-ФЗ).</span>
      </label>
    </div>
  )
}

function ReviewStep({ service, draft, tz, priceFromMinor, error }: { service: StorefrontService; draft: Draft; tz: string; priceFromMinor: number; error: string | null }) {
  const rows: Array<[string, ReactNode]> = [
    ['Услуга', service.name],
    ['Когда', formatWindow(draft.slot!.startAt, draft.slot!.endAt, tz, service.multi_day)],
    ['Автомобиль', `${draft.vehicle.make} ${draft.vehicle.model}${draft.vehicle.year ? `, ${draft.vehicle.year}` : ''}${draft.vehicle.color ? `, ${draft.vehicle.color.toLowerCase()}` : ''}`],
    ['Класс', VEHICLE_CLASS_LABELS[draft.vehicle.vehicleClass].label],
    ...(draft.vehicle.plate ? ([['Госномер', <span className="font-mono">{draft.vehicle.plate.toUpperCase()}</span>]] as Array<[string, ReactNode]>) : []),
    ['Контакт', `${draft.contact.name}, ${draft.contact.phone}`],
    ['Стоимость', <span className="font-mono tabular">{formatPriceFrom(priceFromMinor)}</span>],
  ]
  return (
    <div>
      <dl className="divide-y divide-line rounded-md border border-line bg-surface-1">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[7rem_1fr] gap-3 px-4 py-3 text-sm">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm text-muted-foreground">
        Итоговую стоимость мастер назовёт при осмотре автомобиля.
        {service.requires_confirmation ? ' Студия подтвердит запись — статус будет виден по ссылке.' : ''}
      </p>
      {error && (
        <p role="alert" className="mt-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
