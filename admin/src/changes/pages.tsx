import { Link, useSearchParams } from 'react-router-dom';
import { ChangesPage } from '../collections/changes';
import { DriftPage } from '../drift/pages';
import { useI18n, type TranslationKey } from '../i18n/i18n';

type ChangesTab = 'pending' | 'history' | 'drift';

const changesTabOrder: readonly ChangesTab[] = ['pending', 'history', 'drift'];

const changesTabLabels: Record<ChangesTab, TranslationKey> = {
  pending: 'changes.tabs.pending',
  history: 'changes.tabs.history',
  drift: 'changes.tabs.drift',
};

// Spec 0001 §3.2：`变更` 的二级工作面固定为「待应用 / 已应用历史 / 结构漂移」。
// Spec 0001 §15：可分享的本地页签进入 URL，因此工作面读 `?tab=`；
// `q`、`changeSet` 等既有可分享参数在切换页签时原样保留，未知值回落到默认的待应用。
// Spec 0001 §10.3：结构漂移只展示检查结果与受控校准动作，绝不静默修复。
export function ChangesWorkspacePage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab: ChangesTab = requestedTab === 'history' || requestedTab === 'drift' ? requestedTab : 'pending';

  function tabTarget(tab: ChangesTab): string {
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    return `/changes?${next.toString()}`;
  }

  return <div className="flex min-w-0 flex-col gap-6">
    <header className="min-w-0">
      <p className="eyebrow">{t('changes.eyebrow')}</p>
      <h1>{t('changes.title')}</h1>
      <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('changes.description')}</p>
    </header>

    <nav aria-label={t('changes.tabsLabel')} className="flex flex-wrap items-center gap-1 overflow-x-auto border-b" data-changes-tabs>
      {changesTabOrder.map((tab) => <Link
        aria-current={activeTab === tab ? 'page' : undefined}
        className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
        key={tab}
        to={tabTarget(tab)}
      >{t(changesTabLabels[tab])}</Link>)}
    </nav>

    {activeTab === 'drift' && <p className="m-0 max-w-[680px] text-xs leading-relaxed text-muted-foreground">{t('changes.driftDescription')}</p>}

    {activeTab === 'drift' ? <DriftPage embedded /> : <ChangesPage embedded />}
  </div>;
}
