import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg text-xs font-semibold leading-tight transition-[background-color,border-color,color,transform] duration-200 focus-visible:outline-none focus-visible:shadow-none disabled:pointer-events-none disabled:opacity-55 active:not-disabled:translate-y-px [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'border border-input bg-card text-ink-secondary hover:bg-accent-cta-soft hover:text-accent-cta-ink',
        ghost: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-95',
        link: 'text-primary underline-offset-4 hover:underline',
        unstyled: '',
      },
      size: {
        default: 'min-h-9 px-3.5',
        sm: 'min-h-8 px-2.5 text-[11px]',
        icon: 'size-9',
        'icon-sm': 'size-8',
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
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants>) {
  // 列表选项、导航和紧凑图标按钮保留各自布局，交互统一由框架管理。
  return <ButtonPrimitive data-slot="button" className={variant === 'unstyled'
    ? cn('cursor-pointer outline-none focus-visible:outline-none focus-visible:shadow-none disabled:pointer-events-none disabled:opacity-55', className)
    : cn(buttonVariants({ variant, size, className }))} {...props} />;
}

// 原生导航链接复用按钮样式，登录页等入口无需依赖路由上下文。
function ButtonAnchor({ className, variant = 'outline', size, ...props }: React.ComponentProps<'a'> & VariantProps<typeof buttonVariants>) {
  return <a data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, ButtonAnchor, buttonVariants };
