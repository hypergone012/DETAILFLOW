import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-12 w-full min-w-0 rounded-md border border-input bg-surface-1 px-3.5 text-base text-foreground outline-none transition-colors placeholder:text-faint-foreground focus-visible:border-accent aria-invalid:border-danger disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
