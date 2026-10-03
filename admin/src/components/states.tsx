import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

// 状态徽标 / Loading / Empty / Error / Partial 是四个共享的页面状态原语
// （spec 0001 §13.5、§14）。状态语义映射到设计系统的有限状态色
// （ready=success / degraded=warning / unavailable=danger / unknown=info），
// 颜色只作辅助，标签文本始终存在；data-status-tone 供测试与样式断言语义。
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
  const variant = chipVariants[tone] ?? 'default';
  return <Badge data-status-chip data-status-tone={variant} data-status-state={tone} variant={variant}>{children}</Badge>;
}

export function SpinnerLoadingState({ label }: { label: string }) {
  return <div aria-busy="true" aria-label={label} className="flex min-h-48 min-w-0 items-center justify-center text-muted-foreground" role="status">
    <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={22} strokeWidth={1.75} />
  </div>;
}

export function LoadingState({ label }: { label: string }) {
  return <SpinnerLoadingState label={label} />;
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
