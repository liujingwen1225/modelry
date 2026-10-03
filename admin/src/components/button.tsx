import { Link, type LinkProps } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button as ButtonPrimitive, buttonVariants } from '@/components/ui/button';

// 历史 variant 名称到设计系统 variant 的稳定映射；页面继续使用产品语义
// （primary / secondary / quiet / danger），实现细节留在这一层。
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'default' | 'small';
};

const legacyVariants = { primary: 'default', secondary: 'outline', quiet: 'ghost', danger: 'destructive' } as const;

export function Button({ variant = 'secondary', size = 'default', className, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      variant={legacyVariants[variant]}
      size={size === 'small' ? 'sm' : 'default'}
      className={className}
      {...props}
    />
  );
}

export function ButtonLink({ variant = 'secondary', size = 'default', className, ...props }: Omit<LinkProps, 'className'> & Pick<ButtonProps, 'variant' | 'size'> & { className?: string }) {
  return (
    <Link
      data-slot="button"
      className={cn(buttonVariants({
        variant: legacyVariants[variant],
        size: size === 'small' ? 'sm' : 'default',
        className,
      }))}
      {...props}
    />
  );
}
