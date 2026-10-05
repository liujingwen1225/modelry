import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn('fixed inset-0 z-10 bg-overlay', className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  size = 'standard',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & { size?: 'standard' | 'wide' }) {
  return (
    <DialogPortal>
      <DialogPrimitive.Viewport className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'relative z-20 flex max-h-[min(84vh,760px)] w-[min(calc(100vw-32px),520px)] flex-col overflow-auto rounded-lg border bg-card text-foreground shadow-floating outline-none',
          size === 'wide' && 'w-[min(calc(100vw-32px),820px)]',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3.5', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('m-0 text-base font-semibold tracking-tight', className)} {...props} />;
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('p-4', className)} {...props} />;
}

function DialogCloseButton({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn(
        'grid size-11 shrink-0 cursor-pointer place-items-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]',
        className,
      )}
      {...props}
    >
      <X aria-hidden="true" size={18} />
    </DialogPrimitive.Close>
  );
}

export { Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogCloseButton };
