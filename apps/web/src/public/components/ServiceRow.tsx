import { CATEGORY_LABELS, formatDuration, formatPriceFrom, type StorefrontService } from '@detailflow/domain'
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

export function ServiceRow({ service, to, className }: { service: StorefrontService; to: string; className?: string }) {
  return (
    <Link
      to={to}
      className={cn(
        'group flex items-center gap-4 border-b border-line py-4 transition-colors hover:bg-surface-1 active:bg-surface-2 sm:px-3',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] tracking-[0.14em] text-faint-foreground uppercase">{CATEGORY_LABELS[service.category]}</p>
        <p className="mt-1 font-medium text-foreground">{service.name}</p>
        {service.summary && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{service.summary}</p>}
      </div>
      <div className="shrink-0 text-right">
        <p className="font-mono text-sm tabular text-foreground">{formatPriceFrom(service.price_from_minor)}</p>
        <p className="mt-0.5 font-mono text-xs tabular text-muted-foreground">{formatDuration(service.duration_min, service.multi_day)}</p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-faint-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  )
}
