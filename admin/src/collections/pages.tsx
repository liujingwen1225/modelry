import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, Database, Plus, RefreshCw, Search, Shield, SlidersHorizontal } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
import { useI18n } from '../i18n/i18n';
import { useCommandRegistry, useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { createCollection, getCollection, getPendingChange, listAllCollections, type AuthenticationConfiguration, type Collection, type CollectionCreateRequest, type CollectionSummary, type CollectionType, type FieldDefinition, type FieldType, type PendingChange } from './client';
import './collections.css';
import type { CollectionWorkspaceContext } from './workspace-context';

const SYSTEM_FIELDS = [
  { name: 'id', label: 'System ID', type: 'text' },
  { name: 'createdAt', label: 'Created time', type: 'dateTime' },
  { name: 'updatedAt', label: 'Updated time', type: 'dateTime' },
] as const;

type FieldDraft = {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  description: string;
  defaultValue: string;
  validation: string;
  targetCollectionId: string;
  cardinality: string;
};

type FieldErrors = Record<string, string>;

function newFieldDraft(key: string): FieldDraft {
  return {
    key, name: '', type: 'text', required: false, unique: false,
    description: '', defaultValue: '', validation: '', targetCollectionId: '', cardinality: 'many-to-one',
  };
}

function apiErrorCopy(error: unknown, fallback: string) {
  if (!(error instanceof ApiClientError)) {
    return { title: fallback, message: error instanceof Error ? error.message : 'Try again when the project is available.' };
  }
  return {
    title: error.apiError.message,
    message: [error.apiError.code, error.apiError.hint, `Request ID: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
  };
}

function PageTitle({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-heading collection-heading">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="page-description">{description}</p></div>
      {action && <div className="collection-heading__action">{action}</div>}
    </header>
  );
}

export function CollectionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const search = searchParams.get('q') ?? '';
  const type = searchParams.get('type') ?? 'all';
  const sort = searchParams.get('sort') ?? 'recent';
  const view = searchParams.get('view') === 'list' ? 'list' : 'card';

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void listAllCollections(controller.signal).then((collections) => {
      if (controller.signal.aborted) return;
      setItems(collections);
      setState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setState('error');
    });
    return () => controller.abort();
  }, [reloadKey]);

  const visible = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesSearch = !normalized || `${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(normalized);
      return matchesSearch && (type === 'all' || item.type === type);
    }).sort((left, right) => sort === 'name'
      ? left.name.localeCompare(right.name)
      : (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || left.name.localeCompare(right.name));
  }, [items, search, sort, type]);

  function updateQuery(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="page-stack collection-page">
      <PageTitle
        action={<Link className="button button--primary" to="/collections/new"><Plus aria-hidden="true" size={16} />Create Collection</Link>}
        description="Define the data model for your application."
        eyebrow="BUILD"
        title="Collections"
      />
      <Surface className="collection-toolbar" variant="standard">
        <label className="collection-search">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">Search collections</span>
          <input aria-label="Search collections" onChange={(event) => updateQuery('q', event.target.value)} placeholder="Search collections…" type="search" value={search} />
        </label>
        <label className="collection-filter"><SlidersHorizontal aria-hidden="true" size={15} /><span>Type</span>
          <select aria-label="Type" onChange={(event) => updateQuery('type', event.target.value === 'all' ? '' : event.target.value)} value={type}>
            <option value="all">All types</option><option value="Normal">Normal</option><option value="Auth">Auth</option>
          </select>
        </label>
        <label className="collection-filter"><span>Sort</span>
          <select aria-label="Sort collections" onChange={(event) => updateQuery('sort', event.target.value)} value={sort}>
            <option value="recent">Recently created</option><option value="name">Name</option>
          </select>
        </label>
        <div aria-label="Collection view" className="collection-view-toggle" role="group">
          <button aria-pressed={view === 'card'} onClick={() => updateQuery('view', '')} type="button">Cards</button>
          <button aria-pressed={view === 'list'} onClick={() => updateQuery('view', 'list')} type="button">List</button>
        </div>
      </Surface>

      {state === 'loading' && <LoadingState label="Loading collections" />}
      {state === 'error' && (() => {
        const copy = apiErrorCopy(error, 'Collections could not be loaded.');
        return <ErrorState description={copy.message} title={copy.title}>
          <Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> Retry</Button>
        </ErrorState>;
      })()}
      {state === 'ready' && visible.length === 0 && items.length === 0 && (
        <EmptyState description="Create a Collection with its first Fields. Your system fields are added automatically." title="No collections yet">
          <Link className="button button--primary" to="/collections/new"><Plus aria-hidden="true" size={15} />Create Collection</Link>
        </EmptyState>
      )}
      {state === 'ready' && visible.length === 0 && items.length > 0 && (
        <EmptyState description="Try another name or adjust the type filter." title="No collections match this search" />
      )}
      {state === 'ready' && visible.length > 0 && view === 'card' && (
        <div className="collection-grid">
          {visible.map((collection) => <CollectionCard collection={collection} key={collection.id} />)}
        </div>
      )}
      {state === 'ready' && visible.length > 0 && view === 'list' && (
        <div className="collection-list" role="list">
          {visible.map((collection) => <CollectionListItem collection={collection} key={collection.id} />)}
        </div>
      )}
    </div>
  );
}

function CollectionCard({ collection }: { collection: CollectionSummary }) {
  return (
    <Link className="collection-card" to={`/collections/${encodeURIComponent(collection.id)}`}>
      <div className="collection-card__top"><span className="collection-card__icon"><Database aria-hidden="true" size={18} /></span><StatusChip state={collection.type}>{collection.type}</StatusChip></div>
      <h2>{collection.name}</h2>
      <p className="collection-card__description">{collection.description || 'No description'}</p>
      <div className="collection-card__meta">
        <span>{collectionCount(collection.recordCount, 'record')}</span>
        <span>{collectionCount(collection.fields.filter((field) => !field.system).length, 'field')}</span>
        <CollectionChangeIndicator status={collection.pendingChangeStatus} />
      </div>
      <span className="collection-card__open">Open workspace <ArrowRight aria-hidden="true" size={14} /></span>
    </Link>
  );
}

function CollectionListItem({ collection }: { collection: CollectionSummary }) {
  return <Link className="collection-list__item" role="listitem" to={`/collections/${encodeURIComponent(collection.id)}`}>
    <span className="collection-list__icon"><Database aria-hidden="true" size={17} /></span>
    <span className="collection-list__identity"><strong>{collection.name}</strong><span>{collection.description || 'No description'}</span></span>
    <StatusChip state={collection.type}>{collection.type}</StatusChip>
    <span className="collection-list__meta">
      {collectionCount(collection.recordCount, 'record')} · {collectionCount(collection.fields.filter((field) => !field.system).length, 'field')}
      <CollectionChangeIndicator status={collection.pendingChangeStatus} />
    </span>
    <ArrowRight aria-hidden="true" className="collection-list__arrow" size={15} />
  </Link>;
}

function collectionCount(count: number | undefined, noun: 'record' | 'field') {
  if (typeof count !== 'number') return `— ${noun}s`;
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function CollectionChangeIndicator({ status }: { status?: CollectionSummary['pendingChangeStatus'] }) {
  if (!status) return null;
  const label = status === 'failed' ? 'Failed change' : status === 'needsReview' ? 'Review needed' : 'Pending change';
  const tone = status === 'failed' ? 'failed' : status === 'needsReview' ? 'needs-review' : 'pending';
  return <span className={`collection-change collection-change--${tone}`}>{label}</span>;
}

function authDefaults(): AuthenticationConfiguration {
  return { emailPasswordEnabled: true, selfRegistration: false, sessionDurationDays: 7 };
}

function isFieldName(value: string) {
  return /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value);
}

function parseInitialFields(fields: FieldDraft[], type: CollectionType): { fields: FieldDefinition[]; errors: Record<string, FieldErrors> } {
  const errors: Record<string, FieldErrors> = {};
  const seen = new Set<string>(['id', 'createdat', 'updatedat', 'password']);
  if (type === 'Auth') seen.add('email');
  const result: FieldDefinition[] = [];
  fields.forEach((field, index) => {
    const name = field.name.trim();
    if (!name && fields.length === 1 && index === 0) return;
    const rowErrors: FieldErrors = {};
    if (!isFieldName(name)) rowErrors.name = 'Use a letter first, then letters, numbers, or underscores.';
    if (seen.has(name.toLocaleLowerCase())) rowErrors.name = 'Field names must be unique.';
    if (name) seen.add(name.toLocaleLowerCase());

    const definition: FieldDefinition = { name, type: field.type, required: field.required, unique: field.unique };
    if (field.description.trim()) definition.description = field.description.trim();
    if (field.defaultValue.trim()) {
      try { definition.default = JSON.parse(field.defaultValue); }
      catch { rowErrors.defaultValue = 'Enter a valid JSON value.'; }
    }
    if (field.validation.trim()) {
      try {
        const validation: unknown = JSON.parse(field.validation);
        if (!validation || typeof validation !== 'object' || Array.isArray(validation)) rowErrors.validation = 'Validation must be a JSON object.';
        else definition.validation = validation as Record<string, unknown>;
      } catch { rowErrors.validation = 'Enter a valid JSON object.'; }
    }
    if (field.type === 'relation') {
      if (!field.targetCollectionId) rowErrors.target = 'Choose a target Collection.';
      else definition.relation = { targetCollectionId: field.targetCollectionId, cardinality: field.cardinality };
    }
    if (Object.keys(rowErrors).length) errors[field.key] = rowErrors;
    result.push(definition);
  });
  return { fields: result, errors };
}

export function CreateCollectionPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<CollectionType>('Normal');
  const [fields, setFields] = useState<FieldDraft[]>([newFieldDraft('field-1')]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, FieldErrors>>({});
  const [nameError, setNameError] = useState('');
  const [authentication, setAuthentication] = useState<AuthenticationConfiguration>(authDefaults);
  const [targets, setTargets] = useState<Collection[]>([]);
  const [targetsError, setTargetsError] = useState(false);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<unknown>();
  const nextFieldNumber = useRef(2);

  useEffect(() => {
    const controller = new AbortController();
    void listAllCollections(controller.signal).then((values) => {
      if (controller.signal.aborted) return;
      setTargets(values);
      setTargetsError(false);
      setTargetsLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setTargetsError(true);
      setTargetsLoading(false);
    });
    return () => controller.abort();
  }, []);

  function updateField(key: string, patch: Partial<FieldDraft>) {
    setFields((current) => current.map((field) => field.key === key ? { ...field, ...patch } : field));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRequestError(undefined);
  }

  function addField() {
    const key = `field-${nextFieldNumber.current++}`;
    setFields((current) => [...current, newFieldDraft(key)]);
    setTimeout(() => document.getElementById(`field-name-${key}`)?.focus(), 0);
  }

  function handleFieldEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addField();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const nextNameError = !trimmedName
      ? 'Enter a Collection name.'
      : trimmedName !== name || [...trimmedName].length > 80
        ? 'Use 1–80 characters with no leading or trailing spaces.'
        : '';
    const parsed = parseInitialFields(fields, type);
    setNameError(nextNameError);
    setFieldErrors(parsed.errors);
    setRequestError(undefined);
    if (nextNameError || Object.keys(parsed.errors).length) return;

    setSubmitting(true);
    try {
      const input: CollectionCreateRequest = {
        name: trimmedName,
        type,
        fields: parsed.fields,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(type === 'Auth' ? { authentication } : {}),
      };
      const collection = await createCollection(input);
      navigate(`/collections/${encodeURIComponent(collection.id)}`, { state: { newlyCreated: true } });
    } catch (error) {
      setRequestError(error);
      const violations = error instanceof ApiClientError ? error.apiError.details.violations : undefined;
      if (Array.isArray(violations)) {
        const nextErrors: Record<string, FieldErrors> = {};
        for (const [index, field] of fields.entries()) {
          const violation = violations.find((item) => typeof item.path === 'string' && item.path.includes(`/fields/${index}/name`));
          if (violation && typeof violation.message === 'string') nextErrors[field.key] = { name: violation.message };
        }
        if (Object.keys(nextErrors).length) setFieldErrors(nextErrors);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="focused-workspace collection-create-page">
      <Link className="text-link text-link--muted collection-back" to="/collections"><ArrowLeft aria-hidden="true" size={14} />Collections</Link>
      <div className="collection-create-intro"><p className="eyebrow">BUILD · INITIAL MODEL</p><h1>Create Collection</h1><p>Set up the Collection and its first Fields together. You can keep evolving the schema later.</p></div>
      {requestError !== undefined && (() => {
        const copy = apiErrorCopy(requestError, 'The Collection could not be created.');
        const api = requestError instanceof ApiClientError ? requestError.apiError : undefined;
        return <ErrorState className="collection-form-error" description={copy.message} title={copy.title}>
          {api?.details.violations && Array.isArray(api.details.violations) && <ul>{api.details.violations.map((violation, index) => <li key={`${violation.path}-${index}`}>{violation.message}</li>)}</ul>}
        </ErrorState>;
      })()}

      <form className="collection-create-form" noValidate onSubmit={(event) => void submit(event)}>
        <Surface className="collection-create-section" variant="standard">
          <div className="collection-section-heading"><div><p className="eyebrow">COLLECTION DETAILS</p><h2>Choose a type and name</h2></div></div>
          <fieldset className="collection-type-picker"><legend>Type</legend>
            {(['Normal', 'Auth'] as const).map((option) => <label className={`collection-type-card${type === option ? ' is-selected' : ''}`} key={option}>
              <input aria-label={option === 'Normal' ? 'Normal Collection' : 'Auth Collection'} checked={type === option} name="collection-type" onChange={() => setType(option)} type="radio" value={option} />
              <span className="collection-type-card__check" aria-hidden="true"><Check size={14} /></span>
              <span className="collection-type-card__text"><strong>{option === 'Normal' ? 'Normal Collection' : 'Auth Collection'}</strong><span>{option === 'Normal' ? 'A flexible business model for your application.' : 'A user profile with email and password sign-in.'}</span></span>
            </label>)}
          </fieldset>
          <div className="collection-form-grid">
            <FormField htmlFor="collection-name" label="Collection name" hint="Use the name you use for this kind of information.">
              <input aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'collection-name-error' : undefined} autoComplete="off" id="collection-name" onChange={(event) => { setName(event.target.value); setNameError(''); setRequestError(undefined); }} value={name} />
            </FormField>
            {nameError && <p className="collection-field-error" id="collection-name-error" role="alert">{nameError}</p>}
            <FormField htmlFor="collection-description" label="Description" hint="Optional. Help your team recognize this Collection.">
              <textarea id="collection-description" onChange={(event) => setDescription(event.target.value)} rows={2} value={description} />
            </FormField>
          </div>
        </Surface>

        <Surface className="collection-create-section" variant="standard">
          <div className="collection-section-heading"><div><p className="eyebrow">ALWAYS AVAILABLE</p><h2>System fields</h2><p>These fields are managed by Modelry and added automatically.</p></div></div>
          <div className="system-fields-table" role="table" aria-label="System fields">
            <div className="system-fields-table__head" role="row"><span role="columnheader">Name</span><span role="columnheader">Type</span><span role="columnheader">Access</span></div>
            {SYSTEM_FIELDS.map((field) => <div className="system-fields-table__row" key={field.name} role="row"><strong role="cell">{field.name}</strong><span role="cell">{field.label}</span><span className="system-field-lock" role="cell"><Shield aria-hidden="true" size={13} />System · Locked</span></div>)}
            {type === 'Auth' && <div className="system-fields-table__row system-fields-table__row--auth" role="row"><strong role="cell">email</strong><span role="cell">Email identifier</span><span className="system-field-lock" role="cell"><Shield aria-hidden="true" size={13} />Required · Unique</span></div>}
          </div>
        </Surface>

        {type === 'Auth' && <Surface className="collection-create-section auth-initial-settings" variant="standard">
          <div className="collection-section-heading"><div><p className="eyebrow">AUTHENTICATION</p><h2>Sign-in defaults</h2><p>Email is the required, unique identifier. Passwords are stored separately from profile fields.</p></div></div>
          <div className="auth-default-grid">
            <label className="auth-default-row"><span><strong>Email + password</strong><small>Sign-in method for this Auth Collection.</small></span><span className="auth-default-control"><input checked={authentication.emailPasswordEnabled} onChange={(event) => setAuthentication((value) => ({ ...value, emailPasswordEnabled: event.target.checked }))} type="checkbox" />Enabled</span></label>
            <label className="auth-default-row"><span><strong>Allow users to sign up</strong><small>When enabled, users can register through the Application API.</small></span><input aria-label="Allow users to sign up" checked={authentication.selfRegistration} onChange={(event) => setAuthentication((value) => ({ ...value, selfRegistration: event.target.checked }))} type="checkbox" /></label>
            <FormField htmlFor="session-duration" label="Session duration (days)" hint="Choose how long a sign-in stays active.">
              <input id="session-duration" min={1} onChange={(event) => setAuthentication((value) => ({ ...value, sessionDurationDays: Number(event.target.value) }))} type="number" value={authentication.sessionDurationDays} />
            </FormField>
          </div>
        </Surface>}

        <Surface className="collection-create-section" variant="standard">
          <div className="collection-section-heading collection-section-heading--fields"><div><p className="eyebrow">INITIAL MODEL</p><h2>Initial fields</h2><p>Enter the first details your records need. Add a relation inline when a field connects to another Collection.</p></div><span className="collection-field-count">{fields.length} {fields.length === 1 ? 'field' : 'fields'}</span></div>
          {targetsError && <div className="collection-inline-warning" role="status"><CircleAlert aria-hidden="true" size={15} /><span>Existing Collections could not be loaded. Retry to configure a Relation target.</span><Button onClick={() => { setTargetsLoading(true); setTargetsError(false); void listAllCollections().then(setTargets).catch(() => setTargetsError(true)).finally(() => setTargetsLoading(false)); }} size="small" type="button">Retry</Button></div>}
          {fields.map((field, index) => <FieldEditorRow
            errors={fieldErrors[field.key] ?? {}}
            field={field}
            index={index}
            key={field.key}
            onEnter={handleFieldEnter}
            onRemove={() => { if (fields.length > 1) setFields((current) => current.filter((item) => item.key !== field.key)); }}
            onUpdate={(patch) => updateField(field.key, patch)}
            removable={fields.length > 1}
            targets={targets}
            targetsLoading={targetsLoading}
          />)}
          <Button className="collection-add-field" onClick={addField} size="small" type="button"><Plus aria-hidden="true" size={14} />Add initial field</Button>
          <p className="collection-enter-hint"><kbd>Enter</kbd> in a field name adds another field.</p>
        </Surface>

        <footer className="collection-form-actions"><Link className="button button--secondary" to="/collections">Cancel</Link><Button disabled={submitting} type="submit" variant="primary">{submitting ? 'Creating Collection…' : 'Create Collection'}<ArrowRight aria-hidden="true" size={15} /></Button></footer>
      </form>
    </main>
  );
}

type FieldEditorProps = {
  errors: FieldErrors;
  field: FieldDraft;
  index: number;
  onEnter: (event: KeyboardEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<FieldDraft>) => void;
  removable: boolean;
  targets: Collection[];
  targetsLoading: boolean;
};

function FieldEditorRow({ errors, field, index, onEnter, onRemove, onUpdate, removable, targets, targetsLoading }: FieldEditorProps) {
  const detailsId = useId();
  return (
    <section className="initial-field-row" aria-label={`Initial field ${index + 1}`}>
      <div className="initial-field-row__main">
        <FormField htmlFor={`field-name-${field.key}`} label="Name">
          <input aria-label={`Field name ${index + 1}`} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `field-name-error-${field.key}` : undefined} autoComplete="off" id={`field-name-${field.key}`} onChange={(event) => onUpdate({ name: event.target.value })} onKeyDown={onEnter} placeholder="e.g. title" value={field.name} />
          {errors.name && <span className="collection-field-error" id={`field-name-error-${field.key}`} role="alert">{errors.name}</span>}
        </FormField>
        <FormField htmlFor={`field-type-${field.key}`} label="Type">
          <select id={`field-type-${field.key}`} onChange={(event) => onUpdate({ type: event.target.value as FieldType, ...(event.target.value === 'relation' ? {} : { targetCollectionId: '' }) })} value={field.type}>
            <option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="dateTime">Date &amp; time</option><option value="json">JSON</option><option value="relation">Relation</option><option value="file">File</option>
          </select>
        </FormField>
        <label className="initial-field-toggle"><input checked={field.required} onChange={(event) => onUpdate({ required: event.target.checked })} type="checkbox" />Required</label>
        <label className="initial-field-toggle"><input checked={field.unique} onChange={(event) => onUpdate({ unique: event.target.checked })} type="checkbox" />Unique</label>
        {removable && <Button aria-label={`Remove initial field ${index + 1}`} className="initial-field-remove" onClick={onRemove} size="small" type="button" variant="quiet">Remove</Button>}
      </div>
      {field.type === 'relation' && <div className="initial-relation-config">
        <FormField htmlFor={`field-target-${field.key}`} label="Target Collection">
          <select id={`field-target-${field.key}`} aria-invalid={Boolean(errors.target)} onChange={(event) => onUpdate({ targetCollectionId: event.target.value })} value={field.targetCollectionId}>
            <option value="">{targetsLoading ? 'Loading Collections…' : 'Choose a Collection'}</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
          {errors.target && <span className="collection-field-error" role="alert">{errors.target}</span>}
        </FormField>
        <FormField htmlFor={`field-cardinality-${field.key}`} label="Cardinality">
          <select id={`field-cardinality-${field.key}`} onChange={(event) => onUpdate({ cardinality: event.target.value })} value={field.cardinality}>
            <option value="many-to-one">Many to one</option><option value="one-to-one">One to one</option><option value="one-to-many">One to many</option><option value="many-to-many">Many to many</option>
          </select>
        </FormField>
      </div>}
      <details className="initial-field-advanced" id={detailsId}>
        <summary><ChevronDown aria-hidden="true" size={14} />Advanced field settings</summary>
        <div className="initial-field-advanced__grid">
          <FormField htmlFor={`field-description-${field.key}`} label="Description">
            <input id={`field-description-${field.key}`} onChange={(event) => onUpdate({ description: event.target.value })} placeholder="Optional" value={field.description} />
          </FormField>
          <FormField htmlFor={`field-default-${field.key}`} label="Default value (JSON)" hint={'Examples: "draft", 0, true, or null.'}>
            <input aria-invalid={Boolean(errors.defaultValue)} id={`field-default-${field.key}`} onChange={(event) => onUpdate({ defaultValue: event.target.value })} placeholder="Optional" value={field.defaultValue} />
            {errors.defaultValue && <span className="collection-field-error" role="alert">{errors.defaultValue}</span>}
          </FormField>
          <FormField htmlFor={`field-validation-${field.key}`} label="Validation (JSON object)" hint="For example: {&quot;minLength&quot;: 2}">
            <textarea aria-invalid={Boolean(errors.validation)} id={`field-validation-${field.key}`} onChange={(event) => onUpdate({ validation: event.target.value })} placeholder="Optional" rows={2} value={field.validation} />
            {errors.validation && <span className="collection-field-error" role="alert">{errors.validation}</span>}
          </FormField>
        </div>
      </details>
    </section>
  );
}

export function CollectionWorkspacePage() {
  const { collectionId = '' } = useParams();
  const location = useLocation();
  const { t } = useI18n();
  const { rememberCollection } = useCommandRegistry();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [collectionError, setCollectionError] = useState<unknown>();
  const [pendingError, setPendingError] = useState<unknown>();
  const [loadingCollection, setLoadingCollection] = useState(true);
  const [loadingPending, setLoadingPending] = useState(true);
  const [newlyCreated, setNewlyCreated] = useState(Boolean((location.state as { newlyCreated?: boolean } | null)?.newlyCreated));

  const workspaceCommands = useMemo<AdminCommand[]>(() => {
    if (!collection || !pending) return [];
    const failed = pending.status === 'failed';
    const route = failed
      ? `/changes?changeSet=${encodeURIComponent(pending.changeSetId)}`
      : `/collections/${encodeURIComponent(collection.id)}/schema`;
    return [{
      id: `change.open.${pending.changeSetId}`,
      category: 'commands.categories.changes',
      label: () => t(failed ? 'commands.failedChange' : 'commands.pendingChange', { name: collection.name }),
      keywords: () => ['pending', 'failed', 'change', 'schema', collection.name],
      execute: (context) => context.navigate(route),
    }];
  }, [collection, pending, t]);

  useRegisterCommands(workspaceCommands);

  useEffect(() => {
    if (collection) rememberCollection({ id: collection.id, name: collection.name, type: collection.type });
  }, [collection, rememberCollection]);

  async function refreshCollection() {
    setLoadingCollection(true);
    try { setCollection(await getCollection(collectionId)); setCollectionError(undefined); }
    catch (error) { setCollectionError(error); }
    finally { setLoadingCollection(false); }
  }

  async function refreshPendingChange(): Promise<PendingChange | null> {
    setLoadingPending(true);
    try {
      const value = await getPendingChange(collectionId);
      setPending(value);
      setPendingError(undefined);
      return value;
    } catch (error) { setPendingError(error); throw error; }
    finally { setLoadingPending(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoadingCollection(true);
    setLoadingPending(true);
    void getCollection(collectionId, controller.signal).then((value) => { if (!controller.signal.aborted) { setCollection(value); setCollectionError(undefined); } }).catch((error: unknown) => { if (!controller.signal.aborted) setCollectionError(error); }).finally(() => { if (!controller.signal.aborted) setLoadingCollection(false); });
    void getPendingChange(collectionId, controller.signal).then((value) => { if (!controller.signal.aborted) { setPending(value); setPendingError(undefined); } }).catch((error: unknown) => { if (!controller.signal.aborted) setPendingError(error); }).finally(() => { if (!controller.signal.aborted) setLoadingPending(false); });
    return () => controller.abort();
  }, [collectionId]);

  if (loadingCollection) return <div className="collection-page collection-workspace-page"><LoadingState label="Loading Collection workspace" /></div>;
  if (collectionError || !collection) {
    const copy = apiErrorCopy(collectionError, 'The Collection could not be loaded.');
    return <div className="page-stack collection-page"><ErrorState description={copy.message} title={copy.title}><Button onClick={() => void refreshCollection()} size="small"><RefreshCw aria-hidden="true" size={14} /> Retry</Button><Link className="text-link" to="/collections">Back to Collections</Link></ErrorState></div>;
  }

  const context: CollectionWorkspaceContext = { collection, pendingChange: pending, refreshCollection, refreshPendingChange };
  return (
    <div className="page-stack collection-page collection-workspace-page">
      <div className="collection-breadcrumb"><Link to="/collections">{t('navigation.collections')}</Link><span aria-hidden="true">/</span><span>{collection.name}</span></div>
      <header className="collection-workspace-header">
        <div className="collection-workspace-identity"><span className="collection-workspace-icon"><Database aria-hidden="true" size={20} /></span><div><div className="collection-workspace-title"><h1>{collection.name}</h1><StatusChip state={collection.type}>{collection.type}</StatusChip></div><p>{collection.description || 'Collection workspace'}</p></div></div>
        <span className="collection-workspace-meta">Model v{collection.schemaVersion ?? 1} · {collection.fields.length} fields</span>
      </header>
      {newlyCreated && <div className="collection-created-notice" role="status"><Check aria-hidden="true" size={16} /><div><strong>Your collection is ready.</strong><span>The Collection and its initial model are saved. Continue with Records or edit the schema.</span></div><button aria-label="Dismiss collection created notice" onClick={() => setNewlyCreated(false)} type="button">Dismiss</button></div>}
      {!loadingPending && pendingError !== undefined && <ErrorState className="collection-workspace-error" description={apiErrorCopy(pendingError, 'Schema status is unavailable.').message} title="Could not load the Pending Change"><Button onClick={() => void refreshPendingChange()} size="small"><RefreshCw aria-hidden="true" size={14} /> Retry</Button></ErrorState>}
      {!loadingPending && pending?.status === 'failed' && <div className="collection-recovery-banner" role="status"><CircleAlert aria-hidden="true" size={17} /><div><strong>A schema change needs attention.</strong><span>Your pending changes are saved. Review the recovery details before retrying.</span></div><Link className="text-link" to={`/changes?changeSet=${encodeURIComponent(pending.changeSetId)}`}>View recovery details <ArrowRight aria-hidden="true" size={14} /></Link></div>}
      <nav aria-label={t('navigation.collectionWorkspace')} className="collection-workspace-tabs">
        {[
          { label: t('navigation.records'), to: `/collections/${collectionId}`, end: true },
          { label: t('navigation.schema'), to: `/collections/${collectionId}/schema` },
          { label: t('navigation.security'), to: `/collections/${collectionId}/security` },
          { label: t('navigation.api'), to: `/collections/${collectionId}/api` },
        ].map((tab) => <NavLink end={tab.end} key={tab.label} to={tab.to}>{tab.label}</NavLink>)}
      </nav>
      <Outlet context={context} />
    </div>
  );
}

export { CollectionSchemaPage } from './schema';
