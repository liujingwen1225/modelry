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
      className={cn('inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input bg-card outline-none data-[checked]:border-primary focus-visible:outline-none focus-visible:shadow-none data-[disabled]:pointer-events-none data-[disabled]:opacity-55', className)}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
