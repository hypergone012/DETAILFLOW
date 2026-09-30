import { CATEGORY_LABELS, VEHICLE_CLASS_LABELS, formatDuration, formatPriceFrom } from '@detailflow/domain'
import { ArrowLeft, ArrowRight, Info } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useTenant } from '@/tenant/context'
import { Button } from '@/ui/button'

export function ServicePage() {
  const { slug, storefront } = useTenant()
  const { serviceSlug } = useParams()
  const service = storefront.services.find((s) => s.slug === serviceSlug)
  if (!service) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <h1 className="font-display text-xl">Услуга не найдена</h1>
        <Link to={`/s/${slug}`} className="mt-4 inline-block text-accent">К списку услуг</Link>
      </main>
    )
  }
  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-32">
      <Link to={`/s/${slug}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Все услуги
      </Link>
      <p className="mt-6 font-mono text-[11px] tracking-[0.16em] text-accent uppercase">{CATEGORY_LABELS[service.category]}</p>
      <h1 className="mt-2 font-display text-2xl leading-tight uppercase sm:text-3xl">{service.name}</h1>
      <p className="mt-4 leading-relaxed text-muted-foreground">{service.description || service.summary}</p>

      <div className="mt-8 overflow-hidden rounded-md border border-line">
        <table className="w-full text-sm">
          <caption className="border-b border-line bg-surface-1 px-4 py-2.5 text-left font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
            Цена и время по классу автомобиля
          </caption>
          <tbody>
            <tr className="border-b border-line">
              <th scope="row" className="px-4 py-3 text-left font-normal text-muted-foreground">Базовая</th>
              <td className="px-4 py-3 text-right font-mono tabular">{formatDuration(service.duration_min, service.multi_day)}</td>
              <td className="px-4 py-3 text-right font-mono tabular">{formatPriceFrom(service.price_from_minor)}</td>
            </tr>
            {service.variants.map((v) => (
              <tr key={v.vehicle_class} className="border-b border-line last:border-0">
                <th scope="row" className="px-4 py-3 text-left font-normal">{VEHICLE_CLASS_LABELS[v.vehicle_class].label}</th>
                <td className="px-4 py-3 text-right font-mono tabular">{formatDuration(v.duration_min, service.multi_day)}</td>
                <td className="px-4 py-3 text-right font-mono tabular">{formatPriceFrom(v.price_from_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {service.multi_day && (
        <p className="mt-4 flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" /> Автомобиль остаётся в студии на время работ — вы выбираете время, когда привезёте его.
        </p>
      )}
      {service.requires_confirmation && (
        <p className="mt-2 flex gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-accent" /> Запись подтверждает студия — обычно в течение рабочего дня.
        </p>
      )}
      {service.requirements.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-sm uppercase">Подготовка</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            {service.requirements.map((r) => (
              <li key={r} className="border-l-2 border-accent/60 pl-3">{r}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-background/95 px-4 pt-3 pb-safe backdrop-blur-md">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-4">
          <div>
            <p className="font-mono text-sm tabular">{formatPriceFrom(service.price_from_minor)}</p>
            <p className="font-mono text-xs text-muted-foreground">{formatDuration(service.duration_min, service.multi_day)}</p>
          </div>
          <Button asChild size="lg">
            <Link to={`/s/${slug}/book?service=${service.slug}`}>
              Выбрать время <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
