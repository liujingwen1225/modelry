import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/i18n';
import { SpinnerLoadingState } from './states';

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

  if (activeKey !== settledKey) return <SpinnerLoadingState label={t('common.switchingTab')} />;
  return <>{children}</>;
}
