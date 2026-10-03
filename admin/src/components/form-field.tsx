import { Label } from '@/components/ui/label';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

// 表单字段：可见 Label + 持久说明 + 可访问关联；输入控件样式由 UI 组件统一，
// 页面只提供语义与校验结果（spec 0001 §13.3）。
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
    <div data-slot="form-field" className="grid gap-1.5">
      <Label className="text-[11px] font-semibold text-ink-secondary" htmlFor={htmlFor}>{label}</Label>
      {describedChild}
      {hint && <p className="m-0 text-[10px] text-muted-foreground" id={hintId}>{hint}</p>}
    </div>
  );
}
