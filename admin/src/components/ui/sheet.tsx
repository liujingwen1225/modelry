import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetPortal = DialogPrimitive.Portal;
const SheetClose = DialogPrimitive.Close;

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Backdrop>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn('fixed inset-0 z-10 bg-[rgb(12_19_23_/_48%)] backdrop-blur-[2px]', className)}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  size = 'standard',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup> & { size?: 'standard' | 'wide' }) {
  return (
    <SheetPortal>
      <DialogPrimitive.Viewport className="fixed inset-0 z-40 flex justify-end">
      <SheetOverlay />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          'relative z-20 flex h-full w-[min(560px,calc(100vw-18px))] flex-col overflow-auto rounded-l-lg border bg-card text-foreground shadow-floating outline-none',
          size === 'wide' && 'w-[min(820px,calc(100vw-18px))]',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3.5', className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn('m-0 font-mono text-[15px] font-semibold tracking-tight', className)} {...props} />;
}

function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-body" className={cn('p-4', className)} {...props} />;
}

function SheetCloseButton({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return (
    <DialogPrimitive.Close
      data-slot="sheet-close"
      className={cn(
        'grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:shadow-none',
        className,
      )}
      {...props}
    >
      <X aria-hidden="true" size={18} />
    </DialogPrimitive.Close>
  );
}

export { Sheet, SheetTrigger, SheetPortal, SheetClose, SheetOverlay, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetCloseButton };
