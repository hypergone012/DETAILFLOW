import { STATUS_LABELS, formatPhone, formatPriceFrom, formatRub } from '@detailflow/domain'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { errorMessage } from '@/lib/api'
import { formatDayShort, formatTime } from '@/lib/format'
import { STATUS_TONE } from '@/lib/status'
import { ownerApi } from '@/owner/api'
import { useTenant } from '@/tenant/context'
import { Badge } from '@/ui/badge'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'
import { Textarea } from '@/ui/textarea'

export function CustomersPage() {
  const { slug, storefront } = useTenant()
  const [q, setQ] = useState('')
  const list = useQuery({ queryKey: ['owner', slug, 'customers', q], queryFn: () => ownerApi.customers(slug, q), placeholderData: (p) => p })
  return (
    <main className="mx-auto max-w-5xl px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">Клиенты</h1>
        <Input className="ml-auto h-10 w-full sm:w-72" placeholder="Имя, телефон, госномер" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" />
      </div>
      {list.isPending && <Skeleton className="mt-4 h-64" />}
      {list.isError && <p className="mt-4 text-danger">{errorMessage(list.error)}</p>}
      {list.data && (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-md border border-line bg-surface-1">
          {list.data.customers.map((c) => (
            <li key={c.id}>
              <Link to={`/s/${slug}/owner/customers/${c.id}`} className="grid grid-cols-[1fr_auto] gap-3 px-3 py-3 hover:bg-surface-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{c.vehicles ?? '—'}</span>
                </span>
                <span className="text-right">
                  <span className="block font-mono text-xs">{formatPhone(c.phone_e164)}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{c.bookings} зап.{c.last_visit ? ` · ${formatDayShort(c.last_visit, storefront.tenant.timezone)}` : ''}</span>
                </span>
              </Link>
            </li>
          ))}
          {list.data.customers.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">Никого не найдено</li>}
        </ul>
      )}
    </main>
  )
}

export function CustomerPage() {
  const { slug, storefront } = useTenant()
  const tz = storefront.tenant.timezone
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['owner', slug, 'customer', id], queryFn: () => ownerApi.customer(slug, id) })
  const [notes, setNotes] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (value: string) => ownerApi.saveNotes(slug, id, value),
    onSuccess: () => {
      setNotes(null)
      void queryClient.invalidateQueries({ queryKey: ['owner', slug, 'customer', id] })
    },
  })
  if (data.isPending) return <Skeleton className="m-4 h-80" />
  if (data.isError) return <p className="p-6 text-danger">{errorMessage(data.error)}</p>
  const { customer, vehicles, bookings } = data.data
  return (
    <main className="mx-auto max-w-5xl px-4 py-4">
      <Link to={`/s/${slug}/owner/customers`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Клиенты</Link>
      <h1 className="mt-3 text-xl font-medium">{customer.name}</h1>
      <p className="mt-1 font-mono text-sm"><a href={`tel:${customer.phone_e164}`} className="text-accent">{formatPhone(customer.phone_e164)}</a>{customer.email && <span className="ml-3 text-muted-foreground">{customer.email}</span>}</p>
      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <section className="rounded-md border border-line bg-surface-1 p-4">
            <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Заметки студии</h2>
            <Textarea className="mt-2" value={notes ?? customer.internal_notes} onChange={(e) => setNotes(e.target.value)} placeholder="Видны только сотрудникам студии" />
            {notes !== null && <Button size="sm" className="mt-2" disabled={save.isPending} onClick={() => save.mutate(notes)}>Сохранить</Button>}
          </section>
          <section className="rounded-md border border-line bg-surface-1 p-4">
            <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Автомобили · {vehicles.length}</h2>
            <ul className="mt-2 divide-y divide-line text-sm">
              {vehicles.map((v) => (
                <li key={v.id} className="py-2">
                  {v.make} {v.model}{v.year ? `, ${v.year}` : ''} {v.plate && <span className="font-mono text-xs text-muted-foreground">{v.plate}</span>}
                  {v.notes && <p className="text-xs text-muted-foreground">{v.notes}</p>}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <section className="rounded-md border border-line bg-surface-1 p-4">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Записи · {bookings.length}</h2>
          <ul className="mt-2 divide-y divide-line text-sm">
            {bookings.map((b) => (
              <li key={b.id}>
                <Link to={`/s/${slug}/owner/bookings/${b.id}`} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-3 py-2 hover:text-accent">
                  <span className="font-mono text-xs tabular">{formatDayShort(b.start_at, tz)} {formatTime(b.start_at, tz)}</span>
                  <span className="truncate">{b.service_name} · <span className="text-muted-foreground">{b.vehicle.make} {b.vehicle.model}</span></span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{b.final_price_minor ? formatRub(Number(b.final_price_minor)) : formatPriceFrom(Number(b.price_from_minor))}</span>
                    <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABELS[b.status]}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}
