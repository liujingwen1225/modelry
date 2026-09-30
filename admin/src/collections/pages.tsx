import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, Database, LayoutGrid, List, Plus, RefreshCw, Search, Shield } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button, ButtonLink } from '../components/button';
import { FormField } from '../components/form-field';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n } from '../i18n/i18n';
import { useCommandRegistry, useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { usePendingChanges } from '../components/pending-changes-context';
import { createCollection, getCollection, getPendingChange, listAllCollections, type AuthenticationConfiguration, type Collection, type CollectionCreateRequest, type CollectionSummary, type CollectionType, type FieldDefinition, type FieldType, type PendingChange } from './client';
import type { CollectionWorkspaceContext } from './workspace-context';

const SYSTEM_FIELDS = [
  { name: 'id', type: 'text' },
  { name: 'createdAt', type: 'dateTime' },
  { name: 'updatedAt', type: 'dateTime' },
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

function apiErrorCopy(
  error: unknown,
  fallback: string,
  t: ReturnType<typeof useI18n>['t'],
  errorMessage: ReturnType<typeof useI18n>['errorMessage'],
) {
  if (!(error instanceof ApiClientError)) {
    return { title: fallback, message: t('common.tryAgainWhenAvailable') };
  }
  return {
    title: errorMessage(error.apiError.code) ?? t('errors.requestFailed'),
    message: [t('common.errorCode'), error.apiError.code, `${t('common.requestId')}: ${error.apiError.requestId}`, t('common.tryAgainWhenAvailable')].join(' · '),
  };
}

export function CollectionsPage() {
  const { t, errorMessage } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const search = searchParams.get('q') ?? '';
  const type = searchParams.get('type') ?? 'all';
  const sort = searchParams.get('sort') ?? 'recent';
  // Spec 0001 §6.1：默认进入紧凑列表，不默认展示大图卡片墙。
  const view = searchParams.get('view') === 'card' ? 'card' : 'list';

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

  const typeItems = [
    { value: 'all', label: t('collections.allTypes') },
    { value: 'Normal', label: t('collections.normal') },
    { value: 'Auth', label: t('collections.auth') },
  ];
  const sortItems = [
    { value: 'recent', label: t('collections.recentlyCreated') },
    { value: 'name', label: t('collections.name') },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="eyebrow">{t('collections.eyebrow')}</p>
          <h1>{t('collections.title')}</h1>
          <p className="mt-2.5 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('collections.description')}</p>
        </div>
        <ButtonLink to="/collections/new" variant="primary"><Plus aria-hidden="true" size={16} />{t('collections.create')}</ButtonLink>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 md:max-w-sm">
          <Search aria-hidden="true" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('collections.search')}
            className="pl-9"
            onChange={(event) => updateQuery('q', event.target.value)}
            placeholder={t('collections.searchPlaceholder')}
            type="search"
            value={search}
          />
        </div>
        <Select items={typeItems} onValueChange={(value) => updateQuery('type', String(value) === 'all' ? '' : String(value))} value={type}>
          <SelectTrigger aria-label={t('collections.type')} className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('collections.allTypes')}</SelectItem>
            <SelectItem value="Normal">{t('collections.normal')}</SelectItem>
            <SelectItem value="Auth">{t('collections.auth')}</SelectItem>
          </SelectContent>
        </Select>
        <Select items={sortItems} onValueChange={(value) => updateQuery('sort', String(value))} value={sort}>
          <SelectTrigger aria-label={t('collections.sortLabel')} className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t('collections.recentlyCreated')}</SelectItem>
            <SelectItem value="name">{t('collections.name')}</SelectItem>
          </SelectContent>
        </Select>
        <div aria-label={t('collections.viewLabel')} className="ml-auto flex overflow-hidden rounded-lg border border-input" role="group">
          {(['list', 'card'] as const).map((option) => (
            <button
              aria-pressed={view === option}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${view === option ? 'bg-primary text-primary-foreground' : 'bg-card text-ink-secondary hover:bg-accent hover:text-accent-foreground'}`}
              key={option}
              onClick={() => updateQuery('view', option === 'list' ? '' : 'card')}
              type="button"
            >
              {option === 'list' ? <List aria-hidden="true" size={14} /> : <LayoutGrid aria-hidden="true" size={14} />}
              {t(option === 'list' ? 'collections.viewList' : 'collections.viewCards')}
            </button>
          ))}
        </div>
      </div>

      {state === 'loading' && <LoadingState label={t('collections.loading')} />}
      {state === 'error' && (() => {
        const copy = apiErrorCopy(error, t('collections.loadFailed'), t, errorMessage);
        return <ErrorState description={copy.message} title={copy.title}>
          <Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('collections.retry')}</Button>
        </ErrorState>;
      })()}
      {state === 'ready' && visible.length === 0 && items.length === 0 && (
        <EmptyState description={t('collections.emptyDescription')} title={t('collections.emptyTitle')}>
          <ButtonLink to="/collections/new" variant="primary"><Plus aria-hidden="true" size={15} />{t('collections.create')}</ButtonLink>
        </EmptyState>
      )}
      {state === 'ready' && visible.length === 0 && items.length > 0 && (
        <EmptyState description={t('collections.noMatchDescription')} title={t('collections.noMatchTitle')} />
      )}
      {state === 'ready' && visible.length > 0 && view === 'list' && (
        <Surface className="overflow-hidden p-0" variant="standard">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="w-[42%]">{t('collections.nameLabel')}</TableHead>
                <TableHead className="w-[16%]">{t('collections.type')}</TableHead>
                <TableHead className="w-[22%]">{t('collections.recordsFieldsLabel')}</TableHead>
                <TableHead className="w-[20%] text-right">{t('collections.updated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((collection) => <CollectionListRow collection={collection} key={collection.id} />)}
            </TableBody>
          </Table>
        </Surface>
      )}
      {state === 'ready' && visible.length > 0 && view === 'card' && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((collection) => <CollectionCard collection={collection} key={collection.id} />)}
        </div>
      )}
    </div>
  );
}

function CollectionListRow({ collection }: { collection: CollectionSummary }) {
  const { t, formatDate } = useI18n();
  return (
    <TableRow className="group relative">
      <TableCell className="min-w-0">
        {/* 整行可点击：链接的伪元素铺满行，键盘焦点仍落在链接上（§13.4）。 */}
        <Link className="flex min-w-0 flex-col gap-0.5 after:absolute after:inset-0" to={`/collections/${encodeURIComponent(collection.id)}`}>
          <span className="truncate font-semibold text-foreground group-hover:text-primary">{collection.name}</span>
          <span className="truncate text-xs text-muted-foreground">{collection.description || t('collections.noDescription')}</span>
        </Link>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge variant={collection.type === 'Auth' ? 'primary' : 'outline'}>{collectionTypeName(collection.type, t)}</Badge>
          <CollectionChangeIndicator status={collection.pendingChangeStatus} />
        </div>
      </TableCell>
      <TableCell className="text-ink-secondary"><span>{collectionCount(collection.recordCount, 'record', t)}</span> · <span>{collectionCount(collection.fields.filter((field) => !field.system).length, 'field', t)}</span></TableCell>
      <TableCell className="text-right text-muted-foreground">{formatDate(collection.updatedAt ?? collection.createdAt ?? Date.now(), { dateStyle: 'medium' })}</TableCell>
    </TableRow>
  );
}

function CollectionCard({ collection }: { collection: CollectionSummary }) {
  const { t, formatDate } = useI18n();
  return (
    <Link className="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary" to={`/collections/${encodeURIComponent(collection.id)}`}>
      <div className="flex items-center justify-between gap-2">
        <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-muted text-ink-secondary"><Database size={18} /></span>
        <Badge variant={collection.type === 'Auth' ? 'primary' : 'outline'}>{collectionTypeName(collection.type, t)}</Badge>
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-foreground group-hover:text-primary">{collection.name}</h2>
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{collection.description || t('collections.noDescription')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
        <span>{collectionCount(collection.recordCount, 'record', t)}</span>
        <span>{collectionCount(collection.fields.filter((field) => !field.system).length, 'field', t)}</span>
        <CollectionChangeIndicator status={collection.pendingChangeStatus} />
        <span className="ml-auto">{formatDate(collection.updatedAt ?? collection.createdAt ?? Date.now(), { dateStyle: 'medium' })}</span>
      </div>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">{t('collections.openWorkspace')} <ArrowRight aria-hidden="true" size={14} /></span>
    </Link>
  );
}

function collectionCount(count: number | undefined, noun: 'record' | 'field', translate: ReturnType<typeof useI18n>['t']) {
  const singular = noun === 'record' ? 'collections.count.recordOne' : 'collections.count.fieldOne';
  const plural = noun === 'record' ? 'collections.count.recordMany' : 'collections.count.fieldMany';
  if (typeof count !== 'number') return '— ' + translate(plural, { count: 0 });
  return translate(count === 1 ? singular : plural, { count });
}

function collectionTypeName(type: CollectionType, t: ReturnType<typeof useI18n>['t']) {
  return t(type === 'Auth' ? 'collections.auth' : 'collections.normal');
}

function CollectionChangeIndicator({ status }: { status?: CollectionSummary['pendingChangeStatus'] }) {
  const { t } = useI18n();
  if (!status) return null;
  const label = status === 'failed' ? t('collections.changeFailed') : status === 'needsReview' ? t('collections.changeReview') : t('collections.changePending');
  return <Badge variant={status === 'failed' ? 'danger' : status === 'needsReview' ? 'warning' : 'default'}>{label}</Badge>;
}

function authDefaults(): AuthenticationConfiguration {
  return { emailPasswordEnabled: true, selfRegistration: false, sessionDurationDays: 7 };
}

function isFieldName(value: string) {
  return /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value);
}

function parseInitialFields(fields: FieldDraft[], type: CollectionType, t: ReturnType<typeof useI18n>['t']): { fields: FieldDefinition[]; errors: Record<string, FieldErrors> } {
  const errors: Record<string, FieldErrors> = {};
  const seen = new Set<string>(['id', 'createdat', 'updatedat', 'password']);
  if (type === 'Auth') seen.add('email');
  const result: FieldDefinition[] = [];
  fields.forEach((field, index) => {
    const name = field.name.trim();
    if (!name && fields.length === 1 && index === 0) return;
    const rowErrors: FieldErrors = {};
    if (!isFieldName(name)) rowErrors.name = t('collections.validation.fieldName');
    if (seen.has(name.toLocaleLowerCase())) rowErrors.name = t('collections.validation.fieldNameUnique');
    if (name) seen.add(name.toLocaleLowerCase());

    const definition: FieldDefinition = { name, type: field.type, required: field.required, unique: field.unique };
    if (field.description.trim()) definition.description = field.description.trim();
    if (field.defaultValue.trim()) {
      try { definition.default = JSON.parse(field.defaultValue); }
      catch { rowErrors.defaultValue = t('collections.validation.jsonValue'); }
    }
    if (field.validation.trim()) {
      try {
        const validation: unknown = JSON.parse(field.validation);
        if (!validation || typeof validation !== 'object' || Array.isArray(validation)) rowErrors.validation = t('collections.validation.validationObject');
        else definition.validation = validation as Record<string, unknown>;
      } catch { rowErrors.validation = t('collections.validation.jsonObject'); }
    }
    if (field.type === 'relation') {
      if (!field.targetCollectionId) rowErrors.target = t('collections.validation.chooseTarget');
      else definition.relation = { targetCollectionId: field.targetCollectionId, cardinality: field.cardinality };
    }
    if (Object.keys(rowErrors).length) errors[field.key] = rowErrors;
    result.push(definition);
  });
  return { fields: result, errors };
}

export function CreateCollectionPage() {
  const { t, errorMessage, validationMessage } = useI18n();
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
      ? t('collections.validation.nameRequired')
      : trimmedName !== name || [...trimmedName].length > 80
        ? t('collections.validation.nameLength')
        : '';
    const parsed = parseInitialFields(fields, type, t);
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
          if (violation) nextErrors[field.key] = {
            name: (typeof violation.code === 'string' ? validationMessage(violation.code) : undefined) ?? t('collections.validation.reviewField'),
          };
        }
        if (Object.keys(nextErrors).length) setFieldErrors(nextErrors);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[880px] min-w-0 flex-col gap-6">
      <Link className="inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground" to="/collections"><ArrowLeft aria-hidden="true" size={14} />{t('collections.title')}</Link>

      <header className="min-w-0">
        <p className="eyebrow">{t('collections.buildEyebrow')}</p>
        <h1>{t('collections.create')}</h1>
        <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('collections.createDescription')}</p>
      </header>

      {requestError !== undefined && (() => {
        const copy = apiErrorCopy(requestError, t('collections.createFailed'), t, errorMessage);
        const api = requestError instanceof ApiClientError ? requestError.apiError : undefined;
        return (
          <ErrorState description={copy.message} title={copy.title}>
            {api?.details.violations && Array.isArray(api.details.violations) && <ul className="mt-2 flex list-none flex-col gap-1 p-0">
              {api.details.violations.map((violation, index) => <li key={`${violation.path}-${index}`}>
                {typeof violation.code === 'string' && <code className="mr-1.5 text-[10px]">{violation.code}</code>}
                {(typeof violation.code === 'string' ? validationMessage(violation.code) : undefined) ?? t('collections.validation.reviewField')}
              </li>)}
            </ul>}
          </ErrorState>
        );
      })()}

      <form className="flex min-w-0 flex-col gap-5" noValidate onSubmit={(event) => void submit(event)}>
        <Surface className="flex min-w-0 flex-col gap-5 p-5" variant="standard">
          <div><p className="eyebrow">{t('collections.detailsEyebrow')}</p><h2>{t('collections.detailsTitle')}</h2></div>

          {/* Spec 0001 §6.2：类型选择留在名称旁边，Auth 选项随后就地出现。 */}
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-[11px] font-semibold text-ink-secondary">{t('collections.type')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['Normal', 'Auth'] as const).map((option) => {
                const selected = type === option;
                return (
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors ${selected ? 'border-primary bg-accent' : 'border-input bg-card hover:border-subtle-foreground'}`}
                    key={option}
                  >
                    <input aria-label={t(option === 'Normal' ? 'collections.typeNormal' : 'collections.typeAuth')} checked={selected} className="mt-0.5" name="collection-type" onChange={() => setType(option)} type="radio" value={option} />
                    <span className="min-w-0">
                      <strong className="block text-xs font-semibold text-foreground">{t(option === 'Normal' ? 'collections.typeNormal' : 'collections.typeAuth')}</strong>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{t(option === 'Normal' ? 'collections.typeNormalDescription' : 'collections.typeAuthDescription')}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField htmlFor="collection-name" label={t('collections.nameLabel')} hint={t('collections.nameHint')}>
              <input aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'collection-name-error' : undefined} autoComplete="off" id="collection-name" onChange={(event) => { setName(event.target.value); setNameError(''); setRequestError(undefined); }} value={name} />
            </FormField>
            {nameError && <p className="m-0 self-start text-[11px] font-semibold text-danger" id="collection-name-error" role="alert">{nameError}</p>}
            <FormField htmlFor="collection-description" label={t('collections.descriptionLabel')} hint={t('collections.descriptionHint')}>
              <textarea id="collection-description" onChange={(event) => setDescription(event.target.value)} rows={2} value={description} />
            </FormField>
          </div>
        </Surface>

        <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
          <div><p className="eyebrow">{t('collections.systemEyebrow')}</p><h2>{t('collections.systemTitle')}</h2><p className="mt-1 text-[11px] text-muted-foreground">{t('collections.systemDescription')}</p></div>
          <Table aria-label={t('collections.systemTitle')}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('collections.systemName')}</TableHead>
                <TableHead scope="col">{t('collections.systemType')}</TableHead>
                <TableHead scope="col">{t('collections.systemAccess')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {SYSTEM_FIELDS.map((field) => (
                <TableRow key={field.name}>
                  <TableHead className="bg-transparent" scope="row"><strong className="font-mono font-semibold text-foreground">{field.name}</strong></TableHead>
                  <TableCell>{t(field.name === 'id' ? 'collections.systemId' : field.name === 'createdAt' ? 'collections.systemCreatedTime' : 'collections.systemUpdatedTime')}</TableCell>
                  <TableCell><Badge variant="outline"><Shield aria-hidden="true" size={13} />{t('collections.systemLocked')}</Badge></TableCell>
                </TableRow>
              ))}
              {type === 'Auth' && (
                <TableRow>
                  <TableHead className="bg-transparent" scope="row"><strong className="font-mono font-semibold text-foreground">email</strong></TableHead>
                  <TableCell>{t('collections.emailIdentifier')}</TableCell>
                  <TableCell><Badge variant="outline"><Shield aria-hidden="true" size={13} />{t('collections.requiredUnique')}</Badge></TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Surface>

        {type === 'Auth' && (
          <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
            <div><p className="eyebrow">{t('collections.authEyebrow')}</p><h2>{t('collections.authTitle')}</h2><p className="mt-1 text-[11px] text-muted-foreground">{t('collections.authDescription')}</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5">
                <span className="min-w-0">
                  <strong className="block text-xs font-semibold text-foreground">{t('collections.emailPassword')}</strong>
                  <small className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{t('collections.emailPasswordHint')}</small>
                </span>
                <span className="inline-flex shrink-0 items-center gap-2 text-[11px] text-ink-secondary">
                  <input checked={authentication.emailPasswordEnabled} onChange={(event) => setAuthentication((value) => ({ ...value, emailPasswordEnabled: event.target.checked }))} type="checkbox" />
                  {t('collections.enabled')}
                </span>
              </label>
              <label className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5">
                <span className="min-w-0">
                  <strong className="block text-xs font-semibold text-foreground">{t('collections.selfRegistration')}</strong>
                  <small className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{t('collections.selfRegistrationHint')}</small>
                </span>
                <input aria-label={t('collections.selfRegistration')} checked={authentication.selfRegistration} className="mt-0.5 shrink-0" onChange={(event) => setAuthentication((value) => ({ ...value, selfRegistration: event.target.checked }))} type="checkbox" />
              </label>
              <FormField htmlFor="session-duration" label={t('collections.sessionDuration')} hint={t('collections.sessionDurationHint')}>
                <input id="session-duration" min={1} onChange={(event) => setAuthentication((value) => ({ ...value, sessionDurationDays: Number(event.target.value) }))} type="number" value={authentication.sessionDurationDays} />
              </FormField>
            </div>
          </Surface>
        )}

        <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><p className="eyebrow">{t('collections.initialEyebrow')}</p><h2>{t('collections.initialTitle')}</h2><p className="mt-1 text-[11px] text-muted-foreground">{t('collections.initialDescription')}</p></div>
            <Badge variant="outline">{collectionCount(fields.length, 'field', t)}</Badge>
          </div>
          {targetsError && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning" role="status">
              <CircleAlert aria-hidden="true" size={15} />
              <span className="min-w-0 flex-1">{t('collections.targetsUnavailable')}</span>
              <Button onClick={() => { setTargetsLoading(true); setTargetsError(false); void listAllCollections().then(setTargets).catch(() => setTargetsError(true)).finally(() => setTargetsLoading(false)); }} size="small" type="button">{t('collections.retry')}</Button>
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-3">
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
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={addField} size="small" type="button"><Plus aria-hidden="true" size={14} />{t('collections.addField')}</Button>
            <p className="m-0 text-[10px] text-muted-foreground"><kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Enter</kbd> {t('collections.enterHint')}</p>
          </div>
        </Surface>

        <footer className="flex flex-wrap justify-end gap-2"><ButtonLink to="/collections">{t('collections.cancel')}</ButtonLink><Button disabled={submitting} type="submit" variant="primary">{submitting ? t('collections.creating') : t('collections.create')}<ArrowRight aria-hidden="true" size={15} /></Button></footer>
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
  const { t } = useI18n();
  const detailsId = useId();
  return (
    <section aria-label={t('collections.initialFieldLabel', { index: index + 1 })} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3.5" data-initial-field-row>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_auto] lg:items-end">
        <FormField htmlFor={`field-name-${field.key}`} label={t('collections.fieldName')}>
          <input aria-label={t('collections.fieldNameLabel', { index: index + 1 })} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `field-name-error-${field.key}` : undefined} autoComplete="off" id={`field-name-${field.key}`} onChange={(event) => onUpdate({ name: event.target.value })} onKeyDown={onEnter} placeholder={t('collections.fieldNamePlaceholder')} value={field.name} />
          {errors.name && <span className="text-[11px] font-semibold text-danger" id={`field-name-error-${field.key}`} role="alert">{errors.name}</span>}
        </FormField>
        <FormField htmlFor={`field-type-${field.key}`} label={t('collections.fieldType')}>
          <select id={`field-type-${field.key}`} onChange={(event) => onUpdate({ type: event.target.value as FieldType, ...(event.target.value === 'relation' ? {} : { targetCollectionId: '' }) })} value={field.type}>
            <option value="text">{t('schema.fieldTypes.text')}</option><option value="number">{t('schema.fieldTypes.number')}</option><option value="boolean">{t('schema.fieldTypes.boolean')}</option><option value="dateTime">{t('schema.fieldTypes.dateTime')}</option><option value="json">{t('schema.fieldTypes.json')}</option><option value="relation">{t('schema.fieldTypes.relation')}</option><option value="file">{t('schema.fieldTypes.file')}</option><option value="files">{t('schema.fieldTypes.files')}</option>
          </select>
        </FormField>
        <div className="flex flex-wrap items-center gap-4 pb-1 text-xs text-ink-secondary">
          <label className="inline-flex items-center gap-2"><input checked={field.required} onChange={(event) => onUpdate({ required: event.target.checked })} type="checkbox" />{t('collections.fieldRequired')}</label>
          <label className="inline-flex items-center gap-2"><input checked={field.unique} onChange={(event) => onUpdate({ unique: event.target.checked })} type="checkbox" />{t('collections.fieldUnique')}</label>
          {removable && <Button aria-label={t('collections.removeInitialField', { index: index + 1 })} onClick={onRemove} size="small" type="button" variant="quiet">{t('collections.remove')}</Button>}
        </div>
      </div>
      {field.type === 'relation' && (
        <div className="grid gap-3 rounded-md border bg-secondary p-3 sm:grid-cols-2">
          <FormField htmlFor={`field-target-${field.key}`} label={t('collections.targetCollection')}>
            <select id={`field-target-${field.key}`} aria-invalid={Boolean(errors.target)} onChange={(event) => onUpdate({ targetCollectionId: event.target.value })} value={field.targetCollectionId}>
              <option value="">{targetsLoading ? t('collections.loadingCollections') : t('collections.chooseCollection')}</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            </select>
            {errors.target && <span className="text-[11px] font-semibold text-danger" role="alert">{errors.target}</span>}
          </FormField>
          <FormField htmlFor={`field-cardinality-${field.key}`} label={t('collections.cardinality')}>
            <select id={`field-cardinality-${field.key}`} onChange={(event) => onUpdate({ cardinality: event.target.value })} value={field.cardinality}>
              <option value="many-to-one">{t('collections.manyToOne')}</option><option value="one-to-one">{t('collections.oneToOne')}</option><option value="one-to-many">{t('collections.oneToMany')}</option><option value="many-to-many">{t('collections.manyToMany')}</option>
            </select>
          </FormField>
        </div>
      )}
      <details className="rounded-md border bg-secondary px-3 py-2 text-xs [&[open]>summary]:mb-3" id={detailsId}>
        <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-ink-secondary"><ChevronDown aria-hidden="true" size={14} />{t('collections.advancedFieldSettings')}</summary>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField htmlFor={`field-description-${field.key}`} label={t('collections.fieldDescription')}>
            <input id={`field-description-${field.key}`} onChange={(event) => onUpdate({ description: event.target.value })} placeholder={t('collections.optional')} value={field.description} />
          </FormField>
          <FormField htmlFor={`field-default-${field.key}`} label={t('collections.defaultValue') + ' (JSON)'} hint={t('collections.defaultValueHint')}>
            <input aria-invalid={Boolean(errors.defaultValue)} id={`field-default-${field.key}`} onChange={(event) => onUpdate({ defaultValue: event.target.value })} placeholder={t('collections.optional')} value={field.defaultValue} />
            {errors.defaultValue && <span className="text-[11px] font-semibold text-danger" role="alert">{errors.defaultValue}</span>}
          </FormField>
          <FormField htmlFor={`field-validation-${field.key}`} label={t('collections.validationLabel') + ' (JSON)'} hint={t('collections.validationHint')}>
            <textarea aria-invalid={Boolean(errors.validation)} id={`field-validation-${field.key}`} onChange={(event) => onUpdate({ validation: event.target.value })} placeholder={t('collections.optional')} rows={2} value={field.validation} />
            {errors.validation && <span className="text-[11px] font-semibold text-danger" role="alert">{errors.validation}</span>}
          </FormField>
        </div>
      </details>
    </section>
  );
}

export function CollectionWorkspacePage() {
  const { collectionId = '' } = useParams();
  const location = useLocation();
  const { t, errorMessage, formatPlural } = useI18n();
  const { rememberCollection } = useCommandRegistry();
  // Shell 的 Changes 徽标与工作区共享同一个 pending 事实（spec §6.5）：
  // 工作区一旦拿到权威 PendingChange，就原地覆盖概览缓存。
  const { report: reportPendingChange } = usePendingChanges();
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
      : `/collections/${encodeURIComponent(collection.id)}/model`;
    return [{
      id: `change.open.${pending.changeSetId}`,
      category: 'commands.categories.changes',
      label: () => t(failed ? 'commands.failedChange' : 'commands.pendingChange', { name: collection.name }),
      keywords: () => ['pending', 'failed', 'change', 'schema', collection.name],
      requiresCapabilities: ['admin:owner-session'],
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
      reportPendingChange(value);
      return value;
    } catch (error) { setPendingError(error); throw error; }
    finally { setLoadingPending(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoadingCollection(true);
    setLoadingPending(true);
    void getCollection(collectionId, controller.signal).then((value) => { if (!controller.signal.aborted) { setCollection(value); setCollectionError(undefined); } }).catch((error: unknown) => { if (!controller.signal.aborted) setCollectionError(error); }).finally(() => { if (!controller.signal.aborted) setLoadingCollection(false); });
    void getPendingChange(collectionId, controller.signal).then((value) => { if (!controller.signal.aborted) { setPending(value); setPendingError(undefined); reportPendingChange(value); } }).catch((error: unknown) => { if (!controller.signal.aborted) setPendingError(error); }).finally(() => { if (!controller.signal.aborted) setLoadingPending(false); });
    return () => controller.abort();
  }, [collectionId, reportPendingChange]);

  if (loadingCollection) return <div className="flex min-w-0 flex-col gap-6" data-collection-workspace><LoadingState label={t('collections.loadingWorkspace')} /></div>;
  if (collectionError || !collection) {
    const copy = apiErrorCopy(collectionError, t('collections.workspaceLoadFailed'), t, errorMessage);
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <ErrorState description={copy.message} title={copy.title}>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button onClick={() => void refreshCollection()} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('collections.retry')}</Button>
            <Link className="text-xs font-semibold text-primary hover:underline" to="/collections">{t('collections.backToCollections')}</Link>
          </div>
        </ErrorState>
      </div>
    );
  }

  const context: CollectionWorkspaceContext = { collection, pendingChange: pending, refreshCollection, refreshPendingChange };
  const pendingOperationCount = pending?.operations.length ?? 0;
  const pendingTone = pending?.status === 'failed' ? 'danger' : pending?.status === 'needsReview' ? 'warning' : 'default';
  const tabs = [
    { label: t('navigation.records'), to: `/collections/${collectionId}`, end: true },
    { label: t('navigation.model'), to: `/collections/${collectionId}/model`, end: false },
    { label: t('navigation.access'), to: `/collections/${collectionId}/access`, end: false },
    { label: t('navigation.api'), to: `/collections/${collectionId}/api`, end: false },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-6" data-collection-workspace>
      {/* Spec 0001 §6.3：标题区持续提供 Collection 名称、类型、状态与返回路径。 */}
      <nav aria-label={t('collections.breadcrumbLabel')} className="flex flex-wrap items-center gap-2 text-xs">
        <Link className="font-medium text-muted-foreground transition-colors hover:text-foreground" to="/collections">{t('navigation.collections')}</Link>
        <span aria-hidden="true" className="text-subtle-foreground">/</span>
        <span className="font-semibold text-foreground">{collection.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4" data-collection-header>
        <div className="flex min-w-0 items-start gap-3" data-collection-identity>
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-ink-secondary"><Database size={20} /></span>
          <div className="min-w-0" data-collection-title>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-foreground">{collection.name}</h1>
              <Badge variant={collection.type === 'Auth' ? 'primary' : 'outline'}>{collectionTypeName(collection.type, t)}</Badge>
              {pendingOperationCount > 0 && (
                <Badge variant={pendingTone}>{formatPlural(pendingOperationCount, { one: t('shell.pendingChangeOne'), other: t('shell.pendingChangeMany') })}</Badge>
              )}
            </div>
            <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{collection.description || t('collections.workspaceDescription')}</p>
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{t('collections.workspaceMeta', { version: collection.schemaVersion ?? 1, count: collection.fields.length })}</span>
      </header>

      {newlyCreated && (
        <div className="flex items-start gap-3 rounded-lg border bg-secondary px-3.5 py-3 text-xs text-ink-secondary" role="status">
          <Check aria-hidden="true" className="mt-0.5 shrink-0 text-success" size={16} />
          <div className="min-w-0 flex-1">
            <strong className="block text-foreground">{t('collections.readyNoticeTitle')}</strong>
            <span className="text-muted-foreground">{t('collections.readyNoticeDescription')}</span>
          </div>
          <Button aria-label={t('collections.dismissReadyNotice')} onClick={() => setNewlyCreated(false)} size="small" type="button" variant="quiet">{t('common.dismissMessage')}</Button>
        </div>
      )}

      {!loadingPending && pendingError !== undefined && (
        <ErrorState description={apiErrorCopy(pendingError, t('collections.pendingStatusUnavailable'), t, errorMessage).message} title={t('collections.pendingChangeLoadFailed')}>
          <div className="mt-3"><Button onClick={() => void refreshPendingChange()} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('collections.retry')}</Button></div>
        </ErrorState>
      )}

      {!loadingPending && pending?.status === 'failed' && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-3 text-xs text-danger" role="status">
          <CircleAlert aria-hidden="true" className="shrink-0" size={17} />
          <div className="min-w-0 flex-1">
            <strong className="block">{t('collections.recoveryTitle')}</strong>
            <span className="opacity-90">{t('collections.recoveryDescription')}</span>
          </div>
          <Link className="inline-flex items-center gap-1 font-semibold hover:underline" to={`/changes?changeSet=${encodeURIComponent(pending.changeSetId)}`}>{t('collections.viewRecoveryDetails')} <ArrowRight aria-hidden="true" size={14} /></Link>
        </div>
      )}

      <nav aria-label={t('navigation.collectionWorkspace')} className="flex gap-1 overflow-x-auto border-b" data-collection-tabs>
        {tabs.map((tab) => (
          <NavLink
            className={({ isActive }) => `-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            end={tab.end}
            key={tab.to}
            to={tab.to}
          >{tab.label}</NavLink>
        ))}
      </nav>
      <Outlet context={context} />
    </div>
  );
}

export { CollectionSchemaPage } from './schema';
