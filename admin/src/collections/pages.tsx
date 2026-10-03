import { TabContent } from '../components/tab-content';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button as ControlButton } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { SelectField } from '@/components/ui/select-field';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Settings2, Trash2, CircleAlert, Database, LayoutGrid, List, Plus, RefreshCw, Shield } from 'lucide-react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Badge } from '@/components/ui/badge';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button, ButtonLink } from '../components/button';
import { FormField } from '../components/form-field';
import { Dialog } from '../components/overlays';
import { EmptyState, ErrorState, LoadingState, SpinnerLoadingState } from '../components/states';
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
  // 默认使用卡片；显式选择列表时将视图保存在 URL 中。
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
    <div className="flex min-w-0 flex-col gap-6">
      <header className="sr-only">
        <div className="sr-only">
          <p className="eyebrow">{t('collections.eyebrow')}</p>
          <h1>{t('collections.title')}</h1>
          <p className="mt-2.5 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('collections.description')}</p>
        </div>

      </header>

      <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-3 border-b pb-2" data-workspace-toolbar>
        <SearchInput aria-label={t('collections.search')} onChange={(event) => updateQuery('q', event.target.value)} placeholder={t('collections.searchPlaceholder')} value={search} className="min-w-[180px] flex-1 md:max-w-sm" />
        <Select items={typeItems} onValueChange={(value) => updateQuery('type', String(value) === 'all' ? '' : String(value))} value={type}>
          <SelectTrigger aria-label={t('collections.type')} className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('collections.allTypes')}</SelectItem>
            <SelectItem value="Normal">{t('collections.normal')}</SelectItem>
            <SelectItem value="Auth">{t('collections.auth')}</SelectItem>
          </SelectContent>
        </Select>
        <Select items={sortItems} onValueChange={(value) => updateQuery('sort', String(value))} value={sort}>
          <SelectTrigger aria-label={t('collections.sortLabel')} className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">{t('collections.recentlyCreated')}</SelectItem>
            <SelectItem value="name">{t('collections.name')}</SelectItem>
          </SelectContent>
        </Select>
        <div aria-label={t('collections.viewLabel')} className="ml-auto flex overflow-hidden rounded-lg border border-input" role="group">
          {(['list', 'card'] as const).map((option) => (
            <ControlButton variant="unstyled"
              aria-pressed={view === option}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-none ${view === option ? 'bg-primary text-primary-foreground' : 'bg-card text-ink-secondary hover:bg-accent hover:text-accent-foreground'}`}
              key={option}
              onClick={() => updateQuery('view', option === 'card' ? '' : 'list')}
              type="button"
            >
              {option === 'list' ? <List aria-hidden="true" size={14} /> : <LayoutGrid aria-hidden="true" size={14} />}
              {t(option === 'list' ? 'collections.viewList' : 'collections.viewCards')}
            </ControlButton>
          ))}
        </div>
        <ButtonLink className="ml-auto" to="/collections/new" variant="primary"><Plus aria-hidden="true" size={16} />{t('collections.create')}</ButtonLink>
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
    <Link className="group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors " to={`/collections/${encodeURIComponent(collection.id)}`}>
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
  const [fields, setFields] = useState<FieldDraft[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, FieldErrors>>({});
  const [nameError, setNameError] = useState('');
  const [authentication, setAuthentication] = useState<AuthenticationConfiguration>(authDefaults);
  const [targets, setTargets] = useState<Collection[]>([]);
  const [targetsError, setTargetsError] = useState(false);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState<unknown>();
  const nextFieldNumber = useRef(1);
  const [omittedSystemFields, setOmittedSystemFields] = useState<Array<'createdAt' | 'updatedAt'>>([]);

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
    if (!event.currentTarget.value.trim() || event.nativeEvent.isComposing) return;
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
        ...(omittedSystemFields.length ? { omitSystemFields: omittedSystemFields } : {}),
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

      <header className="sr-only">
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
            <RadioGroup aria-label={t('collections.type')} className="grid gap-3 sm:grid-cols-2" name="collection-type" value={type} onValueChange={setType}>
              {(['Normal', 'Auth'] as const).map((option) => {
                const selected = type === option;
                return (
                  <Label
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors ${selected ? 'border-primary bg-accent' : 'border-input bg-card '}`}
                    key={option}
                  >
                    <RadioGroupItem aria-label={t(option === 'Normal' ? 'collections.typeNormal' : 'collections.typeAuth')} className="mt-0.5" value={option} />
                    <span className="min-w-0">
                      <strong className="block text-xs font-semibold text-foreground">{t(option === 'Normal' ? 'collections.typeNormal' : 'collections.typeAuth')}</strong>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{t(option === 'Normal' ? 'collections.typeNormalDescription' : 'collections.typeAuthDescription')}</span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField htmlFor="collection-name" label={t('collections.nameLabel')} hint={t('collections.nameHint')}>
              <Input aria-invalid={Boolean(nameError)} aria-describedby={nameError ? 'collection-name-error' : undefined} autoComplete="off" id="collection-name" onChange={(event) => { setName(event.target.value); setNameError(''); setRequestError(undefined); }} value={name} />
            </FormField>
            {nameError && <p className="m-0 self-start text-[11px] font-semibold text-danger" id="collection-name-error" role="alert">{nameError}</p>}
            <FormField htmlFor="collection-description" label={t('collections.descriptionLabel')} hint={t('collections.descriptionHint')}>
              <Textarea id="collection-description" onChange={(event) => setDescription(event.target.value)} rows={2} value={description} />
            </FormField>
          </div>
        </Surface>



        <Surface className="flex min-w-0 flex-col gap-4 p-5" data-collection-field-editor variant="standard">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2>{t('collections.fieldsEditorTitle')}</h2>
            <Badge variant="outline">{collectionCount(SYSTEM_FIELDS.length - omittedSystemFields.length + fields.length + (type === 'Auth' ? 1 : 0), 'field', t)}</Badge>
          </div>
          {targetsError && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning" role="status">
              <CircleAlert aria-hidden="true" size={15} />
              <span className="min-w-0 flex-1">{t('collections.targetsUnavailable')}</span>
              <Button onClick={() => { setTargetsLoading(true); setTargetsError(false); void listAllCollections().then(setTargets).catch(() => setTargetsError(true)).finally(() => setTargetsLoading(false)); }} size="small" type="button">{t('collections.retry')}</Button>
            </div>
          )}
          <div className="min-w-0 overflow-hidden rounded-lg border bg-card" data-field-list>
            <h3 className="sr-only">{t('collections.systemTitle')}</h3>
            <div className="hidden gap-3 bg-muted/40 px-3.5 py-2.5 text-[11px] font-semibold text-muted-foreground lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_160px_76px]" aria-hidden="true">
              <span>{t('collections.fieldName')}</span><span>{t('collections.fieldType')}</span><span>{t('collections.systemAccess')}</span><span />
            </div>
            <div className="divide-y">
              <LockedFieldRow name="id" type="text" />
              {fields.map((field, index) => <FieldEditorRow
                errors={fieldErrors[field.key] ?? {}}
                field={field}
                index={index}
                key={field.key}
                onEnter={handleFieldEnter}
                onRemove={() => setFields((current) => current.filter((item) => item.key !== field.key))}
                onUpdate={(patch) => updateField(field.key, patch)}
                removable
                targets={targets}
                targetsLoading={targetsLoading}
              />)}
              {type === 'Auth' && <LockedFieldRow name="email" type="text" authIdentifier />}
              {(['createdAt', 'updatedAt'] as const).filter((name) => !omittedSystemFields.includes(name)).map((name) => <LockedFieldRow key={name} name={name} type="dateTime" onRemove={() => { setOmittedSystemFields((current) => [...current, name]); setRequestError(undefined); }} />)}
              <div className="p-2"><Button className="w-full justify-center" onClick={addField} size="small" type="button"><Plus aria-hidden="true" size={14} />{t('collections.newField')}</Button></div>
            </div>
          </div>
        </Surface>

        {type === 'Auth' && (
          <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
            <div><p className="eyebrow">{t('collections.authEyebrow')}</p><h2>{t('collections.authTitle')}</h2><p className="mt-1 text-[11px] text-muted-foreground">{t('collections.authDescription')}</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Label className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5">
                <span className="min-w-0">
                  <strong className="block text-xs font-semibold text-foreground">{t('collections.emailPassword')}</strong>
                  <small className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{t('collections.emailPasswordHint')}</small>
                </span>
                <span className="inline-flex shrink-0 items-center gap-2 text-[11px] text-ink-secondary">
                  <Checkbox checked={authentication.emailPasswordEnabled} onCheckedChange={(checked) => setAuthentication((value) => ({ ...value, emailPasswordEnabled: checked }))} />
                  {t('collections.enabled')}
                </span>
              </Label>
              <Label className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5">
                <span className="min-w-0">
                  <strong className="block text-xs font-semibold text-foreground">{t('collections.selfRegistration')}</strong>
                  <small className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{t('collections.selfRegistrationHint')}</small>
                </span>
                <Checkbox aria-label={t('collections.selfRegistration')} checked={authentication.selfRegistration} className="mt-0.5 shrink-0" onCheckedChange={(checked) => setAuthentication((value) => ({ ...value, selfRegistration: checked }))} />
              </Label>
              <FormField htmlFor="session-duration" label={t('collections.sessionDuration')} hint={t('collections.sessionDurationHint')}>
                <Input id="session-duration" min={1} onChange={(event) => setAuthentication((value) => ({ ...value, sessionDurationDays: Number(event.target.value) }))} type="number" value={authentication.sessionDurationDays} />
              </FormField>
            </div>
          </Surface>
        )}



        <footer className="flex flex-wrap justify-end gap-2"><ButtonLink to="/collections">{t('collections.cancel')}</ButtonLink><Button disabled={submitting} type="submit" variant="primary">{submitting ? t('collections.creating') : t('collections.create')}<ArrowRight aria-hidden="true" size={15} /></Button></footer>
      </form>
    </main>
  );
}

function LockedFieldRow({ name, type, authIdentifier = false, onRemove }: { name: string; type: 'text' | 'dateTime'; authIdentifier?: boolean; onRemove?: () => void }) {
  const { t } = useI18n();
  return <div className="grid min-w-0 gap-3 px-3.5 py-3 text-xs lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_160px_76px] lg:items-center" data-locked-field-row>
    <strong className="font-mono font-semibold text-foreground">{name}</strong>
    <span className="text-muted-foreground">{t(type === 'text' ? 'schema.fieldTypes.text' : 'schema.fieldTypes.dateTime')}</span>
    <Badge className="w-fit" variant="outline"><Shield aria-hidden="true" size={13} />{t(authIdentifier ? 'collections.requiredUnique' : onRemove ? 'collections.systemManaged' : 'collections.systemLocked')}</Badge>
    <div className="flex justify-end">{onRemove && <Button aria-label={t('collections.removeSystemField', { name })} onClick={onRemove} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={15} /></Button>}</div>
  </div>;
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (errors.defaultValue || errors.validation || errors.target) setAdvancedOpen(true);
  }, [errors.defaultValue, errors.validation, errors.target]);
  return (
    <section aria-label={t('collections.initialFieldLabel', { index: index + 1 })} className="flex min-w-0 flex-col gap-3 p-3.5" data-initial-field-row>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_160px_76px] lg:items-center lg:[&_[data-slot=form-field]>label]:sr-only">
        <FormField htmlFor={`field-name-${field.key}`} label={t('collections.fieldName')}>
          <Input aria-label={t('collections.fieldNameLabel', { index: index + 1 })} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `field-name-error-${field.key}` : undefined} autoComplete="off" id={`field-name-${field.key}`} onChange={(event) => onUpdate({ name: event.target.value })} onKeyDown={onEnter} placeholder={t('collections.fieldNamePlaceholder')} value={field.name} />
          {errors.name && <span className="text-[11px] font-semibold text-danger" id={`field-name-error-${field.key}`} role="alert">{errors.name}</span>}
        </FormField>
        <FormField htmlFor={`field-type-${field.key}`} label={t('collections.fieldType')}>
          <SelectField id={`field-type-${field.key}`} onValueChange={(selectedValue) => { onUpdate({ type: selectedValue as FieldType, ...(selectedValue === 'relation' ? {} : { targetCollectionId: '' }) }); if (selectedValue === 'relation') setAdvancedOpen(true); }} value={field.type} options={[({ value: "text", label: t('schema.fieldTypes.text') }), ({ value: "number", label: t('schema.fieldTypes.number') }), ({ value: "boolean", label: t('schema.fieldTypes.boolean') }), ({ value: "dateTime", label: t('schema.fieldTypes.dateTime') }), ({ value: "json", label: t('schema.fieldTypes.json') }), ({ value: "relation", label: t('schema.fieldTypes.relation') }), ({ value: "file", label: t('schema.fieldTypes.file') }), ({ value: "files", label: t('schema.fieldTypes.files') })]} />
        </FormField>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
          <Label className="inline-flex items-center gap-2"><Checkbox checked={field.required} onCheckedChange={(checked) => onUpdate({ required: checked })} />{t('collections.fieldRequired')}</Label>
          <Label className="inline-flex items-center gap-2"><Checkbox checked={field.unique} onCheckedChange={(checked) => onUpdate({ unique: checked })} />{t('collections.fieldUnique')}</Label>
        </div>
        <div className="flex items-center justify-end gap-1">
          <Button aria-label={t('collections.advancedFieldSettingsFor', { name: field.name || String(index + 1) })} aria-haspopup="dialog" title={t('collections.advancedFieldSettings')} onClick={() => setAdvancedOpen(true)} size="small" type="button" variant="quiet"><Settings2 aria-hidden="true" size={15} /></Button>
          {removable && <Button aria-label={t('collections.removeInitialField', { index: index + 1 })} onClick={onRemove} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={15} /></Button>}
        </div>
      </div>
      <Dialog open={advancedOpen} title={t('collections.advancedFieldSettingsFor', { name: field.name || String(index + 1) })} closeLabel={t('common.closeDialog')} onClose={() => setAdvancedOpen(false)}>
        <div className="flex flex-col gap-4">
          {field.type === 'relation' && (
            <div className="grid gap-3 rounded-md border bg-secondary p-3 sm:grid-cols-2">
              <FormField htmlFor={`field-target-${field.key}`} label={t('collections.targetCollection')}>
                <SelectField id={`field-target-${field.key}`} aria-invalid={Boolean(errors.target)} onValueChange={(selectedValue) => onUpdate({ targetCollectionId: selectedValue })} value={field.targetCollectionId} options={[({ value: "", label: targetsLoading ? t('collections.loadingCollections') : t('collections.chooseCollection') }), targets.map((target) => ({ value: target.id, label: target.name }))]} />
                {errors.target && <span className="text-[11px] font-semibold text-danger" role="alert">{errors.target}</span>}
              </FormField>
              <FormField htmlFor={`field-cardinality-${field.key}`} label={t('collections.cardinality')}>
                <SelectField id={`field-cardinality-${field.key}`} onValueChange={(selectedValue) => onUpdate({ cardinality: selectedValue })} value={field.cardinality} options={[({ value: "many-to-one", label: t('collections.manyToOne') }), ({ value: "one-to-one", label: t('collections.oneToOne') }), ({ value: "one-to-many", label: t('collections.oneToMany') }), ({ value: "many-to-many", label: t('collections.manyToMany') })]} />
              </FormField>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField htmlFor={`field-description-${field.key}`} label={t('collections.fieldDescription')}>
              <Input id={`field-description-${field.key}`} onChange={(event) => onUpdate({ description: event.target.value })} placeholder={t('collections.optional')} value={field.description} />
            </FormField>
            <FormField htmlFor={`field-default-${field.key}`} label={t('collections.defaultValue') + ' (JSON)'} hint={t('collections.defaultValueHint')}>
              <Input aria-invalid={Boolean(errors.defaultValue)} id={`field-default-${field.key}`} onChange={(event) => onUpdate({ defaultValue: event.target.value })} placeholder={t('collections.optional')} value={field.defaultValue} />
              {errors.defaultValue && <span className="text-[11px] font-semibold text-danger" role="alert">{errors.defaultValue}</span>}
            </FormField>
            <FormField htmlFor={`field-validation-${field.key}`} label={t('collections.validationLabel') + ' (JSON)'} hint={t('collections.validationHint')}>
              <Textarea aria-invalid={Boolean(errors.validation)} id={`field-validation-${field.key}`} onChange={(event) => onUpdate({ validation: event.target.value })} placeholder={t('collections.optional')} rows={2} value={field.validation} />
              {errors.validation && <span className="text-[11px] font-semibold text-danger" role="alert">{errors.validation}</span>}
            </FormField>
          </div>
        <div className="flex justify-end"><Button onClick={() => setAdvancedOpen(false)} type="button">{t('collections.doneFieldSettings')}</Button></div>
        </div>
      </Dialog>
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
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState('');
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
    const collectionRequest = getCollection(collectionId, controller.signal).then((value) => { if (!controller.signal.aborted) { setCollection(value); setCollectionError(undefined); } }).catch((error: unknown) => { if (!controller.signal.aborted) setCollectionError(error); }).finally(() => { if (!controller.signal.aborted) setLoadingCollection(false); });
    const pendingRequest = getPendingChange(collectionId, controller.signal).then((value) => { if (!controller.signal.aborted) { setPending(value); setPendingError(undefined); reportPendingChange(value); } }).catch((error: unknown) => { if (!controller.signal.aborted) setPendingError(error); }).finally(() => { if (!controller.signal.aborted) setLoadingPending(false); });
    // 集合与待应用变更一起就绪，避免元信息先显示、状态随后跳动。
    void Promise.all([collectionRequest, pendingRequest]).then(() => {
      if (!controller.signal.aborted) setLoadedWorkspaceId(collectionId);
    });
    return () => controller.abort();
  }, [collectionId, reportPendingChange]);

  if (loadingCollection || loadedWorkspaceId !== collectionId) return <div className="flex min-w-0 flex-col gap-6" data-collection-workspace><SpinnerLoadingState label={t('collections.loadingWorkspace')} /></div>;
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
      <nav aria-label={t('collections.breadcrumbLabel')} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <Link className="font-medium text-muted-foreground transition-colors hover:text-foreground" to="/collections">{t('navigation.collections')}</Link>
        <span aria-hidden="true" className="text-subtle-foreground">/</span>
        {/* 集合名可能是不含断点的长标识符：允许任意位置换行，避免窄屏横向溢出（spec 0001 §16.1）。 */}
        <span className="min-w-0 font-semibold text-foreground [overflow-wrap:anywhere]">{collection.name}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-4" data-collection-header>
        <div className="flex min-w-0 items-start gap-3" data-collection-identity>
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-ink-secondary"><Database size={20} /></span>
          <div className="min-w-0" data-collection-title>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="sr-only">{collection.name}</h1>
              <Badge variant={collection.type === 'Auth' ? 'primary' : 'outline'}>{collectionTypeName(collection.type, t)}</Badge>
              {pendingOperationCount > 0 && (
                <Badge variant={pendingTone}>{formatPlural(pendingOperationCount, { one: t('shell.pendingChangeOne'), other: t('shell.pendingChangeMany') })}</Badge>
              )}
            </div>
            <p className="sr-only">{collection.description || t('collections.workspaceDescription')}</p>
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

      <nav aria-label={t('navigation.collectionWorkspace')} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b" data-collection-tabs>
        {tabs.map((tab) => (
          <NavLink
            className={({ isActive }) => `whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            end={tab.end}
            key={tab.to}
            to={tab.to}
          >{tab.label}</NavLink>
        ))}
      </nav>
      <TabContent activeKey={location.pathname}><Outlet context={context} /></TabContent>
    </div>
  );
}

export { CollectionSchemaPage } from './schema';
