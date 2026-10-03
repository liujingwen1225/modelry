import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
// 折叠的机器可读详情：原始契约信息进入技术详情，不占主文案（spec §10.2）。
export function JsonViewer({ value, label }: { value: unknown; label: string }) {
  return (
    <Collapsible data-slot="collapsible" className="border-t pt-1.5 text-[13px] text-muted-foreground [&_pre]:mt-2 [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:leading-relaxed [&_pre]:text-ink-secondary [&_[data-slot=collapsible-trigger]]:w-fit [&_[data-slot=collapsible-trigger]]:cursor-pointer [&_[data-slot=collapsible-trigger]]:font-semibold [&_[data-slot=collapsible-trigger]:hover]:text-primary">
      <CollapsibleTrigger>{label}</CollapsibleTrigger><CollapsibleContent>
      <pre><code>{JSON.stringify(value, null, 2)}</code></pre>
    </CollapsibleContent></Collapsible>
  );
}
