import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Download, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button, Dialog, EmptyState, ErrorState, FormField, LoadingState, Sheet, Surface } from '../components/ui';
import {
  createRecord,
  createApplicationUser,
  deleteRecord,
  downloadRecordFile,
  downloadRecordFileAt,
  getRecord,
  listRecords,
  updateRecord,
  uploadCollectionFile,
  type Collection,
  type CollectionRecord,
  type FieldDefinition,
  type FieldType,
  type Page,
  type RecordListOptions,
  type UploadedCollectionFile,
} from './client';
import { useCollectionWorkspace } from './workspace-context';

type Violation = { path?: string; message?: string; code?: string };
type FilterDraft = { field: string; operator: string; value: string };

// 工具栏内的筛选/排序控件共享同一套紧凑外观，直接对齐 FormField 中的原生 select/input 视觉。
const toolbarControlClass = 'min-h-8 rounded-lg border border-input bg-card px-2.5 text-xs text-ink-secondary outline-none transition-[color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-55';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCopy(
  error: unknown,
  fallback: string,
  translate: ReturnType<typeof useI18n>['t'],
  errorMessage: ReturnType<typeof useI18n>['errorMessage'],
  validationMessage: ReturnType<typeof useI18n>['validationMessage'],
) {
  if (error instanceof ApiClientError) {
    const violations = Array.isArray(error.apiError.details.violations)
      ? error.apiError.details.violations.filter(isRecord).map((item) => ({
        path: String(item.path ?? ''),
        message: (typeof item.code === 'string' ? validationMessage(item.code) : undefined) ?? translate('records.reviewThisValue'),
      }))
      : [];
    return {
      title: errorMessage(error.apiError.code) ?? translate('errors.requestFailed'),
      message: [translate('common.errorCode'), error.apiError.code, `${translate('common.requestId')}: ${error.apiError.requestId}`, translate('common.tryAgainWhenAvailable')].join(' · '),
      violations,
    };
  }
  return { title: fallback, message: translate('common.tryAgainWhenAvailable'), violations: [] as Violation[] };
}

function scalarFields(fields: FieldDefinition[]) {
  return fields.filter((field) => !field.system && ['text', 'number', 'boolean', 'dateTime', 'relation'].includes(field.type));
}

function formatValue(value: unknown, translate: ReturnType<typeof useI18n>['t']) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? translate('common.yes') : translate('common.no');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseFilter(raw: string): FilterDraft {
  const match = raw.match(/^([^\s]+)\s+(eq|ne|gt|gte|lt|lte|contains)\s+([\s\S]+)$/);
  if (!match) return { field: '', operator: 'eq', value: '' };
  let value = match[3] ?? '';
  try {
    const parsed: unknown = JSON.parse(value);
    value = typeof parsed === 'string' ? parsed : String(parsed);
  } catch { /* 保留不完整 URL 值，便于用户修正筛选条件。 */ }
  return { field: match[1] ?? '', operator: match[2] ?? 'eq', value };
}

function filterSyntax(draft: FilterDraft, field: FieldDefinition | undefined) {
  if (!field || !draft.value.trim()) return '';
  let value: unknown = draft.value;
  if (field.type === 'number') {
    const number = Number(draft.value);
    if (!Number.isFinite(number)) return '';
    value = number;
  } else if (field.type === 'boolean') {
    if (draft.value !== 'true' && draft.value !== 'false') return '';
    value = draft.value === 'true';
  }
  return `${field.name} ${draft.operator} ${JSON.stringify(value)}`;
}

function displayDate(value: unknown, formatDate: ReturnType<typeof useI18n>['formatDate']) {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : formatDate(date);
}

function pageCursor(searchParams: URLSearchParams) {
  return searchParams.get('cursor') ?? '';
}

function cursorHistory(searchParams: URLSearchParams) {
  try {
    const value: unknown = JSON.parse(searchParams.get('cursorStack') ?? '[]');
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value as string[] : [];
  } catch { return []; }
}
function RecordPageTitle({ collection, onCreate }: { collection: Collection; onCreate: () => void }) {
  const { t } = useI18n();
  return (
    <header className="flex flex-wrap items-end justify-between gap-4" data-record-heading>
      <div className="min-w-0">
        <p className="eyebrow">{collection.name} · {t('records.dataEyebrow')}</p>
        <h1>{t('records.title')}</h1>
        <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('records.description', { name: collection.name })}</p>
      </div>
      <Button onClick={onCreate} variant="primary"><Plus aria-hidden="true" size={15} />{t(collection.type === 'Auth' ? 'records.createUser' : 'records.createRecord')}</Button>
    </header>
  );
}

export function CollectionRecordsPage() {
  const { t, formatDate, errorMessage, validationMessage } = useI18n();
  const { collection } = useCollectionWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState<Page<CollectionRecord>>({ data: [] });
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [message, setMessage] = useState<TranslationKey | ''>('');
  const [selectedRecord, setSelectedRecord] = useState<CollectionRecord>();
  const [rowDeleteTarget, setRowDeleteTarget] = useState<CollectionRecord>();
  const [rowDeleteError, setRowDeleteError] = useState<unknown>();
  const [rowDeleting, setRowDeleting] = useState(false);
  const [recordState, setRecordState] = useState<'loading' | 'ready' | 'error'>('ready');
  const [recordError, setRecordError] = useState<unknown>();
  const search = searchParams.get('search') ?? '';
  const filter = searchParams.get('filter') ?? '';
  const sort = searchParams.get('sort') ?? 'createdAt desc';
  const rawColumns = searchParams.get('columns');
  const fields = collection.fields.filter((field) => !field.system);
  const expandFields = fields.filter((field) => field.type === 'relation').slice(0, 10).map((field) => field.name);
  const visibleColumns = useMemo(() => {
    if (rawColumns !== null) return rawColumns.split(',').filter((name) => name === 'id' || name === 'createdAt' || name === 'updatedAt' || fields.some((field) => field.name === name));
    return ['id', ...fields.slice(0, 2).map((field) => field.name), 'updatedAt'];
  }, [fields, rawColumns]);
  const selectedId = searchParams.get('record') ?? '';
  const isCreating = searchParams.get('new') === '1';
  const isEditing = collection.type !== 'Auth' && searchParams.get('edit') === '1';
  const activeRecord = isCreating ? undefined : selectedRecord;
  const parsedFilter = parseFilter(filter);
  const filterDraft = parsedFilter.field ? parsedFilter : {
    field: searchParams.get('filterField') ?? '',
    operator: searchParams.get('filterOperator') ?? 'eq',
    value: searchParams.get('filterValue') ?? '',
  };
  const availableFilterFields = scalarFields(fields);
  const currentSortField = sort.split(/[\s,]+/)[0] || 'createdAt';
  const currentSortDirection = sort.split(/[\s,]+/)[1] === 'asc' ? 'asc' : 'desc';
  const history = cursorHistory(searchParams);
  const cursor = pageCursor(searchParams);

  useEffect(() => {
    const controller = new AbortController();
    const options: RecordListOptions = { limit: 25, search, filter, sort, cursor };
    setState('loading');
    setError(undefined);
    void listRecords(collection.id, options, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPage(result);
      setState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setState('error');
    });
    return () => controller.abort();
  }, [collection.id, search, filter, sort, cursor, reloadKey]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedRecord(undefined);
      setRecordState('ready');
      setRecordError(undefined);
      return;
    }
    const controller = new AbortController();
    setRecordState('loading');
    setRecordError(undefined);
    void getRecord(collection.id, selectedId, controller.signal, expandFields).then((record) => {
      if (controller.signal.aborted) return;
      setSelectedRecord(record);
      setRecordState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setRecordError(reason);
      setRecordState('error');
    });
    return () => controller.abort();
  }, [collection.id, selectedId, expandFields.join(',')]);

  function updateParams(patch: Record<string, string | undefined>, resetPaging = false) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (resetPaging) {
      next.delete('cursor');
      next.delete('cursorStack');
    }
    setSearchParams(next, { replace: true });
  }

  function openCreate() {
    const next = new URLSearchParams(searchParams);
    next.delete('record');
    next.delete('edit');
    next.set('new', '1');
    setSearchParams(next);
  }

  function openRecord(recordId: string, edit = false) {
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    next.set('record', recordId);
    if (edit) next.set('edit', '1');
    else next.delete('edit');
    setSearchParams(next);
  }

  function closeSheet() {
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    next.delete('record');
    next.delete('edit');
    setSearchParams(next);
  }

  function toggleColumn(name: string, checked: boolean) {
    const next = checked ? [...new Set([...visibleColumns, name])] : visibleColumns.filter((column) => column !== name);
    updateParams({ columns: next.join(',') });
  }

  function nextPage() {
    if (!page.nextCursor) return;
    const next = new URLSearchParams(searchParams);
    next.set('cursorStack', JSON.stringify([...history, cursor]));
    next.set('cursor', page.nextCursor);
    setSearchParams(next);
  }

  function previousPage() {
    if (!history.length) return;
    const next = new URLSearchParams(searchParams);
    const prior = history.at(-1) ?? '';
    const remaining = history.slice(0, -1);
    next.set('cursorStack', JSON.stringify(remaining));
    if (prior) next.set('cursor', prior);
    else next.delete('cursor');
    setSearchParams(next);
  }

  function onRecordSaved(record: CollectionRecord) {
    setSelectedRecord(record);
    setMessage('records.saved');
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    next.delete('edit');
    next.set('record', record.id);
    setSearchParams(next);
    setReloadKey((value) => value + 1);
  }

  function onRecordDeleted() {
    closeSheet();
    setSelectedRecord(undefined);
    setMessage('records.deleted');
    setReloadKey((value) => value + 1);
  }

  async function confirmRowDelete() {
    if (!rowDeleteTarget) return;
    setRowDeleting(true);
    setRowDeleteError(undefined);
    try {
      await deleteRecord(collection.id, rowDeleteTarget.id);
      setRowDeleteTarget(undefined);
      onRecordDeleted();
    } catch (reason) {
      setRowDeleteError(reason);
    } finally {
      setRowDeleting(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-6" data-record-page>
      <RecordPageTitle collection={collection} onCreate={openCreate} />
      {message && <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success" role="status"><span className="min-w-0 flex-1">{t(message)}</span><Button aria-label={t('records.dismissMessage')} className="size-8 px-0" onClick={() => setMessage('')} size="small" type="button" variant="quiet"><X aria-hidden="true" size={14} /></Button></div>}
      <Surface className="flex flex-wrap items-center gap-3 p-3" variant="standard">
        <label className="relative flex min-w-[200px] flex-1 items-center md:max-w-sm">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 text-muted-foreground" size={15} />
          <span className="sr-only">{t('records.search')}</span>
          <Input aria-label={t('records.search')} className="pl-9" onChange={(event) => updateParams({ search: event.target.value || undefined }, true)} placeholder={t('records.searchPlaceholder')} type="search" value={search} />
        </label>
        <label className="inline-flex min-h-8 items-center gap-2 text-[11px] font-semibold text-muted-foreground"><SlidersHorizontal aria-hidden="true" size={14} /><span>{t('records.filter')}</span>
          <select aria-label={t('records.filterField')} className={toolbarControlClass} onChange={(event) => updateParams({ filterField: event.target.value || undefined, filterOperator: 'eq', filterValue: undefined, filter: undefined }, true)} value={filterDraft.field}>
            <option value="">{t('records.noFilter')}</option>{availableFilterFields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
          </select>
        </label>
        {filterDraft.field && <>
          <label className="inline-flex min-h-8 items-center gap-2 text-[11px] font-semibold text-muted-foreground"><span className="sr-only">{t('records.filterOperator')}</span>
            <select aria-label={t('records.filterOperator')} className={toolbarControlClass} onChange={(event) => {
              const draft = { ...filterDraft, operator: event.target.value };
              updateParams({ filterOperator: draft.operator, filter: filterSyntax(draft, availableFilterFields.find((field) => field.name === draft.field)) || undefined }, true);
            }} value={filterDraft.operator}>
              {(filterDraft.field && availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'text'
                ? ['eq', 'ne', 'contains']
                : availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'number' || availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'dateTime'
                  ? ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'ne']).map((operator) => <option key={operator} value={operator}>{operator}</option>)}
            </select>
          </label>
          <label className="inline-flex min-h-8 items-center gap-2 text-[11px] font-semibold text-muted-foreground"><span className="sr-only">{t('records.filterValue')}</span>
            {availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'boolean'
              ? <select aria-label={t('records.filterValue')} className={toolbarControlClass} onChange={(event) => {
                const value = event.target.value;
                const draft = { ...filterDraft, value };
                updateParams({ filterValue: value, filter: filterSyntax(draft, availableFilterFields.find((field) => field.name === draft.field)) || undefined }, true);
              }} value={filterDraft.value || 'true'}><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>
              : <input aria-label={t('records.filterValue')} className={`${toolbarControlClass} w-[118px]`} onChange={(event) => {
                const field = availableFilterFields.find((item) => item.name === filterDraft.field);
                const draft = { ...filterDraft, value: event.target.value };
                const syntax = filterSyntax(draft, field);
                updateParams({ filterValue: event.target.value || undefined, filter: syntax || undefined }, true);
              }} placeholder={t('records.value')} type={availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'number' ? 'number' : 'search'} value={filterDraft.value} />}
          </label>
          <Button aria-label={t('records.clearFilter')} onClick={() => updateParams({ filter: undefined, filterField: undefined, filterOperator: undefined, filterValue: undefined }, true)} size="small" variant="quiet"><X aria-hidden="true" size={14} /></Button>
        </>}
        <label className="inline-flex min-h-8 items-center gap-2 text-[11px] font-semibold text-muted-foreground"><span>{t('records.sort')}</span>
          <select aria-label={t('records.sortField')} className={toolbarControlClass} onChange={(event) => updateParams({ sort: `${event.target.value} ${currentSortDirection}` }, true)} value={currentSortField}>
            <option value="createdAt">{t('records.created')}</option><option value="updatedAt">{t('records.updated')}</option><option value="id">{t('records.id')}</option>{fields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
          </select>
          <select aria-label={t('records.sortDirection')} className={toolbarControlClass} onChange={(event) => updateParams({ sort: `${currentSortField} ${event.target.value}` }, true)} value={currentSortDirection}><option value="desc">{t('records.newest')}</option><option value="asc">{t('records.oldest')}</option></select>
        </label>
        <details className="relative ml-auto"><summary className="flex min-h-8 cursor-pointer list-none items-center rounded-lg border border-input bg-card px-2.5 text-[11px] font-semibold text-ink-secondary [&::-webkit-details-marker]:hidden">{t('records.columns')}</summary><div className="absolute right-0 top-[calc(100%+5px)] z-30 grid min-w-[160px] gap-2 rounded-lg border bg-card p-2.5 text-xs shadow-floating">{['id', ...fields.map((field) => field.name), 'createdAt', 'updatedAt'].map((name) => <label className="flex items-center gap-2 text-ink-secondary" key={name}><input checked={visibleColumns.includes(name)} className="accent-primary" onChange={(event) => toggleColumn(name, event.target.checked)} type="checkbox" />{name}</label>)}</div></details>
      </Surface>

      {state === 'loading' && <LoadingState label={t('records.loading')} />}
      {state === 'error' && (() => { const copy = errorCopy(error, t('records.loadFailed'), t, errorMessage, validationMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('records.retry')}</Button></ErrorState>; })()}
      {state === 'ready' && page.data.length === 0 && !search && !filter && history.length === 0 && <EmptyState description={t('records.emptyDescription')} title={t('records.emptyTitle')}><Button onClick={openCreate} variant="primary"><Plus aria-hidden="true" size={14} />{t('records.createFirst')}</Button></EmptyState>}
      {state === 'ready' && page.data.length === 0 && (search || filter || history.length > 0) && <EmptyState description={t('records.noMatchDescription')} title={t('records.noMatchTitle')}><Button onClick={() => updateParams({ search: undefined, filter: undefined, filterField: undefined, filterOperator: undefined, filterValue: undefined }, true)} size="small">{t('records.clearSearchAndFilter')}</Button></EmptyState>}
      {state === 'ready' && page.data.length > 0 && <>
        <Table aria-label={t('records.tableCaption', { name: collection.name, page: history.length + 1 })} data-record-table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {visibleColumns.map((name) => <TableHead key={name} scope="col">{name === 'id' ? t('records.id') : name === 'createdAt' ? t('records.created') : name === 'updatedAt' ? t('records.updated') : name}</TableHead>)}
              <TableHead scope="col"><span className="sr-only">{t('records.actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.data.map((record) => <TableRow key={record.id}>
              {visibleColumns.map((name) => <TableCell className="max-w-[320px]" key={name}><button className={`block max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-xs hover:text-primary ${name === visibleColumns[0] ? 'font-semibold text-primary' : 'text-ink-secondary'}`} onClick={() => openRecord(record.id)} type="button">{name === 'createdAt' || name === 'updatedAt' ? displayDate(record[name], formatDate) : formatValue(record[name], t)}</button></TableCell>)}
              <TableCell className="w-px whitespace-nowrap"><div className="flex justify-end gap-1">{collection.type !== 'Auth' && <><Button onClick={() => openRecord(record.id, true)} size="small" variant="quiet">{t('records.edit')}</Button><Button aria-label={t('records.deleteRecordLabel', { id: record.id })} onClick={() => { setRowDeleteTarget(record); setRowDeleteError(undefined); }} size="small" variant="danger">{t('records.delete')}</Button></>}</div></TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
        <nav aria-label={t('records.pages')} className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t('records.page', { page: history.length + 1 })}</span><div className="flex gap-2"><Button disabled={!history.length} onClick={previousPage} size="small"><ChevronLeft aria-hidden="true" size={14} />{t('records.previous')}</Button><Button disabled={!page.nextCursor} onClick={nextPage} size="small">{t('records.next')}<ChevronRight aria-hidden="true" size={14} /></Button></div></nav>
      </>}

      <Sheet closeLabel={t('records.close')} open={isCreating || Boolean(selectedId)} onClose={closeSheet} size="wide" title={isCreating ? (collection.type === 'Auth' ? t('records.createUser') : t('records.createRecord')) : isEditing ? t('records.editRecord') : t('records.record')}>
        {isCreating && <RecordEditor collection={collection} fields={fields} key={`new-${collection.id}`} onCancel={closeSheet} onDelete={onRecordDeleted} onSaved={onRecordSaved} />}
        {!isCreating && selectedId && recordState === 'loading' && <LoadingState label={t('records.loadingRecord')} />}
        {!isCreating && selectedId && recordState === 'error' && (() => { const copy = errorCopy(recordError, t('records.openFailed'), t, errorMessage, validationMessage); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => openRecord(selectedId, isEditing)} size="small"><RefreshCw aria-hidden="true" size={14} />{t('records.retry')}</Button></ErrorState>; })()}
        {!isCreating && selectedId && recordState === 'ready' && activeRecord && <RecordEditor collection={collection} expandedFields={expandFields} fields={fields} key={`${activeRecord.id}-${isEditing ? 'edit' : 'view'}`} mode={isEditing ? 'edit' : 'view'} onCancel={closeSheet} onDelete={onRecordDeleted} onEdit={() => openRecord(activeRecord.id, true)} onSaved={onRecordSaved} record={activeRecord} />}
      </Sheet>
      <Dialog closeLabel={t('records.cancel')} open={Boolean(rowDeleteTarget)} onClose={() => { if (!rowDeleting) { setRowDeleteTarget(undefined); setRowDeleteError(undefined); } }} title={t('records.deleteTitle')}>
        <p className="m-0 text-xs leading-relaxed text-ink-secondary [&_code]:font-mono [&_code]:text-foreground">{t('records.deleteBodyPrefix')}<code>{rowDeleteTarget?.id}</code>{t('records.deleteBodySuffix', { name: collection.name })}</p>
        {rowDeleteError !== undefined && (() => { const copy = errorCopy(rowDeleteError, t('records.deleteFailed'), t, errorMessage, validationMessage); return <ErrorState description={copy.message} title={copy.title} />; })()}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3.5"><Button disabled={rowDeleting} onClick={() => { setRowDeleteTarget(undefined); setRowDeleteError(undefined); }} type="button" variant="quiet">{t('records.cancel')}</Button><Button disabled={rowDeleting} onClick={() => void confirmRowDelete()} type="button" variant="danger">{rowDeleting ? t('records.deleting') : t('records.deleteRecordAction')}</Button></div>
      </Dialog>
    </div>
  );
}
function initialFileLists(fields: FieldDefinition[], record?: CollectionRecord): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  for (const field of fields) {
    if (field.type !== 'files') continue;
    const value = record?.[field.name];
    lists[field.name] = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }
  return lists;
}

function initialRecordValues(fields: FieldDefinition[], record?: CollectionRecord) {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = record?.[field.name];
    if (value === undefined || value === null) values[field.name] = '';
    else if (field.type === 'json') values[field.name] = JSON.stringify(value, null, 2);
    else if (field.type === 'dateTime' && typeof value === 'string') values[field.name] = value.slice(0, 16);
    else values[field.name] = String(value);
  }
  return values;
}

function fieldInputType(field: FieldDefinition): FieldType {
  return field.type;
}

function fileRules(field: FieldDefinition) {
  const validation = isRecord(field.validation) ? field.validation : {};
  const maxBytes = typeof validation.maxBytes === 'number' && validation.maxBytes > 0 ? validation.maxBytes : 10 * 1024 * 1024;
  const allowed = Array.isArray(validation.allowedMimeTypes) ? validation.allowedMimeTypes.filter((value): value is string => typeof value === 'string') : ['text/plain', 'text/csv', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const maxFiles = typeof validation.maxFiles === 'number' && validation.maxFiles > 0 ? validation.maxFiles : 8;
  return { maxBytes, allowed, maxFiles };
}

function expandedRelationCopy(record: CollectionRecord, fieldName: string, requestedFields: string[], translate: ReturnType<typeof useI18n>['t']) {
  if (!requestedFields.includes(fieldName)) return '';
  const expand = isRecord(record._expand) ? record._expand : undefined;
  if (!expand || !Object.prototype.hasOwnProperty.call(expand, fieldName)) {
    return record[fieldName] === undefined || record[fieldName] === null ? '' : translate('records.targetUnavailable');
  }
  const value = expand[fieldName];
  if (value === null) return translate('records.noRelatedRecord');
  const targets = Array.isArray(value) ? value : [value];
  if (!targets.length) return translate('records.noRelatedRecords');
  return targets.map((target) => {
    if (!isRecord(target)) return '';
    const summary = Object.entries(target)
      .filter(([name]) => !['id', 'createdAt', 'updatedAt'].includes(name))
      .map(([name, targetValue]) => `${name}: ${formatValue(targetValue, translate)}`)
      .join(' · ');
    return summary || String(target.id ?? translate('records.relatedRecord'));
  }).filter(Boolean).join(' · ');
}

function RecordEditor({ collection, fields, record, expandedFields = [], mode = 'create', onCancel, onEdit, onSaved, onDelete }: {
  collection: Collection;
  fields: FieldDefinition[];
  expandedFields?: string[];
  record?: CollectionRecord;
  mode?: 'create' | 'view' | 'edit';
  onCancel: () => void;
  onEdit?: () => void;
  onSaved: (record: CollectionRecord) => void;
  onDelete: () => void;
}) {
  const { t, formatDate, errorMessage, validationMessage } = useI18n();
  const [values, setValues] = useState<Record<string, string>>(() => initialRecordValues(fields, record));
  const [uploaded, setUploaded] = useState<Record<string, UploadedCollectionFile>>({});
  const [fileLists, setFileLists] = useState<Record<string, string[]>>(() => initialFileLists(fields, record));
  const [fileMeta, setFileMeta] = useState<Record<string, UploadedCollectionFile[]>>({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const readOnly = mode === 'view';
  const isNew = mode === 'create';

  function setValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => { const next = { ...current }; delete next[name]; return next; });
    setFormError(undefined);
  }

  async function uploadFile(field: FieldDefinition, file: File | undefined) {
    if (!file) return;
    const { maxBytes, allowed } = fileRules(field);
    if (file.size > maxBytes) { setUploadErrors((current) => ({ ...current, [field.name]: t('records.chooseSmallerFile', { size: Math.ceil(maxBytes / 1024 / 1024) }) })); return; }
    if (file.type && allowed.length && !allowed.includes(file.type)) { setUploadErrors((current) => ({ ...current, [field.name]: t('records.fieldAccepts', { types: allowed.join(', ') }) })); return; }
    setUploading((current) => ({ ...current, [field.name]: true }));
    setUploadErrors((current) => { const next = { ...current }; delete next[field.name]; return next; });
    try {
      const result = await uploadCollectionFile(collection.id, field.name, file);
      setUploaded((current) => ({ ...current, [field.name]: result }));
      if (field.type === 'files') {
        setFileLists((current) => ({ ...current, [field.name]: [...(current[field.name] ?? []), result.temporaryId] }));
        setFileMeta((current) => ({ ...current, [field.name]: [...(current[field.name] ?? []), result] }));
      } else {
        setValues((current) => ({ ...current, [field.name]: result.temporaryId }));
      }
    } catch (reason) {
      setUploadErrors((current) => ({ ...current, [field.name]: errorCopy(reason, t('records.uploadFailed'), t, errorMessage, validationMessage).title }));
    } finally { setUploading((current) => ({ ...current, [field.name]: false })); }
  }

  function removeFile(field: FieldDefinition, index: number) {
    setFileLists((current) => ({ ...current, [field.name]: (current[field.name] ?? []).filter((_, position) => position !== index) }));
    setFileMeta((current) => ({ ...current, [field.name]: (current[field.name] ?? []).filter((_, position) => position !== index) }));
  }

  async function downloadAt(field: FieldDefinition, index: number) {
    if (!record) return;
    try {
      const blob = await downloadRecordFileAt(collection.id, record.id, field.name, index);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = field.name + '-' + record.id + '-' + index;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setUploadErrors((current) => ({ ...current, [field.name]: errorCopy(reason, t('records.downloadFailed'), t, errorMessage, validationMessage).title }));
    }
  }
  function buildValues() {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.name] ?? '';
      if (field.type === 'files') {
        const list = fileLists[field.name] ?? [];
        if (list.length) result[field.name] = list;
        else if (record && record[field.name] !== undefined) result[field.name] = null;
        continue;
      }
      if (field.type === 'file') {
        if (uploaded[field.name]) result[field.name] = uploaded[field.name]?.temporaryId;
        else if (raw === '' && record && record[field.name] !== undefined) result[field.name] = null;
        else if (raw !== '') result[field.name] = raw;
        continue;
      }
      if (raw === '') {
        if (record && record[field.name] !== undefined) result[field.name] = null;
        continue;
      }
      switch (field.type) {
        case 'number': {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) throw new Error(t('records.numberInvalid', { name: field.name }));
          result[field.name] = parsed;
          break;
        }
        case 'boolean': result[field.name] = raw === 'true'; break;
        case 'json': {
          try { result[field.name] = JSON.parse(raw) as unknown; }
          catch { setFieldErrors((current) => ({ ...current, [field.name]: t('records.jsonInvalid') })); throw new Error(t('records.jsonInvalidField', { name: field.name })); }
          break;
        }
        case 'dateTime': {
          const date = new Date(raw);
          if (Number.isNaN(date.valueOf())) throw new Error(t('records.dateInvalid', { name: field.name }));
          result[field.name] = date.toISOString();
          break;
        }
        default: result[field.name] = raw;
      }
    }
    return result;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setFormError(undefined);
    setFieldErrors({});
    if (isNew && collection.type === 'Auth' && password !== confirmPassword) {
      setFieldErrors({ confirmPassword: t('records.passwordsDoNotMatch') });
      return;
    }
    let allValues: Record<string, unknown>;
    try { allValues = buildValues(); }
    catch (reason) { setFormError(reason); return; }
    if (Object.values(uploading).some(Boolean)) return;
    if (!isNew && record) {
      allValues = Object.fromEntries(Object.entries(allValues).filter(([name, value]) => JSON.stringify(value) !== JSON.stringify(record[name])));
    }
    setSaving(true);
    try {
      const saved = isNew
        ? collection.type === 'Auth' ? await createApplicationUser(collection.id, allValues, password) : await createRecord(collection.id, allValues)
        : await updateRecord(collection.id, record!.id, allValues);
      onSaved(saved);
    } catch (reason) {
      const copy = errorCopy(reason, t('records.saveFailed'), t, errorMessage, validationMessage);
      setFormError(reason);
      setFieldErrors(Object.fromEntries(copy.violations.flatMap((violation) => {
        const match = violation.path?.match(/(?:^|\/)values\/([^/]+)|(?:^|\/)([^/]+)$/);
        const name = match?.[1] ?? match?.[2];
        return name ? [[name, violation.message ?? t('records.reviewThisValue')]] : [];
      })));
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!record) return;
    setDeleting(true);
    setFormError(undefined);
    try { await deleteRecord(collection.id, record.id); onDelete(); }
    catch (reason) { setFormError(reason); setDeleting(false); }
  }

  async function download(field: FieldDefinition) {
    if (!record) return;
    try {
      const blob = await downloadRecordFile(collection.id, record.id, field.name);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${field.name}-${record.id}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) { setFormError(reason); }
  }

  const formCopy = formError ? errorCopy(formError, t('records.saveFailed'), t, errorMessage, validationMessage) : undefined;
  return (
    <div className="grid gap-4" data-record-editor>
      {mode === 'view' && record ? <>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 border-b pb-2.5" data-record-identity><span className="text-[10px] font-semibold uppercase tracking-[0.7px] text-muted-foreground">{t('records.recordId')}</span><code className="break-words font-mono text-xs text-ink-secondary">{record.id}</code><span className="col-start-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Clock3 aria-hidden="true" size={13} /> {t('records.updatedAt', { date: displayDate(record.updatedAt, formatDate) })}</span></div>
        <dl className="m-0 grid" data-record-values>{fields.map((field) => <div className="grid grid-cols-[minmax(95px,0.35fr)_minmax(0,1fr)] gap-2.5 border-b py-2.5" key={field.name}><dt className="text-xs font-semibold text-muted-foreground">{field.name}</dt><dd className="m-0 flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-ink-secondary">
          {field.type === 'file' && record[field.name] ? <><span>{t('records.fileAttached')}</span><Button onClick={() => void download(field)} size="small" variant="quiet"><Download aria-hidden="true" size={13} />{t('records.download')}</Button></> : <><span className="break-words">{formatValue(record[field.name], t)}</span>{field.type === 'relation' && expandedRelationCopy(record, field.name, expandedFields, t) && <small className="basis-full text-[11px] text-muted-foreground">{t('records.related', { value: expandedRelationCopy(record, field.name, expandedFields, t) })}</small>}</>}
        </dd></div>)}</dl>
        {recordErrorCopy(formCopy)}
        {confirmDelete && <div className="grid gap-1.5 rounded-lg border border-danger/30 bg-danger-soft p-2.5" role="alert"><strong className="text-xs text-danger">{t('records.deleteTitle')}</strong><span className="text-[11px] text-ink-secondary">{t('records.confirmDeleteBody')}</span><div className="flex justify-end gap-2 pt-1"><Button disabled={deleting} onClick={() => setConfirmDelete(false)} size="small">{t('records.cancel')}</Button><Button disabled={deleting} onClick={() => void remove()} size="small" variant="danger">{deleting ? t('records.deleting') : t('records.deleteRecordAction')}</Button></div></div>}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3.5" data-record-editor-actions><Button onClick={onCancel} variant="quiet">{t('records.close')}</Button>{collection.type !== 'Auth' && <><Button onClick={onEdit} variant="primary">{t('records.edit')}</Button><Button onClick={() => setConfirmDelete(true)} size="small" variant="danger"><Trash2 aria-hidden="true" size={14} />{t('records.delete')}</Button></>}</div>
      </> : <form className="grid gap-3.5" onSubmit={(event) => void save(event)}>
        {formCopy && <ErrorState description={formCopy.message} title={formCopy.title} />}
        {collection.type === 'Auth' && isNew && <section className="grid gap-2 border-b pb-2.5"><h3 className="m-0 text-xs font-semibold text-foreground">{t('records.profile')}</h3><p className="m-0 text-[11px] text-muted-foreground">{t('records.profileHint')}</p></section>}
        {fields.map((field) => <RecordField
          disabled={saving || readOnly}
          error={fieldErrors[field.name]}
          field={field}
          key={field.name}
          fileList={fileLists[field.name] ?? []}
          fileMeta={fileMeta[field.name] ?? []}
          onDownloadAt={(index) => void downloadAt(field, index)}
          onFile={(file) => uploadFile(field, file)}
          onRemoveFile={(index) => removeFile(field, index)}
          onValue={(value) => setValue(field.name, value)}
          record={record}
          upload={uploaded[field.name]}
          uploadError={uploadErrors[field.name]}
          uploading={Boolean(uploading[field.name])}
          value={values[field.name] ?? ''}
        />)}
        {collection.type === 'Auth' && isNew && <section className="grid gap-2 border-b pb-2.5"><h3 className="m-0 text-xs font-semibold text-foreground">{t('records.authentication')}</h3>
          <FormField htmlFor="record-user-password" label={t('records.password')}><input autoComplete="new-password" disabled={saving} id="record-user-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></FormField>
          <FormField htmlFor="record-user-confirm-password" label={t('records.confirmPassword')}><input autoComplete="new-password" disabled={saving} id="record-user-confirm-password" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></FormField>
          {fieldErrors.confirmPassword && <span className="text-[11px] font-semibold text-danger" role="alert">{fieldErrors.confirmPassword}</span>}
        </section>}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3.5" data-record-editor-actions><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">{t('records.cancel')}</Button><Button disabled={saving || Object.values(uploading).some(Boolean)} type="submit" variant="primary">{saving ? t('records.saving') : isNew ? (collection.type === 'Auth' ? t('records.createUser') : t('records.createRecord')) : t('records.saveChanges')}</Button></div>
      </form>}
    </div>
  );
}

function recordErrorCopy(copy: ReturnType<typeof errorCopy> | undefined) {
  return copy ? <ErrorState description={copy.message} title={copy.title} /> : null;
}
function RecordField({ field, value, disabled, error, upload, uploadError, uploading, onValue, onFile, record, fileList, fileMeta, onRemoveFile, onDownloadAt }: {
  field: FieldDefinition;
  value: string;
  disabled: boolean;
  error?: string;
  upload?: UploadedCollectionFile;
  uploadError?: string;
  uploading: boolean;
  record?: CollectionRecord;
  onValue: (value: string) => void;
  onFile: (file?: File) => Promise<void> | void;
  fileList?: string[];
  fileMeta?: UploadedCollectionFile[];
  onRemoveFile?: (index: number) => void;
  onDownloadAt?: (index: number) => void;
}) {
  const { t, formatNumber } = useI18n();
  const inputId = `record-field-${field.name}`;
  const fileInput = useRef<HTMLInputElement>(null);
  const hint = field.description || (field.type === 'relation' ? t('records.relationHint', { target: field.relation?.targetCollectionId ? ` (${field.relation.targetCollectionId})` : '' }) : undefined);
  const inputType = field.type === 'files' ? 'file' : fieldInputType(field);
  let control;
  switch (inputType) {
    case 'boolean': control = <select disabled={disabled} id={inputId} onChange={(event) => onValue(event.target.value)} value={value}><option value="">{t('records.notSet')}</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>; break;
    case 'json': control = <textarea disabled={disabled} id={inputId} onChange={(event) => onValue(event.target.value)} rows={5} value={value} />; break;
    case 'file': {
      const rules = fileRules(field);
      if (field.type === 'files') {
        const list = fileList ?? [];
        control = <div className="grid gap-2" data-testid={'record-files-' + field.name}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {list.map((entry, index) => {
              const meta = fileMeta?.find((item) => item.temporaryId === entry) ?? upload;
              const staged = entry.startsWith('tmp_');
              return <li className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-[11px] text-ink-secondary" key={entry + '-' + index}>
                <span className="text-muted-foreground">#{index}</span>
                <code className="break-all font-mono">{entry}</code>
                {meta && <small className="text-[11px] text-muted-foreground">{t('records.fileMeta', { type: meta.contentType, size: formatNumber(meta.size) })}</small>}
                <span className="ml-auto flex gap-1">
                  {!staged && !disabled && onDownloadAt && <Button onClick={() => onDownloadAt(index)} size="small" type="button" variant="quiet">{t('records.download')}</Button>}
                  {!disabled && onRemoveFile && <Button onClick={() => onRemoveFile(index)} size="small" type="button" variant="quiet">{t('records.remove')}</Button>}
                </span>
              </li>;
            })}
          </ul>
          <input accept={rules.allowed.join(',')} aria-label={t('records.fieldFilesLabel', { name: field.name })} className="w-full rounded-lg border border-dashed! border-input !bg-secondary p-1.5 text-[11px] text-ink-secondary file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-[11px] file:font-semibold" disabled={disabled || uploading} id={inputId} multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void (async () => { for (const file of files) await onFile(file); })(); }} type="file" />
          <small className="text-[11px] text-muted-foreground">{t('records.filesHint', { max: rules.maxFiles, size: Math.ceil(rules.maxBytes / 1024 / 1024), types: rules.allowed.join(', ') })}</small>
          {list.length >= rules.maxFiles && <span className="text-[11px] font-semibold text-danger" role="alert">{t('records.maxFilesReached')}</span>}
          {uploading && <span className="text-[11px] text-muted-foreground" role="status">{t('records.uploading')}</span>}
          {uploadError && <span className="text-[11px] font-semibold text-danger" role="alert">{uploadError}</span>}
        </div>;
        break;
      }
      control = <div className="grid gap-2">
        {Boolean(record?.[field.name]) && <span className="flex items-center justify-between gap-2 text-[11px] text-ink-secondary">{t('records.fileAttachedToRecord')} <Button disabled={disabled || uploading} onClick={() => fileInput.current?.click()} size="small" type="button" variant="quiet">{t('records.replace')}</Button></span>}
        <input accept={rules.allowed.join(',')} aria-label={t('records.fieldFileLabel', { name: field.name })} className="w-full rounded-lg border border-dashed! border-input !bg-secondary p-1.5 text-[11px] text-ink-secondary file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-[11px] file:font-semibold" disabled={disabled || uploading} id={inputId} onChange={(event) => void onFile(event.target.files?.[0])} ref={fileInput} type="file" />
        <small className="text-[11px] text-muted-foreground">{t('records.fileHint', { size: Math.ceil(rules.maxBytes / 1024 / 1024), types: rules.allowed.join(', ') })}</small>
        {uploading && <span className="text-[11px] text-muted-foreground" role="status">{t('records.uploading')}</span>}
        {upload && <span className="text-[11px] text-muted-foreground" role="status">{t('records.fileReady', { type: upload.contentType, size: formatNumber(upload.size) })}</span>}
        {uploadError && <span className="text-[11px] font-semibold text-danger" role="alert">{uploadError}</span>}
      </div>;
      break;
    }
    default: control = <input autoComplete="off" disabled={disabled} id={inputId} onChange={(event) => onValue(event.target.value)} step={inputType === 'number' ? 'any' : undefined} type={inputType === 'number' ? 'number' : inputType === 'dateTime' ? 'datetime-local' : 'text'} value={value} />;
  }
  return <FormField htmlFor={inputId} hint={hint} label={`${field.name}${field.required ? t('records.required') : ''}`}>
    {control}
    {error && <span className="text-[11px] font-semibold text-danger" role="alert">{error}</span>}
  </FormField>;
}
