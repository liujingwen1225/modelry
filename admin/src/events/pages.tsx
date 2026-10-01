import { useMemo } from 'react';
import { Activity, Radio, Webhook as WebhookIcon, Workflow } from 'lucide-react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useI18n } from '../i18n/i18n';
import { DeliveriesPanel, EventHooksPanel, PanelTabNav, WebhooksPanel, type PanelTab } from '../automation/pages';
import { ExtensionEditor, HooksPanel } from '../extensions/pages';

// Spec 0001 §3.1：Hooks & Events 只汇总事件驱动能力，
// 二级 Tab 固定为 Hooks / Webhooks / Event triggers / Delivery history，
// 时间驱动的「定时任务」是独立一级入口（见 ../schedules/pages）。
export type EventsTab = 'hooks' | 'webhooks' | 'triggers' | 'deliveries';

const eventsTabs: ReadonlyArray<PanelTab<EventsTab>> = [
  { id: 'hooks', label: 'events.tabs.hooks', icon: Workflow },
  { id: 'webhooks', label: 'events.tabs.webhooks', icon: WebhookIcon },
  { id: 'triggers', label: 'events.tabs.triggers', icon: Radio },
  { id: 'deliveries', label: 'events.tabs.deliveries', icon: Activity },
];

// URL 的 `?tab=` 是唯一事实来源：默认 Tab 是 hooks，未知值归一到 hooks，
// 因此每个工作面都可分享、可刷新、可用浏览器前进后退（spec 0001 §3.1）。
export function selectedEventsTab(value: string | null): EventsTab {
  return value === 'webhooks' || value === 'triggers' || value === 'deliveries' ? value : 'hooks';
}

export function EventsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const activeTab = selectedEventsTab(params.get('tab'));

  // 命令面板入口只覆盖本页面的工作面与创建流程；一级导航由 Shell 负责。
  const commands = useMemo<AdminCommand[]>(() => [
    {
      id: 'events.open-hooks', category: 'commands.categories.automation', label: () => t('events.tabs.hooks'),
      execute: () => navigate('/events?tab=hooks'),
    },
    {
      id: 'events.open-webhooks', category: 'commands.categories.automation', label: () => t('events.tabs.webhooks'),
      execute: () => navigate('/events?tab=webhooks'),
    },
    {
      id: 'events.open-triggers', category: 'commands.categories.automation', label: () => t('events.tabs.triggers'),
      execute: () => navigate('/events?tab=triggers'),
    },
    {
      id: 'events.open-deliveries', category: 'commands.categories.automation', label: () => t('commands.deliveryHistory'),
      execute: () => navigate('/events?tab=deliveries'),
    },
    {
      id: 'events.create-webhook', category: 'commands.categories.automation', label: () => t('commands.createWebhook'),
      execute: () => navigate('/events?tab=webhooks&create=1'),
    },
    {
      id: 'events.create-event-hook', category: 'commands.categories.automation', label: () => t('commands.createEventHook'),
      execute: () => navigate('/events?tab=triggers&create=1'),
    },
  ], [navigate, t]);
  useRegisterCommands(commands);

  return <div className="flex min-w-0 flex-col gap-6">
    <header className="min-w-0">
      <p className="eyebrow">{t('events.eyebrow')}</p>
      <h1>{t('events.title')}</h1>
      <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('events.description')}</p>
    </header>
    <PanelTabNav active={activeTab} idPrefix="events" label={t('events.tabsLabel')} tabs={eventsTabs} />
    {activeTab === 'hooks' && <HooksPanel />}
    {activeTab === 'webhooks' && <WebhooksPanel params={params} setParams={setParams} />}
    {activeTab === 'triggers' && <EventHooksPanel params={params} setParams={setParams} />}
    {activeTab === 'deliveries' && <DeliveriesPanel params={params} setParams={setParams} />}
  </div>;
}

// Hook 详情沿用既有 Hook 编辑器，路由为 `/events/hooks/:extensionId`（spec 0001 §3.1）。
export function HookDetailPage() {
  const { extensionId } = useParams();
  if (!extensionId) return <Navigate replace to="/events?tab=hooks" />;
  return <ExtensionEditor extensionId={extensionId} />;
}
