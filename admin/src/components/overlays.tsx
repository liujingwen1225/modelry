import { useId, type ReactNode } from 'react';
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogCloseButton,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from '@/components/ui/dialog';
import {
  Sheet as SheetRoot,
  SheetContent,
  SheetCloseButton,
  SheetHeader,
  SheetTitle,
  SheetBody,
} from '@/components/ui/sheet';

// 页面使用同一个 Dialog / Sheet 入口：Sheet 承载保留列表上下文的详情与快速编辑，
// Dialog 承载明确确认（spec §13.2）。
export function Dialog({
  open,
  title,
  children,
  onClose,
  closeLabel,
  size = 'standard',
  presentation = 'dialog',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel: string;
  size?: 'standard' | 'wide';
  presentation?: 'dialog' | 'sheet';
}) {
  const titleId = useId();

  function handleOpenChange(next: boolean) {
    if (!next) onClose();
  }

  if (presentation === 'sheet') {
    return (
      // Sheet 承载「保留列表上下文的详情与快速编辑」（spec 0001 §13.2），
      // 必须保持列表可查询/可读屏：非 modal 形态不对外部内容施加 inert/aria-hidden。
      <SheetRoot modal={false} open={open} onOpenChange={handleOpenChange}>
        <SheetContent size={size} aria-labelledby={titleId}>
          <SheetHeader>
            <SheetTitle id={titleId}>{title}</SheetTitle>
            <SheetCloseButton aria-label={closeLabel} />
          </SheetHeader>
          <SheetBody>{children}</SheetBody>
        </SheetContent>
      </SheetRoot>
    );
  }

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size={size} aria-labelledby={titleId}>
        <DialogHeader>
          <DialogTitle id={titleId}>{title}</DialogTitle>
          <DialogCloseButton aria-label={closeLabel} />
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </DialogRoot>
  );
}

export function Sheet(props: Omit<Parameters<typeof Dialog>[0], 'presentation'>) {
  return <Dialog {...props} presentation="sheet" />;
}
