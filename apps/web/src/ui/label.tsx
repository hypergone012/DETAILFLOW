import { Label as LabelPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn('text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground', className)}
      {...props}
    />
  )
}
