import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Bot, HardDrive, LockKeyhole, RefreshCw } from 'lucide-react';
import { useDiagnostics } from '../components/diagnostics-context';
import { DiagnosticsCards } from '../components/runtime-status';
import { Button, ButtonLink } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n } from '../i18n/i18n';
import type { TranslationKey } from '../i18n/i18n';
import { listAllCollections, type CollectionSummary } from '../collections/client';

type HealthState = 'ready' | 'degraded' | 'unavailable' | 'unknown' | 'loading';

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="min-w-0">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}

function translatedHealthState(state: HealthState, t: (key: TranslationKey) => string): string {
  return t(`diagnostics.states.${state}` as TranslationKey);
}

type NextStep = { title: string; description: string; action: string; to: string };

// Spec 0001 §5.1：Home 回答「项目现在能否正常工作、我可以继续做什么」。
// 这里只从真实状态生成一条下一步引导；完成后该引导自动消失。
export function OverviewPage() {
  const { t, formatDate } = useI18n();
  const { runtime, storage } = useDiagnostics();
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [overviewLoaded, setOverviewLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void listAllCollections(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setCollections(value);
        setOverviewLoaded(true);
      },
      () => {
        if (controller.signal.aborted) return;
        setCollections(null);
        setOverviewLoaded(true);
      },
    );
    return () => controller.abort();
  }, []);

  const runtimeState: HealthState = runtime.state === 'ready' ? runtime.value.state as HealthState : runtime.state === 'error' ? 'unavailable' : 'loading';
  const databaseState: HealthState = storage.state === 'ready' ? storage.value.database.state
    : runtime.state === 'ready' ? runtime.value.database.state
      : storage.state === 'error' || runtime.state === 'error' ? 'unavailable' : 'loading';
  const fileState: HealthState = storage.state === 'ready' ? storage.value.localStorage.state
    : runtime.state === 'ready' ? runtime.value.localStorage.state
      : storage.state === 'error' || runtime.state === 'error' ? 'unavailable' : 'loading';

  const collectionsUnavailable = overviewLoaded && collections === null;
  const emptyProject = collections?.length === 0;
  const failedCollections = (collections ?? []).filter((collection) => collection.pendingChangeStatus === 'failed');
  const pendingCollections = (collections ?? []).filter((collection) => collection.pendingChangeStatus === 'ready' || collection.pendingChangeStatus === 'needsReview');
  const emptyCollection = (collections ?? []).find((collection) => (collection.recordCount ?? 0) === 0);

  const modelState: HealthState = collectionsUnavailable ? 'unavailable'
    : !overviewLoaded ? 'loading'
      : failedCollections.length > 0 ? 'degraded'
        : pendingCollections.length > 0 ? 'degraded'
          : 'ready';
  const modelLabel = !overviewLoaded ? t('home.statusChecking')
    : collectionsUnavailable ? t('home.statusUnavailable')
      : failedCollections.length > 0 ? t('home.statusFailed')
        : pendingCollections.length === 1 ? t('home.statusPendingOne')
          : pendingCollections.length > 1 ? t('home.statusPendingMany', { count: pendingCollections.length })
            : t('home.statusUpToDate');

  const statusRows: Array<{ key: string; label: string; state: HealthState; value: string }> = [
    { key: 'runtime', label: t('home.statusRuntime'), state: runtimeState, value: runtimeState === 'ready' ? '' : translatedHealthState(runtimeState, t) },
    { key: 'database', label: t('home.statusDatabase'), state: databaseState, value: databaseState === 'ready' ? '' : translatedHealthState(databaseState, t) },
    { key: 'storage', label: t('home.statusStorage'), state: fileState, value: fileState === 'ready' ? '' : translatedHealthState(fileState, t) },
    { key: 'model', label: t('home.statusModel'), state: modelState, value: modelLabel },
  ];

  const nextStep = useMemo<NextStep>(() => {
    if (collectionsUnavailable) return { title: t('home.nextUnavailableTitle'), description: t('home.nextUnavailableDescription'), action: t('home.nextSettingsAction'), to: '/settings' };
    if (runtimeState === 'unavailable' || runtimeState === 'degraded') return { title: t('home.nextRuntimeTitle'), description: t('home.nextRuntimeDescription'), action: t('home.nextSettingsAction'), to: '/settings' };
    if (databaseState === 'unavailable' || databaseState === 'degraded') return { title: t('home.nextDatabaseTitle'), description: t('home.nextDatabaseDescription'), action: t('home.nextSettingsAction'), to: '/settings' };
    if (fileState === 'unavailable' || fileState === 'degraded') return { title: t('home.nextStorageTitle'), description: t('home.nextStorageDescription'), action: t('home.nextSettingsAction'), to: '/settings/storage' };
    if (emptyProject) return { title: t('home.nextCreateCollectionTitle'), description: t('home.nextCreateCollectionDescription'), action: t('overview.createCollection'), to: '/collections/new' };
    if (failedCollections.length > 0) return { title: t('home.nextRecoverTitle'), description: t('home.nextRecoverDescription', { name: failedCollections[0]!.name }), action: t('home.nextReviewAction'), to: '/changes?view=pending' };
    if (pendingCollections.length > 0) return { title: t('home.nextReviewTitle'), description: t('home.nextReviewDescription'), action: t('home.nextReviewAction'), to: '/changes?view=pending' };
    if (emptyCollection) return { title: t('home.nextCreateRecordTitle', { name: emptyCollection.name }), description: t('home.nextCreateRecordDescription'), action: t('home.nextCreateRecordAction'), to: `/collections/${encodeURIComponent(emptyCollection.id)}` };
    return { title: t('home.nextApiTitle'), description: t('home.nextApiDescription'), action: t('home.nextApiAction'), to: '/connect/api' };
  }, [collectionsUnavailable, databaseState, emptyCollection, emptyProject, failedCollections, fileState, pendingCollections.length, runtimeState, t]);

  const recentCollections = useMemo(() => (collections ?? [])
    .slice()
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? '').localeCompare(left.updatedAt ?? left.createdAt ?? ''))
    .slice(0, 5), [collections]);

  const attention: Array<{ key: string; text: string; action: string; to: string }> = [];
  for (const collection of failedCollections) {
    attention.push({ key: `failed-${collection.id}`, text: t('home.attentionFailedChange', { name: collection.name }), action: t('home.attentionOpen'), to: `/collections/${encodeURIComponent(collection.id)}/model` });
  }
  if (collectionsUnavailable) attention.push({ key: 'collections', text: t('home.attentionCollections'), action: t('overview.openCollections'), to: '/collections' });
  if (runtimeState === 'unavailable' || runtimeState === 'degraded') attention.push({ key: 'runtime', text: t('home.attentionRuntime'), action: t('home.attentionSettingsAction'), to: '/settings' });
  if (databaseState === 'unavailable' || databaseState === 'degraded') attention.push({ key: 'database', text: t('home.attentionDatabase'), action: t('home.attentionSettingsAction'), to: '/settings' });
  if (fileState === 'unavailable' || fileState === 'degraded') attention.push({ key: 'storage', text: t('home.attentionStorage'), action: t('home.attentionStorageAction'), to: '/settings/storage' });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading description={t('home.description')} eyebrow={t('home.eyebrow')} title={t('home.title')} />

      {/* 状态：正常时每行只保留标签与状态，不铺成 KPI 瓷砖墙。 */}
      <section aria-labelledby="home-status-heading" className="flex min-w-0 flex-col gap-3" data-home-status>
        <h2 id="home-status-heading">{t('home.statusTitle')}</h2>
        <dl className="m-0 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {statusRows.map((row) => (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-card px-3.5 py-2.5" key={row.key}>
              <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
              <dd className="m-0">
                <StatusChip state={row.state}>{row.value || t('diagnostics.states.ready')}</StatusChip>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="home-next-heading" className="flex min-w-0 flex-col gap-3" data-home-next-step>
        <h2 id="home-next-heading">{t('home.nextTitle')}</h2>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4">
          <div className="min-w-0">
            <strong className="block text-sm font-semibold text-foreground">{nextStep.title}</strong>
            <p className="mt-1 max-w-[620px] text-xs leading-relaxed text-muted-foreground">{nextStep.description}</p>
          </div>
          <ButtonLink to={nextStep.to} variant="primary">{nextStep.action}<ArrowRight aria-hidden="true" size={15} /></ButtonLink>
        </div>
      </section>

      <section aria-labelledby="home-recent-heading" className="flex min-w-0 flex-col gap-3" data-home-recent-work>
        <h2 id="home-recent-heading">{t('home.recentTitle')}</h2>
        {!overviewLoaded && <p className="m-0 text-xs text-muted-foreground">{t('home.recentLoading')}</p>}
        {overviewLoaded && recentCollections.length === 0 && <p className="m-0 text-xs text-muted-foreground">{t('overview.emptyDescription')}</p>}
        {recentCollections.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {recentCollections.map((collection) => (
              <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5" key={collection.id}>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="truncate text-xs font-semibold text-foreground">{collection.name}</strong>
                  <small className="text-[11px] text-muted-foreground">
                    {t(collection.type === 'Auth' ? 'overview.authCollection' : 'overview.collection')}
                    {collection.updatedAt ? ` · ${t('home.recentUpdated')} ${formatDate(collection.updatedAt)}` : ''}
                  </small>
                </span>
                {collection.pendingChangeStatus && (
                  <StatusChip state={collection.pendingChangeStatus === 'failed' ? 'unavailable' : 'degraded'}>
                    {t(collection.pendingChangeStatus === 'failed' ? 'home.statusFailed' : 'overview.schemaPending')}
                  </StatusChip>
                )}
                <Link className="text-xs font-semibold text-primary hover:underline" to={collection.type === 'Auth' ? `/collections/${encodeURIComponent(collection.id)}/access` : `/collections/${encodeURIComponent(collection.id)}`}>
                  {t('home.recentOpen')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {attention.length > 0 && (
        <section aria-labelledby="home-attention-heading" className="flex min-w-0 flex-col gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4" data-home-attention>
          <h2 id="home-attention-heading" className="m-0 text-danger">{t('home.attentionTitle')}</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {attention.map((item) => (
              <li className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary" key={item.key}>
                <AlertTriangle aria-hidden="true" className="shrink-0 text-danger" size={16} />
                <span className="min-w-0 flex-1">{item.text}</span>
                <Link className="font-semibold text-danger hover:underline" to={item.to}>{item.action}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Agent 接入保持低权重：可复制的真实命令 + 通往 Access & keys 与 MCP 文档的入口。 */}
      <Surface className="flex min-w-0 items-start gap-3 p-4" variant="standard" data-home-agent>
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><Bot size={17} /></span>
        <div className="grid min-w-0 flex-1 gap-2">
          <h2 className="m-0">{t('overview.agentTitle')}</h2>
          <p className="m-0 max-w-[680px] text-xs leading-relaxed text-muted-foreground">{t('overview.agentDescription')}</p>
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted px-3 py-2.5" data-home-agent-command>
            <code className="min-w-0 break-words font-mono text-xs text-ink-secondary">{t('overview.agentSetup')}</code>
            <CopyButton label={t('common.copy')} value={t('overview.agentSetup')} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/access">{t('overview.agentAccessLink')}<ArrowRight aria-hidden="true" size={14} /></Link>
            <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/connect/mcp">{t('mcp.title')}<ArrowRight aria-hidden="true" size={14} /></Link>
          </div>
        </div>
      </Surface>
    </div>
  );
}

// Spec 0001 §11.2：Settings 按「用户要完成的设置任务」组织，不复制 Connect 的开发者接口页，
// 也不重复 Activity / Drift / 身份管理。诊断详情与刷新入口保留在本页（§9.3）。
export function SettingsPage() {
  const { t } = useI18n();
  const { refresh } = useDiagnostics();
  const groups: Array<{ key: TranslationKey; links: Array<{ label: TranslationKey; to: string }> }> = [
    {
      key: 'settings.navigation.project',
      links: [
        { label: 'settings.navigation.status', to: '/settings' },
        { label: 'settings.navigation.runtime', to: '/settings/runtime' },
      ],
    },
    {
      key: 'settings.navigation.service',
      links: [
        { label: 'settings.navigation.filesStorage', to: '/settings/storage' },
        { label: 'settings.navigation.mail', to: '/settings/mail' },
        { label: 'settings.navigation.secrets', to: '/settings/secrets' },
      ],
    },
    {
      key: 'settings.navigation.maintenance',
      links: [
        { label: 'settings.navigation.dataTransfer', to: '/settings/data' },
        { label: 'settings.navigation.backupRestore', to: '/settings/backups' },
      ],
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading description={t('settings.description')} eyebrow={t('settings.eyebrow')} title={t('settings.title')} />

      <div className="grid gap-3 sm:grid-cols-3">
        {groups.map((group) => (
          <Surface className="flex min-w-0 flex-col gap-2 p-4" key={group.key} variant="standard">
            <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.6px] text-muted-foreground">{t(group.key)}</h2>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {group.links.map((link) => (
                <li key={link.to}>
                  <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to={link.to}>
                    {t(link.label)}<ArrowRight aria-hidden="true" size={13} />
                  </Link>
                </li>
              ))}
            </ul>
          </Surface>
        ))}
      </div>

      <section aria-labelledby="settings-status-heading" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="eyebrow">{t('settings.diagnosticsEyebrow')}</p>
            <h2 id="settings-status-heading">{t('settings.diagnosticsTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('settings.diagnosticsDescription')}</p>
          </div>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={15} /> {t('settings.refresh')}</Button>
        </div>
        <DiagnosticsCards />
      </section>

      <Surface className="flex items-start gap-3 p-4" variant="inset">
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><HardDrive size={17} /></span>
        <div className="min-w-0">
          <strong className="block text-xs font-semibold text-foreground">{t('settings.storageTitle')}</strong>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('settings.storageDescription')}</p>
          <Link className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/settings/storage">{t('settings.storageLink')}</Link>
        </div>
      </Surface>
      <Surface className="flex items-start gap-3 p-4" variant="inset">
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><LockKeyhole size={17} /></span>
        <div className="min-w-0">
          <strong className="block text-xs font-semibold text-foreground">{t('settings.readOnlyTitle')}</strong>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('settings.readOnlyDescription')}</p>
        </div>
      </Surface>
    </div>
  );
}
