import { cn } from '@/lib/utils';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex select-none items-center gap-2 text-[13px] font-medium leading-snug text-ink-secondary group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed peer-disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
