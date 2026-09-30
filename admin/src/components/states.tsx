import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

// 状态徽标 / Loading / Empty / Error / Partial 是四个共享的页面状态原语
// （spec 0001 §13.5、§14）。状态语义只映射到设计系统的语义色。
const chipVariants: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'outline'> = {
  ready: 'success',
  active: 'success',
  ok: 'success',
  succeeded: 'success',
  applied: 'success',
  degraded: 'warning',
  stopping: 'warning',
  partial: 'warning',
  pending: 'warning',
  needsReview: 'warning',
  review: 'warning',
  unavailable: 'danger',
  failed: 'danger',
  error: 'danger',
  denied: 'danger',
  blocked: 'danger',
  unknown: 'info',
  starting: 'info',
  loading: 'info',
  configuring: 'info',
  info: 'info',
};

export function StatusChip({ state, children }: { state: string; children: ReactNode }) {
  const tone = state.toLowerCase().replace(/[^a-z]+/g, '-');
  return <Badge data-status-chip variant={chipVariants[tone] ?? 'default'}>{children}</Badge>;
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div aria-label={label} className="flex items-center gap-2 rounded-md bg-info-soft px-3 py-3 text-[11px] text-info" role="status">
      <span aria-hidden="true" className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-dashed border-input bg-secondary px-3 py-3 text-[11px] text-ink-secondary" role="status">
      <h3 className="mb-1 text-xs font-semibold">{title}</h3>
      <p className="m-0 text-[10px] text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  children,
  className,
  ...props
}: {
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<'div'>, 'children' | 'className'>) {
  return (
    <div role="alert" className={cn('rounded-md border border-danger/30 bg-danger-soft px-3 py-3 text-[11px] text-danger', className)} {...props}>
      <strong className="mb-1 block text-[11px]">{title}</strong>
      <p className="m-0 text-[10px] text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}

export function PartialState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" className={cn('rounded-md border border-warning/30 bg-warning-soft px-3 py-3 text-[11px] text-warning', className)}>
      {children}
    </div>
  );
}
