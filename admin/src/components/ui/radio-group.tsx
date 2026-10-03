import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from '@/lib/utils';

const RadioGroup = RadioGroupPrimitive;

function RadioGroupItem<Value>({ className, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, ...props }: RadioPrimitive.Root.Props<Value>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      aria-label={ariaLabel}
      // 显式名称优先，外层选项卡片的说明仍作为独立文案保留。
      aria-labelledby={ariaLabelledBy ?? (ariaLabel ? '' : undefined)}
      className={cn('group inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)] data-[disabled]:pointer-events-none data-[disabled]:opacity-55', className)}
      {...props}
    >
      <span aria-hidden="true" className="flex size-4 items-center justify-center rounded-full border border-input bg-card group-data-[checked]:border-primary"><RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" /></span>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
