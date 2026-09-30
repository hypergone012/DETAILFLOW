import { Dialog as SheetPrimitive } from 'radix-ui'
import { X } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const Sheet = SheetPrimitive.Root
export const SheetTrigger = SheetPrimitive.Trigger
export const SheetClose = SheetPrimitive.Close

export function SheetContent({
  className,
  children,
  side = 'bottom',
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & { side?: 'bottom' | 'right' }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col bg-surface-1 shadow-2xl outline-none',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-lg border-t border-line-strong',
          side === 'right' && 'inset-y-0 right-0 h-full w-full max-w-xl border-l border-line-strong',
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-3 right-3 grid size-10 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground">
          <X className="size-5" />
          <span className="sr-only">Закрыть</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn('font-display text-lg', className)} {...props} />
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />
}
