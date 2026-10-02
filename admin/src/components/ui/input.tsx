import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex min-h-9 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:border-0 file:bg-transparent file:text-xs file:font-medium placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55',
        type === 'file' && 'border-dashed bg-secondary p-1.5 text-[11px] text-ink-secondary file:mr-2 file:rounded-md file:bg-muted file:px-2 file:py-1 file:text-[11px] file:font-semibold',
        'focus-visible:border-input focus-visible:outline-none focus-visible:shadow-none',
        'aria-invalid:border-destructive aria-invalid:outline-destructive',
        className,
      )}
      {...props}
    />
  );
}

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-55',
        'focus-visible:border-input focus-visible:outline-none focus-visible:shadow-none',
        'aria-invalid:border-destructive aria-invalid:outline-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input, Textarea, Label };
