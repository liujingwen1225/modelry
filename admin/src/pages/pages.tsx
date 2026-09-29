import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Bot, CircleDot, HardDrive, HeartPulse, Layers3, LockKeyhole, Network, Puzzle, RefreshCw, Webhook } from 'lucide-react';
import { useDiagnostics } from '../components/diagnostics-context';
import { DiagnosticsCards } from '../components/runtime-status';
import { Button, ButtonLink, CopyButton, PartialState, StatusChip, Surface } from '../components/ui';
import { useI18n } from '../i18n/i18n';
import type { TranslationKey } from '../i18n/i18n';
import { listAllCollections, type CollectionSummary } from '../collections/client';

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
    </div>
  );
}

function HealthSummary() {
  const { t } = useI18n();
  const { runtime, storage } = useDiagnostics();
  const runtimeReady = runtime.state === 'ready' && runtime.value.state === 'ready';
  const storageReady = storage.state === 'ready' && storage.value.localStorage.state === 'ready';
  const partial = runtime.state === 'error' || storage.state === 'error';

  if (partial) {
    return (
      <PartialState className="notice notice--partial">
        <CircleDot aria-hidden="true" size={17} />
        <div><strong>{t('health.partialTitle')}</strong><span>{t('health.partialDescription')}</span></div>
      </PartialState>
    );
  }
  if (runtime.state === 'loading' || storage.state === 'loading') {
    return <div className="notice notice--loading" role="status"><span className="pulse-dot" />{t('health.connecting')}</div>;
  }

  const ready = runtimeReady && storageReady;
  return (
    <div className={`notice ${ready ? 'notice--ready' : 'notice--degraded'}`} role="status">
      {ready ? <HeartPulse aria-hidden="true" size={17} /> : <CircleDot aria-hidden="true" size={17} />}
      <div>
        <strong>{t(ready ? 'health.readyTitle' : 'health.attentionTitle')}</strong>
        <span>{t(ready ? 'health.readyDescription' : 'health.attentionDescription')}</span>
      </div>
      <StatusChip state={ready ? 'ready' : 'degraded'}>{t(ready ? 'health.readyChip' : 'health.attentionChip')}</StatusChip>
    </div>
  );
}

function translatedHealthState(state: string, t: (key: TranslationKey) => string): string {
  const known = ['ready', 'degraded', 'unavailable', 'unknown', 'loading'];
  return known.includes(state) ? t(`diagnostics.states.${state}` as TranslationKey) : t('diagnostics.unknown');
}

function CompactDiagnostics() {
  const { t } = useI18n();
  const { runtime, storage } = useDiagnostics();
  const runtimeState = runtime.state === 'ready' ? runtime.value.state : runtime.state === 'error' ? 'unavailable' : 'loading';
  const databaseState = storage.state === 'ready' ? storage.value.database.state
    : runtime.state === 'ready' ? runtime.value.database.state
      : storage.state === 'error' || runtime.state === 'error' ? 'unavailable' : 'loading';
  const fileState = storage.state === 'ready' ? storage.value.localStorage.state
    : runtime.state === 'ready' ? runtime.value.localStorage.state
      : storage.state === 'error' || runtime.state === 'error' ? 'unavailable' : 'loading';
  const statuses = [
    { label: t('diagnostics.runtime.eyebrow'), state: runtimeState },
    { label: t('diagnostics.database'), state: databaseState },
    { label: t('diagnostics.localStorage'), state: fileState },
  ];

  return (
    <section aria-label={t('overview.diagnosticsTitle')} className="overview-diagnostics">
      <span className="overview-diagnostics__label">{t('overview.diagnosticsEyebrow')}</span>
      <div className="overview-diagnostics__statuses">
        {statuses.map(({ label, state }) => <span className="overview-diagnostics__item" key={label}>
          <span>{label}</span>
          <StatusChip state={state}>{translatedHealthState(state, t)}</StatusChip>
        </span>)}
      </div>
    </section>
  );
}

export function OverviewPage() {
  const { t } = useI18n();
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

  const recentCollections = useMemo(() => (collections ?? [])
    .slice()
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? '').localeCompare(left.updatedAt ?? left.createdAt ?? ''))
    .slice(0, 3), [collections]);
  const emptyProject = collections?.length === 0;
  const failedCollections = (collections ?? []).filter((collection) => collection.pendingChangeStatus === 'failed');
  const pendingCollections = (collections ?? []).filter((collection) => collection.pendingChangeStatus === 'ready' || collection.pendingChangeStatus === 'needsReview');
  const runtimeUnavailable = runtime.state === 'error' || (runtime.state === 'ready' && runtime.value.state !== 'ready');
  const storageUnavailable = storage.state === 'error' || (storage.state === 'ready' && storage.value.localStorage.state !== 'ready');
  const databaseUnavailable = (runtime.state === 'ready' && runtime.value.database.state !== 'ready') || (storage.state === 'ready' && storage.value.database.state !== 'ready');
  const collectionsUnavailable = overviewLoaded && collections === null;
  const needsAttention = runtimeUnavailable || databaseUnavailable || storageUnavailable || collectionsUnavailable || failedCollections.length > 0;

  return (
    <div className="page-stack overview-page">
      <PageHeading
        description={t('overview.description')}
        eyebrow={t('overview.eyebrow')}
        title={t('overview.title')}
      />
      {emptyProject && <Surface className="overview-empty" variant="raised">
        <div><h2>{t('overview.emptyTitle')}</h2><p>{t('overview.emptyDescription')}</p></div>
        <ButtonLink to="/collections/new" variant="primary"><Layers3 aria-hidden="true" size={15} />{t('overview.createCollection')}</ButtonLink>
      </Surface>}
      {recentCollections.length > 0 && <section aria-labelledby="recent-work-heading" className="overview-recent-work">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">{t('overview.recentEyebrow')}</p>
            <h2 id="recent-work-heading">{t('overview.recentTitle')}</h2>
          </div>
        </div>
        <div className="overview-recent-work__list">
          {recentCollections.map((collection) => <Surface className="overview-recent-work__item" key={collection.id} variant="standard">
            <span><strong>{collection.name}</strong><small>{t(collection.type === 'Auth' ? 'overview.authCollection' : 'overview.collection')}</small></span>
            <Link to={collection.type === 'Auth' ? `/collections/${encodeURIComponent(collection.id)}/access` : `/collections/${encodeURIComponent(collection.id)}`}>
              {t(collection.type === 'Auth' ? 'overview.editSecurity' : 'overview.openRecords')}<ArrowRight aria-hidden="true" size={14} />
            </Link>
          </Surface>)}
        </div>
      </section>}
      <section aria-label={t('navigation.build')} className="overview-build-links">
        <Link className="overview-build-link" to="/collections"><Layers3 aria-hidden="true" size={17} /><span>{t('navigation.collections')}</span><ArrowRight aria-hidden="true" size={14} /></Link>
        <Link className="overview-build-link" to="/connect/api"><Network aria-hidden="true" size={17} /><span>{t('navigation.api')}</span><ArrowRight aria-hidden="true" size={14} /></Link>
        <Link className="overview-build-link" to="/automations/hooks"><Puzzle aria-hidden="true" size={17} /><span>{t('navigation.hooks')}</span><ArrowRight aria-hidden="true" size={14} /></Link>
        <Link className="overview-build-link" to="/automations"><Webhook aria-hidden="true" size={17} /><span>{t('navigation.automations')}</span><ArrowRight aria-hidden="true" size={14} /></Link>
      </section>
      {pendingCollections.length > 0 && <div className="overview-pending-summary" role="status">
        <span>{pendingCollections.length === 1 ? t('overview.schemaPendingOne') : t('overview.schemaPendingMany', { count: pendingCollections.length })}</span>
        <Link to="/changes?view=pending">{t('overview.reviewChanges')}<ArrowRight aria-hidden="true" size={14} /></Link>
      </div>}
      {needsAttention && <section aria-labelledby="overview-attention-heading" className="overview-attention">
        <div><p className="eyebrow">{t('overview.attentionEyebrow')}</p><h2 id="overview-attention-heading">{t('overview.attentionTitle')}</h2></div>
        <ul>
          {failedCollections.map((collection) => <li key={collection.id}>
            <AlertTriangle aria-hidden="true" size={16} />
            <span>{t('overview.failedChange', { name: collection.name })}</span>
            <Link to={`/collections/${encodeURIComponent(collection.id)}/model`}>{t('overview.view')}</Link>
          </li>)}
          {collectionsUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.collectionsUnavailable')}</span><Link to="/collections">{t('overview.openCollections')}</Link></li>}
          {runtimeUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.runtimeUnavailable')}</span><Link to="/settings">{t('overview.openSettings')}</Link></li>}
          {databaseUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.databaseUnavailable')}</span><Link to="/settings">{t('overview.openSettings')}</Link></li>}
          {storageUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.storageUnavailable')}</span><Link to="/settings">{t('overview.openSettings')}</Link></li>}
        </ul>
      </section>}
      <Surface className="overview-agent-card" variant="standard">
        <span className="overview-agent-card__icon"><Bot aria-hidden="true" size={18} /></span>
        <div className="overview-agent-card__content">
          <h2>{t('overview.agentTitle')}</h2>
          <p>{t('overview.agentDescription')}</p>
          <p className="overview-agent-card__setup">{t('overview.agentInstruction')}</p>
          <div className="overview-agent-card__command"><code>{t('overview.agentSetup')}</code><CopyButton label={t('common.copy')} value={t('overview.agentSetup')} /></div>
          <Link className="text-link" to="/access">{t('overview.agentAccessLink')}<ArrowRight aria-hidden="true" size={14} /></Link>
        </div>
      </Surface>
      <CompactDiagnostics />
    </div>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const { refresh } = useDiagnostics();
  return (
    <div className="page-stack">
      <PageHeading description={t('settings.description')} eyebrow={t('settings.eyebrow')} title={t('settings.title')} />
      <section aria-labelledby="settings-status-heading" className="health-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">{t('settings.diagnosticsEyebrow')}</p>
            <h2 id="settings-status-heading">{t('settings.diagnosticsTitle')}</h2>
            <p className="section-description">{t('settings.diagnosticsDescription')}</p>
          </div>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={15} /> {t('settings.refresh')}</Button>
        </div>
        <HealthSummary />
        <DiagnosticsCards />
      </section>
      <Surface className="settings-note" variant="inset">
        <span className="scope-icon"><HardDrive aria-hidden="true" size={17} /></span>
        <div><strong>{t('settings.storageTitle')}</strong><p>{t('settings.storageDescription')}</p><Link className="text-link" to="/settings/storage">{t('settings.storageLink')}</Link></div>
      </Surface>
      <Surface className="settings-note" variant="inset">
        <span className="scope-icon"><LockKeyhole aria-hidden="true" size={17} /></span>
        <div><strong>{t('settings.readOnlyTitle')}</strong><p>{t('settings.readOnlyDescription')}</p></div>
      </Surface>
    </div>
  );
}
