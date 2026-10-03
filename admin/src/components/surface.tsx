import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 工作面：页面上成组内容的默认容器（spec 0001 §13.2）。
export function Surface({
  children,
  variant = 'standard',
  className,
  ...props
}: {
  children: ReactNode;
  variant?: 'standard' | 'inset' | 'raised';
  className?: string;
} & Omit<React.ComponentProps<'section'>, 'children' | 'className'>) {
  return (
    <section
      data-slot="surface"
      data-variant={variant}
      className={cn(
        'rounded-lg border',
        variant === 'inset' && 'bg-muted',
        variant === 'raised' && 'bg-card shadow-soft',
        variant === 'standard' && 'bg-card',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}
