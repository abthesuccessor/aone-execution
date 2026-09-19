import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border text-xs font-medium transition-[background-color,border-color,color,transform] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-[#39c6b6] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121c20] disabled:pointer-events-none disabled:opacity-50 active:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-[#2d8f86] bg-[#1d716a] text-[#effffc] hover:border-[#43bdb0] hover:bg-[#27837a]',
        secondary: 'border-[#31454b] bg-[#1a282d] text-[#dce8ea] hover:border-[#45616a] hover:bg-[#22343a]',
        warning: 'border-[#8b662c] bg-[#765421] text-[#fff4d6] hover:border-[#b58536] hover:bg-[#896328]',
        destructive: 'border-[#8b4247] bg-[#74343a] text-[#fff1f2] hover:border-[#b5545c] hover:bg-[#884048]',
        outline: 'border-[#355058] bg-transparent text-[#dce8ea] hover:bg-[#18262b]',
        ghost: 'border-transparent bg-transparent text-[#bed0d3] hover:bg-[#1a282d] hover:text-[#eff7f8]',
      },
      size: {
        default: 'h-8 px-3 py-1.5',
        sm: 'h-7 px-2.5 py-1',
        lg: 'h-9 px-4 py-2',
        icon: 'size-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
