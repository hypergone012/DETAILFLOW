import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'min-h-24 w-full rounded-md border border-input bg-surface-1 px-3.5 py-3 text-base text-foreground outline-none transition-colors placeholder:text-faint-foreground focus-visible:border-accent aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}
