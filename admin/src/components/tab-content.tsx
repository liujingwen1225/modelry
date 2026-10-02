import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/i18n';
import { LoaderCircle } from 'lucide-react';

// 连续切换时取消中间工作面的挂载，只显示最后一次选择。
// 首次进入和同页签筛选不延迟；接口加载与错误仍由工作面自身处理。
export function TabContent({ activeKey, children }: { activeKey: string; children: ReactNode }) {
  const { t } = useI18n();
  const [settledKey, setSettledKey] = useState(activeKey);
  useEffect(() => {
    if (activeKey === settledKey) return;
    const timer = window.setTimeout(() => setSettledKey(activeKey), 160);
    return () => window.clearTimeout(timer);
  }, [activeKey, settledKey]);

  if (activeKey !== settledKey) return <div aria-busy="true" aria-label={t('common.switchingTab')} className="flex min-h-48 min-w-0 items-center justify-center text-muted-foreground" role="status">
    <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={22} strokeWidth={1.75} />
  </div>;
  return <>{children}</>;
}
