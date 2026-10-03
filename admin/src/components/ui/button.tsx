import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-11! min-w-11! cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-medium leading-tight transition-colors duration-200 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)] disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0',
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
        default: 'min-h-11 px-4',
        sm: 'min-h-11 px-3 text-[13px]',
        icon: 'size-11',
        'icon-sm': 'size-11',
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
    ? cn('relative min-h-11! min-w-11! cursor-pointer outline-none focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)] disabled:pointer-events-none disabled:opacity-55', className)
    : cn(buttonVariants({ variant, size, className }))} {...props} />;
}

// 原生导航链接复用按钮样式，登录页等入口无需依赖路由上下文。
function ButtonAnchor({ className, variant = 'outline', size, ...props }: React.ComponentProps<'a'> & VariantProps<typeof buttonVariants>) {
  return <a data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, ButtonAnchor, buttonVariants };
