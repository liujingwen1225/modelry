import { Link } from 'react-router-dom';
import { ArrowRight, CircleDot, HeartPulse, Layers3, LockKeyhole, RefreshCw } from 'lucide-react';
import { useDiagnostics } from '../components/diagnostics-context';
import { DiagnosticsCards } from '../components/runtime-status';
import { Button, PartialState, StatusChip, Surface } from '../components/ui';

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
  const { refresh } = useDiagnostics();
  return (
    <div className="page-stack">
      <PageHeading
        description="A clear view of your local backend and its runtime health."
        eyebrow="PROJECT OVERVIEW"
        title="Overview"
      />
      <Surface className="overview-hero" variant="raised">
        <div className="hero-decoration" aria-hidden="true"><span /><span /><span /></div>
        <div className="overview-hero__content">
          <div className="hero-kicker"><span className="hero-kicker__mark"><Layers3 size={15} /></span> MODELRY WORKSPACE</div>
          <h2>Everything starts with a<br className="desktop-only" /> healthy foundation.</h2>
          <p>Runtime and storage status are read directly from this local project. Product workflows will arrive in their own release gates.</p>
          <div className="hero-links">
            <Link className="text-link" to="/settings">Review system status <ArrowRight aria-hidden="true" size={15} /></Link>
            <span className="hero-separator" aria-hidden="true">·</span>
            <Link className="text-link text-link--muted" to="/collections">Collections</Link>
          </div>
        </div>
        <div className="hero-emblem" aria-hidden="true">
          <div className="emblem-core"><Layers3 size={31} strokeWidth={1.4} /></div>
          <span className="emblem-orbit emblem-orbit--one" />
          <span className="emblem-orbit emblem-orbit--two" />
          <span className="emblem-orbit emblem-orbit--three" />
        </div>
      </Surface>
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
      </section>
      <section aria-labelledby="scope-heading" className="scope-section">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h2 id="scope-heading">A focused foundation</h2>
          </div>
        </div>
        <div className="scope-grid">
          <Surface className="scope-card" variant="standard">
            <span className="scope-icon"><Layers3 aria-hidden="true" size={18} /></span>
            <h3>Build your model</h3>
            <p>Collections and API workflows have a place in the workspace. Their product operations are not delivered in this foundation closure.</p>
            <Link className="text-link" to="/collections">View Collections area <ArrowRight aria-hidden="true" size={15} /></Link>
          </Surface>
          <Surface className="scope-card" variant="standard">
            <span className="scope-icon scope-icon--violet"><LockKeyhole aria-hidden="true" size={18} /></span>
            <h3>Operate with clarity</h3>
            <p>Access and change workflows are reserved for their own release gates. This shell does not show sample data or pretend actions.</p>
            <Link className="text-link text-link--muted" to="/access">View Access area <ArrowRight aria-hidden="true" size={15} /></Link>
          </Surface>
        </div>
      </section>
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
            <p className="section-description">Anonymous snapshots contain health state and provider only. Local paths are not displayed.</p>
          </div>
          <Button onClick={refresh} size="small" variant="secondary"><RefreshCw aria-hidden="true" size={15} /> Refresh status</Button>
        </div>
        <HealthSummary />
        <DiagnosticsCards />
      </section>
      <Surface className="settings-note" variant="inset">
        <span className="scope-icon"><LockKeyhole aria-hidden="true" size={17} /></span>
        <div><strong>Safe diagnostics</strong><p>Status requests use the anonymous, read-only Runtime and Storage endpoints. No Owner session is sent.</p></div>
      </Surface>
    </div>
  );
}

const pageDescriptions = {
  Collections: 'Define the data model for your application.',
  API: 'Explore the API generated from your backend model.',
  Changes: 'Review and apply model changes with confidence.',
  Access: 'Understand how applications and users can access data.',
} as const;

export function FoundationScopePage({ title }: { title: keyof typeof pageDescriptions }) {
  return (
    <div className="page-stack">
      <PageHeading description={pageDescriptions[title]} eyebrow={title === 'Collections' || title === 'API' ? 'BUILD' : 'OPERATE'} title={title} />
      <Surface className="scope-empty" variant="raised">
        <div className="scope-empty__mark" aria-hidden="true"><Layers3 size={24} strokeWidth={1.6} /></div>
        <div>
          <p className="eyebrow">FOUNDATION SCOPE</p>
          <h2>This workflow is not delivered yet</h2>
          <p>The V0.1 navigation is in place. The {title.toLowerCase()} product workflow is outside this Foundation closure, so this page has no sample data or pretend actions.</p>
          <Link className="text-link" to="/">Return to Overview <ArrowRight aria-hidden="true" size={15} /></Link>
        </div>
      </Surface>
    </div>
  );
}
