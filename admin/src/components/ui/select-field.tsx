import type { ComponentProps, ReactNode } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

type Option = { value: string; label: ReactNode; disabled?: boolean };
type OptionEntry = Option | readonly OptionEntry[] | false | null | undefined;
type TriggerProps = Pick<ComponentProps<typeof SelectTrigger>,
  'id' | 'className' | 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid' | 'aria-errormessage'>;
type SharedProps = TriggerProps & {
  options: readonly OptionEntry[];
  disabled?: boolean;
  required?: boolean;
  name?: string;
};
type SelectFieldProps = SharedProps & (
  | { multiple?: false; value: string; onValueChange: (value: string) => void }
  | { multiple: true; value: string[]; onValueChange: (value: string[]) => void }
);

function flattenOptions(entries: readonly OptionEntry[]): Option[] {
  return entries.flatMap((entry): Option[] => {
    if (!entry) return [];
    if (Array.isArray(entry)) return flattenOptions(entry);
    return [entry as Option];
  });
}

// 表单和筛选复用集合列表的 Select；页面仅提供选项、值和业务回调。
export function SelectField({ options, disabled, required, name, multiple, value, onValueChange, ...triggerProps }: SelectFieldProps) {
  const items = flattenOptions(options);
  const content = <>
    <SelectTrigger {...triggerProps} data-value={Array.isArray(value) ? value.join(',') : value}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {items.map((item) => <SelectItem key={item.value} value={item.value} disabled={item.disabled} data-value={item.value}>{item.label}</SelectItem>)}
    </SelectContent>
  </>;

  if (multiple) return <Select multiple items={items} disabled={disabled} required={required} name={name} value={value} onValueChange={onValueChange}>{content}</Select>;
  return <Select items={items} disabled={disabled} required={required} name={name} value={value} onValueChange={(next) => { if (next !== null) onValueChange(String(next)); }}>{content}</Select>;
}
