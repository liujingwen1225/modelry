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
      className={cn('inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border border-input bg-card text-primary-foreground outline-none data-[checked]:border-primary data-[checked]:bg-primary focus-visible:outline-none focus-visible:shadow-none data-[disabled]:pointer-events-none data-[disabled]:opacity-55', className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator><Check aria-hidden="true" size={12} strokeWidth={3} /></CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
