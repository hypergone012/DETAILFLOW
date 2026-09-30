import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-on-accent hover:bg-accent-hover',
        secondary: 'border border-line-strong bg-surface-2 text-foreground hover:bg-surface-3',
        ghost: 'text-foreground hover:bg-surface-2',
        outline: 'border border-line-strong bg-transparent text-foreground hover:border-foreground/40',
        danger: 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-13 px-6 text-base',
        icon: 'size-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
