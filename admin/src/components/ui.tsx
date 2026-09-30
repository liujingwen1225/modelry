import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { Link, type LinkProps } from 'react-router-dom';
import { useI18n } from '../i18n/i18n';
import { cn } from '@/lib/utils';
import { Button as ButtonPrimitive, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogCloseButton,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from '@/components/ui/dialog';
import {
  Sheet as SheetRoot,
  SheetContent,
  SheetCloseButton,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from '@/components/ui/sheet';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'default' | 'small';
};

const legacyVariants = { primary: 'default', secondary: 'outline', quiet: 'ghost', danger: 'destructive' } as const;

export function Button({ variant = 'secondary', size = 'default', className, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      variant={legacyVariants[variant]}
      size={size === 'small' ? 'sm' : 'default'}
      className={className}
      {...props}
    />
  );
}

export function ButtonLink({ variant = 'secondary', size = 'default', className, ...props }: Omit<LinkProps, 'className'> & Pick<ButtonProps, 'variant' | 'size'> & { className?: string }) {
  return (
    <Link
      data-slot="button"
      className={cn(buttonVariants({
        variant: legacyVariants[variant],
        size: size === 'small' ? 'sm' : 'default',
        className,
      }))}
      {...props}
    />
  );
}

export function Surface({
  children,
  variant = 'standard',
  className,
}: {
  children: ReactNode;
  variant?: 'standard' | 'inset' | 'raised';
  className?: string;
}) {
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
    >
      {children}
    </section>
  );
}

const chipVariants: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'outline'> = {
  ready: 'success',
  active: 'success',
  ok: 'success',
  degraded: 'warning',
  stopping: 'warning',
  partial: 'warning',
  pending: 'warning',
  unavailable: 'danger',
  failed: 'danger',
  error: 'danger',
  unknown: 'info',
  starting: 'info',
  loading: 'info',
  configuring: 'info',
};

export function StatusChip({ state, children }: { state: string; children: ReactNode }) {
  const tone = state.toLowerCase().replace(/[^a-z]+/g, '-');
  return <Badge variant={chipVariants[tone] ?? 'default'}>{children}</Badge>;
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div aria-label={label} role="status" className="flex items-center gap-2 rounded-md bg-info-soft px-3 py-3 text-[11px] text-info">
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
    <div role="status" className="rounded-md border border-dashed border-input bg-secondary px-3 py-3 text-[11px] text-ink-secondary">
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
}: {
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('rounded-md border border-danger/30 bg-danger-soft px-3 py-3 text-[11px] text-danger', className)}>
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

export function FormField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const describedChild = hintId && isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
        'aria-describedby': [
          (children.props as { 'aria-describedby'?: string })['aria-describedby'],
          hintId,
        ].filter(Boolean).join(' '),
      })
    : children;
  return (
    <div data-slot="form-field" className="grid gap-1.5 [&_input]:min-h-9 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-input [&_input]:bg-card [&_input]:px-3 [&_input]:py-2 [&_input]:text-xs [&_input]:transition-[color,box-shadow] [&_input]:outline-none [&_input:hover]:border-subtle-foreground [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-1 [&_input:focus-visible]:outline-ring [&_input:disabled]:opacity-55 [&_select]:min-h-9 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-input [&_select]:bg-card [&_select]:px-3 [&_select]:py-2 [&_select]:text-xs [&_textarea]:min-h-16 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-input [&_textarea]:bg-card [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-xs">
      <label htmlFor={htmlFor} className="text-[11px] font-semibold text-ink-secondary">{label}</label>
      {describedChild}
      {hint && <p className="m-0 text-[10px] text-muted-foreground" id={hintId}>{hint}</p>}
    </div>
  );
}

export function DataTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <Table>
      <caption>{caption}</caption>
      <TableHeader>
        <tr>
          {headers.map((header) => (
            <TableHead key={header} scope="col">{header}</TableHead>
          ))}
        </tr>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {row.map((cell, cellIndex) => (
              <TableCell key={cellIndex}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const feedbackId = useId();

  async function handleCopy() {
    try {
      await copyText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <>
      <Button
        aria-label={label}
        aria-describedby={failed ? feedbackId : undefined}
        className="ml-auto min-h-6 px-1.5"
        onClick={() => void handleCopy()}
        size="small"
        type="button"
        variant="quiet"
      >
        {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
      <span className="sr-only" id={feedbackId} aria-live="polite">
        {failed ? t('common.copyFailed') : copied ? t('common.copiedToClipboard') : ''}
      </span>
    </>
  );
}

export function JsonViewer({ value, label }: { value: unknown; label: string }) {
  return (
    <details className="border-t pt-1.5 text-[10px] text-muted-foreground [&_pre]:mt-2 [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre]:leading-relaxed [&_pre]:text-ink-secondary [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary:hover]:text-primary">
      <summary>{label}</summary>
      <pre><code>{JSON.stringify(value, null, 2)}</code></pre>
    </details>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  closeLabel,
  size = 'standard',
  presentation = 'dialog',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
  size?: 'standard' | 'wide';
  presentation?: 'dialog' | 'sheet';
}) {
  const titleId = useId();

  function handleOpenChange(next: boolean) {
    if (!next) onClose();
  }

  if (presentation === 'sheet') {
    return (
      // Sheet 承载「保留列表上下文的详情与快速编辑」（spec 0001 §13.2），
      // 必须保持列表可查询/可读屏：非 modal 形态不对外部内容施加 inert/aria-hidden。
      <SheetRoot modal={false} open={open} onOpenChange={handleOpenChange}>
        <SheetContent size={size} aria-labelledby={titleId}>
          <SheetHeader>
            <SheetTitle id={titleId}>{title}</SheetTitle>
            <SheetCloseButton aria-label={closeLabel} />
          </SheetHeader>
          <SheetBody>{children}</SheetBody>
        </SheetContent>
      </SheetRoot>
    );
  }

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size={size} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId}>{title}</DialogTitle>
          <DialogCloseButton aria-label={closeLabel} />
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

export function Sheet(props: Omit<Parameters<typeof Dialog>[0], 'presentation'>) {
  return <Dialog {...props} presentation="sheet" />;
}

export function FocusedWorkspace({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-[880px] min-w-0">{children}</main>;
}

export function SplitPane({
  primary,
  secondary,
}: {
  primary: ReactNode;
  secondary: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 min-[681px]:grid-cols-[minmax(0,1fr)_minmax(270px,0.8fr)] [&>aside]:min-w-0 [&>section]:min-w-0">
      <section>{primary}</section>
      <aside>{secondary}</aside>
    </div>
  );
}
