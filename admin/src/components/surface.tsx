import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 仅为独立编辑、技术内容或恢复状态建立边界；普通分区使用连续画布。
export function Surface({
  children,
  variant = 'standard',
  className,
  ...props
}: {
  children: ReactNode;
  variant?: 'standard' | 'inset' | 'raised' | 'section';
  className?: string;
} & Omit<React.ComponentProps<'section'>, 'children' | 'className'>) {
  return (
    <section
      data-slot="surface"
      data-variant={variant}
      className={cn(
        variant !== 'section' && 'rounded-lg border',
        variant === 'section' && 'border-t bg-transparent pt-6',
        variant === 'inset' && 'bg-muted',
        variant === 'raised' && 'bg-card',
        variant === 'standard' && 'bg-card',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}
