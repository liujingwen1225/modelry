import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'default' | 'small';
};

export function Button({ variant = 'secondary', size = 'default', className = '', ...props }: ButtonProps) {
  return <button className={`button button--${variant} button--${size} ${className}`.trim()} {...props} />;
}

export function Surface({
  children,
  variant = 'standard',
  className = '',
}: {
  children: ReactNode;
  variant?: 'standard' | 'inset' | 'raised';
  className?: string;
}) {
  return <section className={`surface surface--${variant} ${className}`.trim()}>{children}</section>;
}

export function StatusChip({ state, children }: { state: string; children: ReactNode }) {
  const tone = state.toLowerCase().replace(/[^a-z]+/g, '-');
  return <span className={`status-chip status-chip--${tone}`}>{children}</span>;
}

export function LoadingState({ label }: { label: string }) {
  return <div aria-label={label} className="loading-state" role="status"><span className="pulse-dot" aria-hidden="true" />{label}</div>;
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
  return <div className="empty-state" role="status"><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export function ErrorState({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return <div className={`error-state ${className}`.trim()} role="alert"><strong>{title}</strong><p>{description}</p>{children}</div>;
}

export function PartialState({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`partial-state ${className}`.trim()} role="status">{children}</div>;
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
    <div className="form-field">
      <label htmlFor={htmlFor}>{label}</label>
      {describedChild}
      {hint && <p className="form-hint" id={hintId}>{hint}</p>}
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
    <div className="table-scroll">
      <table className="data-table">
        <caption>{caption}</caption>
        <thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
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

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
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
        className="copy-button"
        onClick={() => void handleCopy()}
        size="small"
        type="button"
        variant="quiet"
      >
        {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="sr-only" id={feedbackId} aria-live="polite">
        {failed ? 'Could not copy. Select and copy the value manually.' : copied ? 'Copied to clipboard.' : ''}
      </span>
    </>
  );
}

export function JsonViewer({ value, label = 'Structured details' }: { value: unknown; label?: string }) {
  return (
    <details className="json-viewer">
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
  closeLabel = 'Close dialog',
  size = 'standard',
  presentation = 'dialog',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  size?: 'standard' | 'wide';
  presentation?: 'dialog' | 'sheet';
}) {
  const titleId = useId();
  return (
    <dialog
      aria-labelledby={titleId}
      className={`dialog dialog--${size}${presentation === 'sheet' ? ' sheet' : ''}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      ref={(element) => {
        if (!element) return;
        if (open && !element.open) {
          if (typeof element.showModal === 'function') element.showModal();
          else element.setAttribute('open', '');
        } else if (!open && element.open) {
          if (typeof element.close === 'function') element.close();
          else element.removeAttribute('open');
        }
      }}
      >
      <header className="dialog__header">
        <h2 id={titleId}>{title}</h2>
        <Button aria-label={closeLabel} onClick={onClose} variant="quiet"><X aria-hidden="true" size={18} /></Button>
      </header>
      <div className="dialog__body">{children}</div>
    </dialog>
  );
}

export function Sheet(props: Omit<Parameters<typeof Dialog>[0], 'presentation'>) {
  return <Dialog {...props} presentation="sheet" />;
}

export function FocusedWorkspace({ children }: { children: ReactNode }) {
  return <main className="focused-workspace">{children}</main>;
}

export function SplitPane({
  primary,
  secondary,
}: {
  primary: ReactNode;
  secondary: ReactNode;
}) {
  return <div className="split-pane"><section>{primary}</section><aside>{secondary}</aside></div>;
}
