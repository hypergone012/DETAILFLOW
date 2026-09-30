import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em] whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-line-strong text-muted-foreground',
        accent: 'border-accent/40 bg-accent-subtle text-accent',
        success: 'border-success/40 bg-success/10 text-success',
        warning: 'border-warning/40 bg-warning/10 text-warning',
        danger: 'border-danger/40 bg-danger/10 text-danger',
        info: 'border-info/40 bg-info/10 text-info',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />
}
