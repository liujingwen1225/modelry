import { TabContent } from '../components/tab-content';
import { useMemo, useState } from 'react';
import { Activity, Clock3 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DeliveriesPanel, JobsPanel, PanelTabNav, type PanelTab } from '../automation/pages';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n } from '../i18n/i18n';

// Spec 0001 §3.2：定时任务是独立一级入口，二级 Tab 固定为 Jobs / Execution history；
// 执行历史就是同一套 Delivery 事实，固定来源为 job，并额外显示触发方式。
export type SchedulesTab = 'jobs' | 'history';

const schedulesTabs: ReadonlyArray<PanelTab<SchedulesTab>> = [
  { id: 'jobs', label: 'schedules.tabs.jobs', icon: Clock3 },
  { id: 'history', label: 'schedules.tabs.history', icon: Activity },
];

export function SchedulesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // URL 的 `?tab=` 是唯一事实来源：默认 Tab 是 jobs，未知值归一到 jobs。
  const activeTab: SchedulesTab = params.get('tab') === 'history' ? 'history' : 'jobs';
  // 手动运行被服务器接受后，用一次信号让执行历史重新加载；
  // 列表本身仍然完全由 URL 决定（spec 0001 §8）。
  const [historyRevision, setHistoryRevision] = useState(0);

  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'schedules.open-jobs', category: 'commands.categories.automation', label: () => t('schedules.tabs.jobs'),
      execute: () => navigate('/schedules?tab=jobs'),
    },
    {
      id: 'schedules.open-history', category: 'commands.categories.automation', label: () => t('schedules.tabs.history'),
      execute: () => navigate('/schedules?tab=history'),
    },
    {
      id: 'schedules.create-job', category: 'commands.categories.automation', label: () => t('commands.createJob'),
      execute: () => navigate('/schedules?tab=jobs&create=1'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  return <div className="flex min-w-0 flex-col gap-6">
    <header className="sr-only">
      <p className="eyebrow">{t('schedules.eyebrow')}</p>
      <h1>{t('schedules.title')}</h1>
      <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('schedules.description')}</p>
    </header>
    <PanelTabNav active={activeTab} idPrefix="schedules" label={t('schedules.tabsLabel')} tabs={schedulesTabs} />
    <TabContent activeKey={activeTab}>
    {activeTab === 'jobs' && <JobsPanel onRunRecorded={() => setHistoryRevision((value) => value + 1)} params={params} setParams={setParams} />}
    {activeTab === 'history' && <DeliveriesPanel
      copy={{
        title: t('schedules.tabs.history'),
        description: t('schedules.historyDescription'),
        emptyTitle: t('schedules.tabs.history'),
        emptyDescription: t('schedules.historyEmpty'),
      }}
      fixedSourceType="job"
      params={params}
      reloadKey={historyRevision}
      setParams={setParams}
      showTriggerColumn
    />}
    </TabContent>
  </div>;
}
