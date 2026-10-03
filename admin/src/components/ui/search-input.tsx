import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

function SearchInput({ className, ...props }: Omit<React.ComponentProps<typeof Input>, 'type'>) {
  return (
    <div data-slot="search-input" className={cn('relative min-w-0', className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={15} />
      <Input type="search" className="pl-9" {...props} />
    </div>
  );
}

export { SearchInput };
