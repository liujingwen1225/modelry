import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CircleDot, HardDrive, HeartPulse, Layers3, LockKeyhole, RefreshCw } from 'lucide-react';
import { useDiagnostics } from '../components/diagnostics-context';
import { DiagnosticsCards } from '../components/runtime-status';
import { Button, PartialState, StatusChip, Surface } from '../components/ui';
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
  const { runtime, storage } = useDiagnostics();
  const runtimeReady = runtime.state === 'ready' && runtime.value.state === 'ready';
  const storageReady = storage.state === 'ready' && storage.value.localStorage.state === 'ready';
  const partial = runtime.state === 'error' || storage.state === 'error';

  if (partial) {
    return (
      <PartialState className="notice notice--partial">
        <CircleDot aria-hidden="true" size={17} />
        <div><strong>Some status information is unavailable.</strong><span>Available diagnostics are shown below.</span></div>
      </PartialState>
    );
  }
  if (runtime.state === 'loading' || storage.state === 'loading') {
    return <div className="notice notice--loading" role="status"><span className="pulse-dot" />Connecting to the local Runtime…</div>;
  }

  const ready = runtimeReady && storageReady;
  return (
    <div className={`notice ${ready ? 'notice--ready' : 'notice--degraded'}`} role="status">
      {ready ? <HeartPulse aria-hidden="true" size={17} /> : <CircleDot aria-hidden="true" size={17} />}
      <div>
        <strong>{ready ? 'Your Runtime is ready.' : 'Your Runtime needs attention.'}</strong>
        <span>{ready ? 'The local project and its storage are responding.' : 'Review the current Runtime and storage status below.'}</span>
      </div>
      <StatusChip state={ready ? 'ready' : 'degraded'}>{ready ? 'All systems ready' : 'Check status'}</StatusChip>
    </div>
  );
}

export function OverviewPage() {
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

  return (
    <div className="page-stack">
      <PageHeading
        description="Review project health and continue where you left off."
        eyebrow="PROJECT OVERVIEW"
        title="Overview"
      />
      {emptyProject && <Surface className="overview-empty" variant="raised">
        <div><h2>Your backend is ready</h2><p>Create your first Collection to define application data and API.</p></div>
        <Link className="button button--primary" to="/collections/new"><Layers3 aria-hidden="true" size={15} />Create Collection</Link>
      </Surface>}
      {needsAttention && <section aria-labelledby="overview-attention-heading" className="overview-attention">
        <div><p className="eyebrow">ACTION CENTER</p><h2 id="overview-attention-heading">Needs attention</h2></div>
        <ul>
          {failedCollections.map((collection) => <li key={collection.id}>
            <AlertTriangle aria-hidden="true" size={16} />
            <span>A schema change needs recovery in {collection.name}.</span>
            <Link to={`/collections/${encodeURIComponent(collection.id)}/schema`}>View</Link>
          </li>)}
          {collectionsUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>Collection status is unavailable.</span><Link to="/collections">Open Collections</Link></li>}
          {runtimeUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>Runtime health needs review.</span><Link to="/settings">Open settings</Link></li>}
          {storageUnavailable && <li><CircleDot aria-hidden="true" size={16} /><span>Local Storage is unavailable.</span><Link to="/settings">Open settings</Link></li>}
        </ul>
      </section>}
      <section aria-labelledby="health-heading" className="health-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">LIVE DIAGNOSTICS</p>
            <h2 id="health-heading">Runtime &amp; storage</h2>
            <p className="section-description">Safe, read-only snapshots from the Modelry Runtime.</p>
          </div>
          <Button className="refresh-button" onClick={refresh} size="small" variant="secondary">
            <RefreshCw aria-hidden="true" size={15} /> Refresh status
          </Button>
        </div>
        <HealthSummary />
        <DiagnosticsCards />
        <Surface className={`overview-schema-health overview-schema-health--${schemaHealth}`} variant="standard">
          <div>
            <p className="eyebrow">SCHEMA</p>
            <h3>{schemaHealth === 'ready' ? 'Up to date' : schemaHealth === 'pending' ? 'Pending changes' : schemaHealth === 'failed' ? 'Recovery needed' : schemaHealth === 'loading' ? 'Checking status' : 'Unavailable'}</h3>
            <p>{schemaHealth === 'ready' ? 'No Collection has a pending change.' : schemaHealth === 'pending' ? `${pendingCollections.length} ${pendingCollections.length === 1 ? 'Collection has' : 'Collections have'} changes to review.` : schemaHealth === 'failed' ? `Recovery is needed for ${failedCollections.length} ${failedCollections.length === 1 ? 'Collection' : 'Collections'}.` : schemaHealth === 'loading' ? 'Checking saved schema changes…' : 'Collection schema status could not be loaded.'}</p>
          </div>
          <StatusChip state={schemaHealth === 'pending' ? 'degraded' : schemaHealth === 'failed' || schemaHealth === 'unavailable' ? 'unavailable' : schemaHealth}>{schemaHealth === 'ready' ? 'Healthy' : schemaHealth === 'pending' ? 'Review' : schemaHealth === 'failed' ? 'Action needed' : schemaHealth === 'loading' ? 'Checking' : 'Unavailable'}</StatusChip>
          {schemaHealth === 'pending' && <Link to="/changes?view=pending">Review changes<ArrowRight aria-hidden="true" size={14} /></Link>}
        </Surface>
      </section>
      {recentCollections.length > 0 && <section aria-labelledby="recent-work-heading" className="overview-recent-work">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h2 id="recent-work-heading">Continue recent work</h2>
          </div>
        </div>
        <div className="overview-recent-work__list">
          {recentCollections.map((collection) => <Surface className="overview-recent-work__item" key={collection.id} variant="standard">
            <span><strong>{collection.name}</strong><small>{collection.type === 'Auth' ? 'Auth Collection' : 'Collection'}</small></span>
            <Link to={collection.type === 'Auth' ? `/collections/${encodeURIComponent(collection.id)}/security` : `/collections/${encodeURIComponent(collection.id)}`}>
              {collection.type === 'Auth' ? 'Edit security' : 'Open records'}<ArrowRight aria-hidden="true" size={14} />
            </Link>
          </Surface>)}
        </div>
      </section>}
    </div>
  );
}

export function SettingsPage() {
  const { refresh } = useDiagnostics();
  return (
    <div className="page-stack">
      <PageHeading description="Read-only health for this local Modelry project." eyebrow="SYSTEM" title="Settings" />
      <section aria-labelledby="settings-status-heading" className="health-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">DIAGNOSTICS</p>
            <h2 id="settings-status-heading">Runtime &amp; storage</h2>
            <p className="section-description">Review Local Storage health, provider, and project path.</p>
          </div>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={15} /> Refresh status</Button>
        </div>
        <HealthSummary />
        <DiagnosticsCards />
      </section>
      <Surface className="settings-note" variant="inset">
        <span className="scope-icon"><HardDrive aria-hidden="true" size={17} /></span>
        <div><strong>Files &amp; storage</strong><p>Choose the Local or S3-compatible Storage Provider and move existing files without changing Records.</p><Link className="text-link" to="/settings/storage">Open Files &amp; storage</Link></div>
      </Surface>
      <Surface className="settings-note" variant="inset">
        <span className="scope-icon"><LockKeyhole aria-hidden="true" size={17} /></span>
        <div><strong>Read-only diagnostics</strong><p>Status requests show safe health snapshots. Only a signed-in Owner can see the Local Storage path.</p></div>
      </Surface>
    </div>
  );
}
