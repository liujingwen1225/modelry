import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

function Checkbox({ className, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      aria-label={ariaLabel}
      // 显式名称优先，避免框架把整个外层标签的说明也拼入控件名称。
      aria-labelledby={ariaLabelledBy ?? (ariaLabel ? '' : undefined)}
      className={cn('group inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-primary-foreground outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)] data-[disabled]:pointer-events-none data-[disabled]:opacity-55', className)}
      {...props}
    >
      <span aria-hidden="true" className="flex size-4 items-center justify-center rounded border border-input bg-card group-data-[checked]:border-primary group-data-[checked]:bg-primary"><CheckboxPrimitive.Indicator><Check size={12} strokeWidth={3} /></CheckboxPrimitive.Indicator></span>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
