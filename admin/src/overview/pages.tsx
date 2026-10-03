import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bot, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, ButtonLink } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { useDiagnostics } from '../components/diagnostics-context';
import { useOverview } from '../components/overview-context';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { mapLegacyPath } from '../route-map';
import { listActivity, type ActivityFact } from '../activity/client';
import { useOwnerSession } from '../auth/owner-session';
import { allowsOperation } from '../components/permissions';

// Spec 0001 §5：总览回答三个问题——项目现在能否正常工作、今天有什么值得处理、
// 最可能从哪里继续。所有数字都来自真实运行事实；读不到时显示 Unavailable，
// 绝不用 0 代替失败，也不展示无实现能力的动作。

type SummaryState = 'loading' | 'ready' | 'unavailable';

function PageHeading({ actions }: { actions: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="flex min-h-12 min-w-0 flex-wrap items-center justify-end gap-3 border-b pb-2" data-workspace-toolbar>
      <h1 className="sr-only">{t('overview.title')}</h1>
      <div className="flex flex-wrap items-center gap-2.5">{actions}</div>
    </header>
  );
}

function SummaryItem({
  title,
  subtitle,
  metric,
  metricLabel,
  rows,
  to,
  chip,
  state,
  testId,
}: {
  title: string;
  subtitle: string;
  metric: string;
  metricLabel: string;
  rows: Array<{ label: string; value: string; tone?: 'warning' | 'danger' }>;
  to: string;
  chip: { label: string; state: string };
  state: SummaryState;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <section className="flex min-w-0 flex-col gap-2 py-4 sm:px-4" data-overview-card={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold text-foreground"><Link className="inline-flex min-h-11 items-center gap-1 hover:underline" title={subtitle} to={to}>{title}<ArrowRight aria-hidden="true" size={13} /></Link></h2>
          {testId === 'api' && <p className="m-0 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <StatusChip state={chip.state}>{chip.label}</StatusChip>
      </div>
      {state === 'unavailable' ? (
        <p className="m-0 text-xs text-muted-foreground">{t('overview.unavailable')}</p>
      ) : state === 'loading' ? (
        <LoadingState label={t('overview.loading')} />
      ) : (
        <>
          <p className="m-0 flex flex-wrap items-baseline gap-1.5">
            <span className="text-2xl leading-none font-semibold tracking-[-0.6px] text-foreground">{metric}</span>
            <span className="text-xs text-muted-foreground">{metricLabel}</span>
          </p>
          <dl className="m-0 grid gap-1.5 pt-1">
            {rows.map((row) => (
              <div className="flex items-center justify-between gap-3" key={row.label}>
                <dt className="text-xs text-muted-foreground">{row.label}</dt>
                <dd className={`m-0 font-mono text-[13px] ${row.tone === 'danger' ? 'text-danger' : row.tone === 'warning' ? 'text-warning' : 'text-ink-secondary'}`}>{row.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

function collectionStatus(fact: { pendingChangeStatus?: 'ready' | 'needsReview' | 'failed' }, t: (key: TranslationKey) => string) {
  switch (fact.pendingChangeStatus) {
    case 'failed':
      return { label: t('overview.statusFailed'), state: 'unavailable' };
    case 'ready':
    case 'needsReview':
      return { label: t('overview.statusPending'), state: 'degraded' };
    default:
      return { label: t('overview.statusSynced'), state: 'ready' };
  }
}

function ContinueWorking() {
  const { t, formatNumber } = useI18n();
  const { overview } = useOverview();
  const collections = overview.value?.collections;
  const recent = collections?.recent ?? [];

  return (
    <Surface className="flex min-w-0 flex-col gap-3" data-overview-continue variant="section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold text-foreground">{t('overview.continueTitle')}</h2>
          <p className="m-0 mt-0.5 text-xs text-muted-foreground">{t('overview.continueSub')}</p>
        </div>
        <ButtonLink size="small" to="/collections" variant="quiet">{t('overview.continueViewAll')}</ButtonLink>
      </div>
      {overview.state === 'loading' && !collections ? <LoadingState label={t('overview.loading')} /> : null}
      {overview.state === 'error' && !collections ? (
        <p className="m-0 text-xs text-muted-foreground">{t('overview.unavailable')}</p>
      ) : null}
      {collections && recent.length === 0 ? <EmptyState description={t('overview.continueEmpty')} title={t('overview.continueTitle')} /> : null}
      {recent.length > 0 ? (
        <div className="min-w-0 overflow-x-auto">
          <Table className="w-full min-w-[520px] border-collapse text-left">
            <TableHeader>
              <TableRow className="border-b text-xs font-bold tracking-[0.6px] text-muted-foreground uppercase">
                <TableHead className="py-2 pr-3 font-bold">{t('navigation.collections')}</TableHead>
                <TableHead className="py-2 pr-3 font-bold">{t('overview.collectionFields')}</TableHead>
                <TableHead className="py-2 pr-3 font-bold">{t('overview.collectionRecords')}</TableHead>
                <TableHead className="py-2 pr-3 font-bold">{t('overview.collectionStatus')}</TableHead>
                <TableHead className="py-2 font-bold" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((collection) => {
                const status = collectionStatus(collection, t);
                return (
                  <TableRow className="border-b last:border-b-0" key={collection.id}>
                    <TableCell className="py-2.5 pr-3">
                      <span className="block truncate text-sm font-semibold text-foreground">{collection.name}</span>
                      <small className="font-mono text-[13px] text-muted-foreground">{collection.type === 'Auth' ? t('overview.authCollection') : t('overview.collection')}</small>
                    </TableCell>
                    <TableCell className="py-2.5 pr-3 font-mono text-[13px] text-ink-secondary">{formatNumber(collection.fieldCount)}</TableCell>
                    <TableCell className="py-2.5 pr-3 font-mono text-[13px] text-ink-secondary">{collection.recordCount === undefined ? t('overview.unknown') : formatNumber(collection.recordCount)}</TableCell>
                    <TableCell className="py-2.5 pr-3"><StatusChip state={status.state}>{status.label}</StatusChip></TableCell>
                    <TableCell className="py-2.5 text-right">
                      <ButtonLink size="small" to={`/collections/${encodeURIComponent(collection.id)}`} variant="secondary">{t('overview.continueOpen')}</ButtonLink>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </Surface>
  );
}

function QuickStart() {
  const { t } = useI18n();
  const actions: Array<{ title: TranslationKey; hint: TranslationKey; to: string }> = [
    { title: 'overview.quickCreateCollection', hint: 'overview.quickCreateCollectionHint', to: '/collections/new' },
    { title: 'overview.quickDebugApi', hint: 'overview.quickDebugApiHint', to: '/api?tab=endpoints' },
    { title: 'overview.quickCreateWebhook', hint: 'overview.quickCreateWebhookHint', to: '/events?tab=webhooks&create=1' },
    { title: 'overview.quickCreateSchedule', hint: 'overview.quickCreateScheduleHint', to: '/schedules?tab=jobs&create=1' },
  ];
  return (
    <Surface className="flex min-w-0 flex-col gap-3" data-overview-quick-start variant="section">
      <div className="min-w-0">
        <h2 className="m-0 text-base font-semibold text-foreground">{t('overview.quickTitle')}</h2>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {actions.map((action) => (
          <Link className="flex min-h-11 min-w-0 flex-col justify-center gap-1 border-b py-3 no-underline transition-colors hover:bg-muted/50" key={action.to} to={action.to}>
            <strong className="text-sm font-semibold text-foreground">{t(action.title)}</strong>
            <span className="text-xs leading-relaxed text-muted-foreground">{t(action.hint)}</span>
          </Link>
        ))}
      </div>
      <div className="mt-1 border-t pt-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-ink-secondary"><Bot size={15} /></span>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <strong className="text-xs font-semibold text-foreground">{t('overview.mcpCardTitle')}</strong>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('overview.mcpCardDescription')}</p>
            <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border bg-muted px-2.5 py-2">
              <code className="min-w-0 truncate font-mono text-[13px] text-ink-secondary">{t('overview.agentSetup')}</code>
              <CopyButton label={t('overview.copyMcpConfig')} value={t('overview.agentSetup')} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary hover:underline" to="/mcp">{t('overview.mcpGuide')}</Link>
              <Link className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary hover:underline" to="/access?tab=tokens">{t('overview.permissionsLink')}</Link>
              <Link className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary hover:underline" to="/activity">{t('overview.auditLink')}</Link>
            </div>
          </div>
        </div>
      </div>
    </Surface>
  );
}

function activityTarget(fact: ActivityFact): string {
  const mapped = mapLegacyPath(fact.deepLink);
  return mapped ? `${mapped.pathname}${mapped.search}` : fact.deepLink;
}

function RecentActivity() {
  const { t, formatDate } = useI18n();
  const { state: session } = useOwnerSession();
  // `/activity` 由 `activity.read` 控制；没有该权限的管理员不请求，直接显示不可用。
  const allowed = session.status === 'authenticated'
    ? allowsOperation(session.session.role, session.session.permission, 'activity.read')
    : false;
  const [facts, setFacts] = useState<ActivityFact[]>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!allowed) {
      setState('error');
      return;
    }
    const controller = new AbortController();
    setState('loading');
    void listActivity({ limit: 5 }, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setFacts(page.data);
        setState('ready');
      },
      () => {
        if (controller.signal.aborted) return;
        setState('error');
      },
    );
    return () => controller.abort();
  }, [allowed, generation]);

  return (
    <Surface className="flex min-w-0 flex-col gap-3" data-overview-recent-activity variant="section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold text-foreground">{t('overview.recentActivityTitle')}</h2>
        </div>
        <ButtonLink size="small" to="/activity" variant="quiet">{t('overview.recentActivityAll')}</ButtonLink>
      </div>
      {state === 'loading' ? <LoadingState label={t('overview.loading')} /> : null}
      {state === 'error' ? (
        <ErrorState description={t('overview.recentActivityUnavailable')} title={t('overview.unavailable')}>
          <Button onClick={() => setGeneration((value) => value + 1)} size="small" type="button" variant="quiet">
            <RefreshCw aria-hidden="true" size={14} /> {t('overview.retry')}
          </Button>
        </ErrorState>
      ) : null}
      {state === 'ready' && (facts?.length ?? 0) === 0 ? <p className="m-0 text-xs text-muted-foreground">{t('overview.recentActivityEmpty')}</p> : null}
      {state === 'ready' && (facts?.length ?? 0) > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {facts?.map((fact) => (
            <li className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-3 border-b pb-2 last:border-b-0 last:pb-0" key={fact.id}>
              <time className="font-mono text-[13px] text-muted-foreground" dateTime={fact.occurredAt}>{formatDate(fact.occurredAt, { hour: '2-digit', minute: '2-digit' })}</time>
              <div className="min-w-0">
                <p className="m-0 text-sm text-ink-secondary">
                  {fact.title ? <strong className="font-semibold text-foreground">{fact.title}</strong> : <strong className="font-semibold text-foreground">{fact.resourceKind}</strong>}
                  {' · '}
                  <Link className="font-semibold text-primary hover:underline" to={activityTarget(fact)}>{fact.resourceId}</Link>
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusChip state={fact.status === 'failed' ? 'failed' : fact.status === 'succeeded' || fact.status === 'applied' ? 'ready' : 'unknown'}>{fact.status}</StatusChip>
                  <span className="font-mono text-[13px] text-muted-foreground">{fact.kind}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Surface>
  );
}

function RuntimeStatusPanel() {
  const { t, formatNumber } = useI18n();
  const { runtime, storage } = useDiagnostics();
  const { overview } = useOverview();

  const runtimeState = runtime.state === 'ready' ? runtime.value.state : runtime.state === 'error' ? 'unavailable' : 'loading';
  const databaseState = storage.state === 'ready' ? storage.value.database.state : runtime.state === 'ready' ? runtime.value.database.state : storage.state === 'error' ? 'unavailable' : 'loading';
  const fileState = storage.state === 'ready' ? storage.value.localStorage.state : runtime.state === 'ready' ? runtime.value.localStorage.state : storage.state === 'error' ? 'unavailable' : 'loading';
  const sizeBytes = storage.state === 'ready' ? storage.value.databaseSizeBytes : undefined;
  const drift = overview.value?.drift;

  const rows: Array<{ label: string; value: string; state?: string; to?: string }> = [
    { label: t('overview.runtimeLabel'), value: runtimeState === 'ready' ? t('diagnostics.states.ready') : t(`diagnostics.states.${runtimeState}` as TranslationKey), state: runtimeState, to: '/settings' },
    {
      label: t('overview.runtimeSqlite'),
      value: databaseState === 'ready'
        ? sizeBytes === undefined ? `${t('diagnostics.states.ready')} · ${t('overview.unknown')}` : `${t('diagnostics.states.ready')} · ${formatNumber(Math.round(sizeBytes / 1024))} KB`
        : t(`diagnostics.states.${databaseState}` as TranslationKey),
      state: databaseState,
      to: '/settings',
    },
    { label: t('overview.storageLabel'), value: fileState === 'ready' ? t('diagnostics.states.ready') : t(`diagnostics.states.${fileState}` as TranslationKey), state: fileState, to: '/settings/storage' },
    {
      label: t('overview.runtimeDrift'),
      value: drift === undefined ? t('overview.unavailable') : drift.differenceCount === 0 ? t('overview.statusSynced') : String(drift.differenceCount),
      state: drift === undefined ? 'unknown' : drift.differenceCount === 0 ? 'ready' : 'degraded',
      to: '/changes?tab=drift',
    },
    // 备份事实当前没有持久化记录，因此不显示相对时间，只给出真实入口（spec §5.2）。
    { label: t('overview.runtimeBackup'), value: t('overview.unavailable'), state: 'unknown', to: '/settings/backups' },
  ];

  return (
    <Surface className="flex min-w-0 flex-col gap-3" data-overview-runtime variant="section">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="m-0 text-base font-semibold text-foreground">{t('overview.runtimeTitle')}</h2>
        </div>
        <StatusChip state={runtimeState === 'ready' && databaseState === 'ready' && fileState === 'ready' ? 'ready' : 'degraded'}>
          {runtimeState === 'ready' && databaseState === 'ready' && fileState === 'ready' ? t('overview.runtimeAllNormal') : t('overview.unavailable')}
        </StatusChip>
      </div>
      <dl className="m-0 grid gap-1.5">
        {rows.map((row) => (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 last:border-b-0" key={row.label}>
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="m-0 flex items-center gap-2">
              {row.state ? <StatusChip state={row.state}>{row.value}</StatusChip> : <span className="text-xs text-ink-secondary">{row.value}</span>}
              {row.to ? <Link className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary hover:underline" to={row.to}>{t('overview.view')}</Link> : null}
            </dd>
          </div>
        ))}
      </dl>
      <ButtonLink size="small" to="/settings" variant="secondary">{t('overview.openSettings')}</ButtonLink>
    </Surface>
  );
}

export function OverviewPage() {
  const { t, formatNumber } = useI18n();
  const { overview, refresh } = useOverview();

  const collections = overview.value?.collections;
  const requests = overview.value?.requests;
  const events = overview.value?.events;
  const changes = overview.value?.changes;

  const sectionState = (present: boolean): SummaryState => (overview.state === 'loading' && !present ? 'loading' : present ? 'ready' : 'unavailable');

  // 只有所有摘要事实已知且为零时才收起零值摘要，避免空集合遮住真实错误或不可用状态。
  const quietEmptyProject = Boolean(collections && requests && events && changes && overview.value?.drift
    && collections.count === 0 && collections.recordCount === 0
    && collections.withPendingChanges === 0 && collections.withFailedChanges === 0
    && requests.requestCount === 0 && requests.clientErrorCount === 0 && requests.serverErrorCount === 0
    && events.enabledHooks === 0 && events.enabledWebhooks === 0 && events.enabledEventHooks === 0 && events.enabledJobs === 0
    && events.runCount === 0 && events.deliveryCount === 0 && events.failedDeliveryCount === 0 && events.pendingDeliveryCount === 0
    && changes.pendingCount === 0 && changes.needsReviewCount === 0 && changes.failedCount === 0
    && overview.value.drift.differenceCount === 0);

  // 主操作随真实状态切换：没有待应用变更时不显示「审查 0 条变更」。
  const primaryAction = useMemo(() => {
    if (changes && changes.pendingCount > 0) {
      return { label: t('overview.reviewChangesAction', { count: changes.pendingCount }), to: '/changes?tab=pending' };
    }
    if (collections && collections.count === 0) return { label: t('overview.createCollection'), to: '/collections/new' };
    return { label: t('overview.quickDebugApi'), to: '/api?tab=endpoints' };
  }, [changes, collections, t]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading
        actions={
          <>
            <Button onClick={refresh} size="small" type="button" variant="secondary">
              <RefreshCw aria-hidden="true" size={15} /> {t('overview.refresh')}
            </Button>
            {primaryAction.to !== '/api?tab=endpoints' && <ButtonLink size="small" to="/api" variant="secondary">{t('overview.openApiWorkspace')}</ButtonLink>}
            <ButtonLink size="small" to={primaryAction.to} variant="primary">{primaryAction.label}</ButtonLink>
          </>
        }
      />

      {overview.state === 'error' && !overview.value ? (
        <ErrorState description={t('overview.unavailable')} title={t('overview.title')}>
          <Button onClick={refresh} size="small" type="button" variant="secondary">
            <RefreshCw aria-hidden="true" size={15} /> {t('overview.retry')}
          </Button>
        </ErrorState>
      ) : null}

      {!quietEmptyProject && <section aria-label={t('overview.cardsLabel')} className="grid min-w-0 grid-cols-2 gap-x-4 border-y sm:gap-x-0 sm:[&>section:nth-child(even)]:border-l xl:grid-cols-4 xl:[&>section+section]:border-l" data-overview-cards>
        <SummaryItem
          chip={{ label: collections?.withFailedChanges ? t('overview.statusFailed') : collections?.withPendingChanges ? t('overview.statusPending') : t('overview.statusSynced'), state: collections?.withFailedChanges ? 'unavailable' : collections?.withPendingChanges ? 'degraded' : 'ready' }}
          metric={collections ? formatNumber(collections.count) : '—'}
          metricLabel={t('navigation.collections')}
          rows={[
            { label: t('overview.totalRecords'), value: collections?.recordCount === undefined ? t('overview.unknown') : formatNumber(collections.recordCount) },
            { label: t('overview.pendingStructuralChanges'), value: collections ? formatNumber(collections.withPendingChanges) : t('overview.unknown'), tone: collections?.withPendingChanges ? 'warning' : undefined },
          ]}
          state={sectionState(Boolean(collections))}
          subtitle={t('overview.cardCollectionsSub')}
          testId="collections"
          title={t('overview.cardCollections')}
          to="/collections"
        />
        <SummaryItem
          chip={{ label: requests && requests.serverErrorCount > 0 ? t('overview.statusFailed') : requests && requests.clientErrorCount > 0 ? t('overview.needsReview') : t('overview.statusSynced'), state: requests && requests.serverErrorCount > 0 ? 'unavailable' : requests && requests.clientErrorCount > 0 ? 'degraded' : 'ready' }}
          metric={requests ? formatNumber(requests.requestCount) : '—'}
          metricLabel={t('overview.requests')}
          rows={[
            { label: t('overview.errorCounts'), value: requests ? `${formatNumber(requests.clientErrorCount)} / ${formatNumber(requests.serverErrorCount)}` : t('overview.unknown'), tone: requests && requests.serverErrorCount > 0 ? 'danger' : requests && requests.clientErrorCount > 0 ? 'warning' : undefined },
            { label: t('overview.p95'), value: requests?.p95DurationMs === undefined ? t('overview.unknown') : `${formatNumber(requests.p95DurationMs)} ms` },
            ...(requests?.windowCoveredFrom ? [{ label: t('overview.windowRequests'), value: t('overview.windowCoveredFrom', { time: new Date(requests.windowCoveredFrom).toISOString().slice(0, 16).replace('T', ' ') }) }] : []),
          ]}
          state={sectionState(Boolean(requests))}
          subtitle={t('overview.cardApiSub')}
          testId="api"
          title={t('overview.cardApi')}
          to="/api?tab=logs"
        />
        <SummaryItem
          chip={{ label: events && events.failedDeliveryCount > 0 ? t('overview.statusFailed') : t('overview.statusSynced'), state: events && events.failedDeliveryCount > 0 ? 'unavailable' : 'ready' }}
          metric={events ? formatNumber(events.enabledHooks + events.enabledWebhooks + events.enabledEventHooks) : '—'}
          metricLabel={t('overview.active')}
          rows={[
            { label: t('overview.executionsInWindow'), value: events ? formatNumber(events.runCount + events.deliveryCount) : t('overview.unknown') },
            { label: t('overview.failedDeliveries'), value: events ? formatNumber(events.failedDeliveryCount) : t('overview.unknown'), tone: events && events.failedDeliveryCount > 0 ? 'warning' : undefined },
          ]}
          state={sectionState(Boolean(events))}
          subtitle={t('overview.cardEventsSub')}
          testId="events"
          title={t('overview.cardEvents')}
          to="/events"
        />
        <SummaryItem
          chip={{ label: changes && changes.pendingCount > 0 ? t('overview.statusPending') : t('overview.statusSynced'), state: changes && changes.failedCount > 0 ? 'unavailable' : changes && changes.pendingCount > 0 ? 'degraded' : 'ready' }}
          metric={changes ? formatNumber(changes.pendingCount) : '—'}
          metricLabel={t('overview.pending')}
          rows={[
            { label: t('overview.needsReview'), value: changes ? formatNumber(changes.needsReviewCount) : t('overview.unknown'), tone: changes && changes.needsReviewCount > 0 ? 'warning' : undefined },
            { label: t('overview.schemaDrift'), value: overview.value?.drift ? formatNumber(overview.value.drift.differenceCount) : t('overview.unknown') },
          ]}
          state={sectionState(Boolean(changes))}
          subtitle={t('overview.cardChangesSub')}
          testId="changes"
          title={t('overview.cardChanges')}
          to="/changes?tab=pending"
        />
      </section>}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ContinueWorking />
        <QuickStart />
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RecentActivity />
        <RuntimeStatusPanel />
      </div>
    </div>
  );
}
