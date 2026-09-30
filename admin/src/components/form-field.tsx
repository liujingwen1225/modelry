import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

// 表单字段：可见 Label + 持久说明 + 可访问关联；输入控件样式由这一层统一，
// 页面只提供语义与校验结果（spec 0001 §13.3）。
const controlClass = [
  '[&_input]:min-h-9 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-input',
  '[&_input]:bg-card [&_input]:px-3 [&_input]:py-2 [&_input]:text-xs [&_input]:transition-[color,box-shadow] [&_input]:outline-none',
  '[&_input:hover]:border-subtle-foreground [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-1 [&_input:focus-visible]:outline-ring',
  '[&_input:disabled]:opacity-55',
  '[&_select]:min-h-9 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-input [&_select]:bg-card [&_select]:px-3 [&_select]:py-2 [&_select]:text-xs',
  '[&_textarea]:min-h-16 [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-input [&_textarea]:bg-card [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-xs',
].join(' ');

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
    <div data-slot="form-field" className={`grid gap-1.5 ${controlClass}`}>
      <label className="text-[11px] font-semibold text-ink-secondary" htmlFor={htmlFor}>{label}</label>
      {describedChild}
      {hint && <p className="m-0 text-[10px] text-muted-foreground" id={hintId}>{hint}</p>}
    </div>
  );
}
