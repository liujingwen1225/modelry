import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CircleDot, HardDrive, HeartPulse, Layers3, LockKeyhole, RefreshCw } from 'lucide-react';
import { useDiagnostics } from '../components/diagnostics-context';
import { DiagnosticsCards } from '../components/runtime-status';
import { Button, PartialState, StatusChip, Surface } from '../components/ui';
import { useI18n } from '../i18n/i18n';
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

export function OverviewPage() {
  const { t } = useI18n();
  const { runtime, storage, refresh } = useDiagnostics();
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
  const schemaHealth = !overviewLoaded ? 'loading' : collections === null ? 'unavailable' : failedCollections.length > 0 ? 'failed' : pendingCollections.length > 0 ? 'pending' : 'ready';
  const runtimeUnavailable = runtime.state === 'error' || (runtime.state === 'ready' && runtime.value.state !== 'ready');
  const storageUnavailable = storage.state === 'error' || (storage.state === 'ready' && storage.value.localStorage.state !== 'ready');
  const collectionsUnavailable = overviewLoaded && collections === null;
  const needsAttention = runtimeUnavailable || storageUnavailable || collectionsUnavailable || failedCollections.length > 0;

  const schemaTitle = schemaHealth === 'ready' ? t('overview.schemaReady')
    : schemaHealth === 'pending' ? t('overview.schemaPending')
      : schemaHealth === 'failed' ? t('overview.schemaFailed')
        : schemaHealth === 'loading' ? t('overview.schemaLoading') : t('overview.schemaUnavailable');
  const schemaDescription = schemaHealth === 'ready' ? t('overview.schemaReadyDescription')
    : schemaHealth === 'pending' ? (pendingCollections.length === 1 ? t('overview.schemaPendingOne') : t('overview.schemaPendingMany', { count: pendingCollections.length }))
      : schemaHealth === 'failed' ? (failedCollections.length === 1 ? t('overview.schemaFailedOne') : t('overview.schemaFailedMany', { count: failedCollections.length }))
        : schemaHealth === 'loading' ? t('overview.schemaLoadingDescription') : t('overview.schemaUnavailableDescription');
  const schemaChip = schemaHealth === 'ready' ? t('overview.schemaChipHealthy')
    : schemaHealth === 'pending' ? t('overview.schemaChipReview')
      : schemaHealth === 'failed' ? t('overview.schemaChipAction')
        : schemaHealth === 'loading' ? t('overview.schemaChipChecking') : t('overview.schemaChipUnavailable');

  return (
    <div className="page-stack">
      <PageHeading
        description={t('overview.description')}
        eyebrow={t('overview.eyebrow')}
        title={t('overview.title')}
      />
      {emptyProject && <Surface className="overview-empty" variant="raised">
        <div><h2>{t('overview.emptyTitle')}</h2><p>{t('overview.emptyDescription')}</p></div>
        <Link className="button button--primary" to="/collections/new"><Layers3 aria-hidden="true" size={15} />{t('overview.createCollection')}</Link>
      </Surface>}
      {needsAttention && <section aria-labelledby="overview-attention-heading" className="overview-attention">
        <div><p className="eyebrow">{t('overview.attentionEyebrow')}</p><h2 id="overview-attention-heading">{t('overview.attentionTitle')}</h2></div>
        <ul>
          {failedCollections.map((collection) => <li key={collection.id}>
            <AlertTriangle aria-hidden="true" size={16} />
            <span>{t('overview.failedChange', { name: collection.name })}</span>
            <Link to={`/collections/${encodeURIComponent(collection.id)}/schema`}>{t('overview.view')}</Link>
          </li>)}
          {collectionsUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.collectionsUnavailable')}</span><Link to="/collections">{t('overview.openCollections')}</Link></li>}
          {runtimeUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.runtimeUnavailable')}</span><Link to="/settings">{t('overview.openSettings')}</Link></li>}
          {storageUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>{t('overview.storageUnavailable')}</span><Link to="/settings">{t('overview.openSettings')}</Link></li>}
        </ul>
      </section>}
      <section aria-labelledby="health-heading" className="health-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">{t('overview.diagnosticsEyebrow')}</p>
            <h2 id="health-heading">{t('overview.diagnosticsTitle')}</h2>
            <p className="section-description">{t('overview.diagnosticsDescription')}</p>
          </div>
          <Button className="refresh-button" onClick={refresh} size="small" variant="secondary">
            <RefreshCw aria-hidden="true" size={15} /> {t('overview.refresh')}
          </Button>
        </div>
        <HealthSummary />
        <DiagnosticsCards />
        <Surface className={`overview-schema-health overview-schema-health--${schemaHealth}`} variant="standard">
          <div>
            <p className="eyebrow">{t('overview.schemaEyebrow')}</p>
            <h3>{schemaTitle}</h3>
            <p>{schemaDescription}</p>
          </div>
          <StatusChip state={schemaHealth === 'pending' ? 'degraded' : schemaHealth === 'failed' || schemaHealth === 'unavailable' ? 'unavailable' : schemaHealth}>{schemaChip}</StatusChip>
          {schemaHealth === 'pending' && <Link to="/changes?view=pending">{t('overview.reviewChanges')}<ArrowRight aria-hidden="true" size={14} /></Link>}
        </Surface>
      </section>
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
            <Link to={collection.type === 'Auth' ? `/collections/${encodeURIComponent(collection.id)}/security` : `/collections/${encodeURIComponent(collection.id)}`}>
              {t(collection.type === 'Auth' ? 'overview.editSecurity' : 'overview.openRecords')}<ArrowRight aria-hidden="true" size={14} />
            </Link>
          </Surface>)}
        </div>
      </section>}
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