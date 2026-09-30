import { BOOKING_STATUSES, STATUS_LABELS, formatPriceFrom } from '@detailflow/domain'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/lib/api'
import { formatDayShort, formatTime } from '@/lib/format'
import { STATUS_TONE } from '@/lib/status'
import { cn } from '@/lib/utils'
import { ownerApi } from '@/owner/api'
import { useTenant } from '@/tenant/context'
import { Badge } from '@/ui/badge'
import { Input } from '@/ui/input'
import { Skeleton } from '@/ui/skeleton'

export function BookingsPage() {
  const { slug, storefront } = useTenant()
  const tz = storefront.tenant.timezone
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const list = useQuery({ queryKey: ['owner', slug, 'bookings', status, q], queryFn: () => ownerApi.bookings(slug, { status, q }), placeholderData: (prev) => prev })
  return (
    <main className="mx-auto max-w-7xl px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-medium">Записи</h1>
        <Input className="ml-auto h-10 w-full sm:w-72" placeholder="Номер, телефон, имя, № записи" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" />
      </div>
      <div className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {['', ...BOOKING_STATUSES].map((s) => (
          <button key={s || 'all'} type="button" onClick={() => setStatus(s)}
            className={cn('shrink-0 rounded-sm border px-2.5 py-1 text-xs', status === s ? 'border-accent text-foreground' : 'border-line-strong text-muted-foreground hover:text-foreground')}>
            {s ? STATUS_LABELS[s as keyof typeof STATUS_LABELS] : 'Все'}
          </button>
        ))}
      </div>
      {list.isPending && <Skeleton className="mt-4 h-64" />}
      {list.isError && <p className="mt-4 text-danger">{errorMessage(list.error)}</p>}
      {list.data && (
        list.data.bookings.length === 0 ? <p className="mt-6 text-sm text-muted-foreground" aria-busy={list.isFetching}>Ничего не найдено</p> : (
          <div className="mt-4 overflow-x-auto rounded-md border border-line" aria-busy={list.isFetching}>
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-surface-1 text-left font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                <tr>
                  <th className="px-3 py-2 font-normal">Когда</th><th className="px-3 py-2 font-normal">Автомобиль</th><th className="px-3 py-2 font-normal">Услуга</th>
                  <th className="px-3 py-2 font-normal">Клиент</th><th className="px-3 py-2 font-normal">Бокс</th><th className="px-3 py-2 text-right font-normal">Цена</th><th className="px-3 py-2 font-normal">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.bookings.map((b) => (
                  <tr key={b.id} className="h-10 hover:bg-surface-1">
                    <td className="px-3 font-mono text-xs whitespace-nowrap tabular"><Link to={`/s/${slug}/owner/bookings/${b.id}`} className="hover:text-accent">{formatDayShort(b.start_at, tz)} {formatTime(b.start_at, tz)}</Link></td>
                    <td className="px-3 whitespace-nowrap">{b.vehicle.make} {b.vehicle.model} <span className="font-mono text-xs text-muted-foreground">{b.vehicle.plate}</span></td>
                    <td className="px-3">{b.service_name}</td>
                    <td className="px-3 whitespace-nowrap">{b.contact_name}</td>
                    <td className="px-3 text-muted-foreground">{b.resource_name ?? '—'}</td>
                    <td className="px-3 text-right font-mono text-xs tabular">{b.final_price_minor ? `${Number(b.final_price_minor) / 100} ₽` : formatPriceFrom(Number(b.price_from_minor))}</td>
                    <td className="px-3"><Badge tone={STATUS_TONE[b.status]}>{STATUS_LABELS[b.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </main>
  )
}
