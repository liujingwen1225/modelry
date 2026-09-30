// 折叠的机器可读详情：原始契约信息进入技术详情，不占主文案（spec §10.2）。
export function JsonViewer({ value, label }: { value: unknown; label: string }) {
  return (
    <details className="border-t pt-1.5 text-[10px] text-muted-foreground [&_pre]:mt-2 [&_pre]:max-h-40 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre]:leading-relaxed [&_pre]:text-ink-secondary [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary:hover]:text-primary">
      <summary>{label}</summary>
      <pre><code>{JSON.stringify(value, null, 2)}</code></pre>
    </details>
  );
}
