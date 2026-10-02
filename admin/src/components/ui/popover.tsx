import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '@/lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({ className, ...props }: React.ComponentProps<typeof PopoverPrimitive.Popup>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner align="end" sideOffset={8} className="z-50 outline-none">
        <PopoverPrimitive.Popup data-slot="popover-content" className={cn('max-w-[calc(100vw-24px)] rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-floating outline-none', className)} {...props} />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
