import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Download, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCopy(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) {
    const violations = Array.isArray(error.apiError.details.violations)
      ? error.apiError.details.violations.filter(isRecord).map((item) => ({ path: String(item.path ?? ''), message: String(item.message ?? item.code ?? 'Review this value.') }))
      : [];
    return {
      title: error.apiError.message,
      message: [error.apiError.code, error.apiError.hint, `Request ID: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
      violations,
    };
  }
  return { title: fallback, message: error instanceof Error ? error.message : 'Try again when the project is available.', violations: [] as Violation[] };
}

function scalarFields(fields: FieldDefinition[]) {
  return fields.filter((field) => !field.system && ['text', 'number', 'boolean', 'dateTime', 'relation'].includes(field.type));
}

function formatValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
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

function displayDate(value: unknown) {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
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
  return (
    <header className="page-heading collection-heading records-heading">
      <div><p className="eyebrow">{collection.name} · DATA</p><h1>Records</h1><p className="page-description">Review and manage saved {collection.name} data.</p></div>
      <Button onClick={onCreate} variant="primary"><Plus aria-hidden="true" size={15} />{collection.type === 'Auth' ? 'Create user' : 'Create record'}</Button>
    </header>
  );
}

export function CollectionRecordsPage() {
  const { collection } = useCollectionWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState<Page<CollectionRecord>>({ data: [] });
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [message, setMessage] = useState('');
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
    setMessage('Record saved. The durable result is shown here.');
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
    setMessage('Record deleted.');
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
    <div className="page-stack collection-page records-page">
      <RecordPageTitle collection={collection} onCreate={openCreate} />
      {message && <div className="records-success" role="status"><span>{message}</span><button aria-label="Dismiss message" onClick={() => setMessage('')} type="button"><X aria-hidden="true" size={14} /></button></div>}
      <Surface className="records-toolbar" variant="standard">
        <label className="collection-search records-search">
          <Search aria-hidden="true" size={15} />
          <span className="sr-only">Search records</span>
          <input aria-label="Search records" onChange={(event) => updateParams({ search: event.target.value || undefined }, true)} placeholder="Search records…" type="search" value={search} />
        </label>
        <label className="records-control"><SlidersHorizontal aria-hidden="true" size={14} /><span>Filter</span>
          <select aria-label="Filter field" onChange={(event) => updateParams({ filterField: event.target.value || undefined, filterOperator: 'eq', filterValue: undefined, filter: undefined }, true)} value={filterDraft.field}>
            <option value="">No filter</option>{availableFilterFields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
          </select>
        </label>
        {filterDraft.field && <>
          <label className="records-control"><span className="sr-only">Filter operator</span>
            <select aria-label="Filter operator" onChange={(event) => {
              const draft = { ...filterDraft, operator: event.target.value };
              updateParams({ filterOperator: draft.operator, filter: filterSyntax(draft, availableFilterFields.find((field) => field.name === draft.field)) || undefined }, true);
            }} value={filterDraft.operator}>
              {(filterDraft.field && availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'text'
                ? ['eq', 'ne', 'contains']
                : availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'number' || availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'dateTime'
                  ? ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'ne']).map((operator) => <option key={operator} value={operator}>{operator}</option>)}
            </select>
          </label>
          <label className="records-control records-filter-value"><span className="sr-only">Filter value</span>
            {availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'boolean'
              ? <select aria-label="Filter value" onChange={(event) => {
                const value = event.target.value;
                const draft = { ...filterDraft, value };
                updateParams({ filterValue: value, filter: filterSyntax(draft, availableFilterFields.find((field) => field.name === draft.field)) || undefined }, true);
              }} value={filterDraft.value || 'true'}><option value="true">Yes</option><option value="false">No</option></select>
              : <input aria-label="Filter value" onChange={(event) => {
                const field = availableFilterFields.find((item) => item.name === filterDraft.field);
                const draft = { ...filterDraft, value: event.target.value };
                const syntax = filterSyntax(draft, field);
                updateParams({ filterValue: event.target.value || undefined, filter: syntax || undefined }, true);
              }} placeholder="Value" type={availableFilterFields.find((field) => field.name === filterDraft.field)?.type === 'number' ? 'number' : 'search'} value={filterDraft.value} />}
          </label>
          <Button aria-label="Clear filter" onClick={() => updateParams({ filter: undefined, filterField: undefined, filterOperator: undefined, filterValue: undefined }, true)} size="small" variant="quiet"><X aria-hidden="true" size={14} /></Button>
        </>}
        <label className="records-control"><span>Sort</span>
          <select aria-label="Sort field" onChange={(event) => updateParams({ sort: `${event.target.value} ${currentSortDirection}` }, true)} value={currentSortField}>
            <option value="createdAt">Created</option><option value="updatedAt">Updated</option><option value="id">ID</option>{fields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
          </select>
          <select aria-label="Sort direction" onChange={(event) => updateParams({ sort: `${currentSortField} ${event.target.value}` }, true)} value={currentSortDirection}><option value="desc">Newest</option><option value="asc">Oldest</option></select>
        </label>
        <details className="records-columns"><summary>Columns</summary><div>{['id', ...fields.map((field) => field.name), 'createdAt', 'updatedAt'].map((name) => <label key={name}><input checked={visibleColumns.includes(name)} onChange={(event) => toggleColumn(name, event.target.checked)} type="checkbox" />{name}</label>)}</div></details>
      </Surface>

      {state === 'loading' && <LoadingState label="Loading records" />}
      {state === 'error' && (() => { const copy = errorCopy(error, 'Records could not be loaded.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
      {state === 'ready' && page.data.length === 0 && !search && !filter && history.length === 0 && <EmptyState description="Create a record to see saved data in this Collection." title="No records yet"><Button onClick={openCreate} variant="primary"><Plus aria-hidden="true" size={14} />Create first record</Button></EmptyState>}
      {state === 'ready' && page.data.length === 0 && (search || filter || history.length > 0) && <EmptyState description="Try another search or filter, or return to the previous result page." title="No records match this view"><Button onClick={() => updateParams({ search: undefined, filter: undefined, filterField: undefined, filterOperator: undefined, filterValue: undefined }, true)} size="small">Clear search and filter</Button></EmptyState>}
      {state === 'ready' && page.data.length > 0 && <>
        <div className="records-table-wrap"><table className="records-table"><caption>{collection.name} records · page {history.length + 1}</caption><thead><tr>{visibleColumns.map((name) => <th key={name} scope="col">{name === 'id' ? 'ID' : name === 'createdAt' ? 'Created' : name === 'updatedAt' ? 'Updated' : name}</th>)}<th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{page.data.map((record) => <tr key={record.id}>
            {visibleColumns.map((name) => <td key={name}><button className="records-cell-link" onClick={() => openRecord(record.id)} type="button">{name === 'createdAt' || name === 'updatedAt' ? displayDate(record[name]) : formatValue(record[name])}</button></td>)}
            <td className="records-row-actions">{collection.type !== 'Auth' && <><Button onClick={() => openRecord(record.id, true)} size="small" variant="quiet">Edit</Button><Button aria-label={`Delete record ${record.id}`} onClick={() => { setRowDeleteTarget(record); setRowDeleteError(undefined); }} size="small" variant="danger">Delete</Button></>}</td>
          </tr>)}</tbody>
        </table></div>
        <nav aria-label="Record pages" className="records-pagination"><span>Page {history.length + 1}</span><div><Button disabled={!history.length} onClick={previousPage} size="small"><ChevronLeft aria-hidden="true" size={14} />Previous</Button><Button disabled={!page.nextCursor} onClick={nextPage} size="small">Next<ChevronRight aria-hidden="true" size={14} /></Button></div></nav>
      </>}

      <Sheet open={isCreating || Boolean(selectedId)} onClose={closeSheet} size="wide" title={isCreating ? (collection.type === 'Auth' ? 'Create user' : 'Create record') : isEditing ? 'Edit record' : 'Record'}>
        {isCreating && <RecordEditor collection={collection} fields={fields} key={`new-${collection.id}`} onCancel={closeSheet} onDelete={onRecordDeleted} onSaved={onRecordSaved} />}
        {!isCreating && selectedId && recordState === 'loading' && <LoadingState label="Loading record" />}
        {!isCreating && selectedId && recordState === 'error' && (() => { const copy = errorCopy(recordError, 'This record could not be opened.'); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => openRecord(selectedId, isEditing)} size="small"><RefreshCw aria-hidden="true" size={14} />Retry</Button></ErrorState>; })()}
        {!isCreating && selectedId && recordState === 'ready' && activeRecord && <RecordEditor collection={collection} expandedFields={expandFields} fields={fields} key={`${activeRecord.id}-${isEditing ? 'edit' : 'view'}`} mode={isEditing ? 'edit' : 'view'} onCancel={closeSheet} onDelete={onRecordDeleted} onEdit={() => openRecord(activeRecord.id, true)} onSaved={onRecordSaved} record={activeRecord} />}
      </Sheet>
      <Dialog open={Boolean(rowDeleteTarget)} onClose={() => { if (!rowDeleting) { setRowDeleteTarget(undefined); setRowDeleteError(undefined); } }} title="Delete this record?">
        <p>This permanently removes record <code>{rowDeleteTarget?.id}</code> from {collection.name}.</p>
        {rowDeleteError !== undefined && (() => { const copy = errorCopy(rowDeleteError, 'The record could not be deleted.'); return <ErrorState description={copy.message} title={copy.title} />; })()}
        <div className="record-editor-actions"><Button disabled={rowDeleting} onClick={() => { setRowDeleteTarget(undefined); setRowDeleteError(undefined); }} type="button" variant="quiet">Cancel</Button><Button disabled={rowDeleting} onClick={() => void confirmRowDelete()} type="button" variant="danger">{rowDeleting ? 'Deleting…' : 'Delete record'}</Button></div>
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

function expandedRelationCopy(record: CollectionRecord, fieldName: string, requestedFields: string[]) {
  if (!requestedFields.includes(fieldName)) return '';
  const expand = isRecord(record._expand) ? record._expand : undefined;
  if (!expand || !Object.prototype.hasOwnProperty.call(expand, fieldName)) {
    return record[fieldName] === undefined || record[fieldName] === null ? '' : 'Target unavailable or not visible.';
  }
  const value = expand[fieldName];
  if (value === null) return 'No related record.';
  const targets = Array.isArray(value) ? value : [value];
  if (!targets.length) return 'No related records.';
  return targets.map((target) => {
    if (!isRecord(target)) return '';
    const summary = Object.entries(target)
      .filter(([name]) => !['id', 'createdAt', 'updatedAt'].includes(name))
      .map(([name, targetValue]) => `${name}: ${formatValue(targetValue)}`)
      .join(' · ');
    return summary || String(target.id ?? 'Related record');
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
    if (file.size > maxBytes) { setUploadErrors((current) => ({ ...current, [field.name]: `Choose a file no larger than ${Math.ceil(maxBytes / 1024 / 1024)} MB.` })); return; }
    if (file.type && allowed.length && !allowed.includes(file.type)) { setUploadErrors((current) => ({ ...current, [field.name]: `This field accepts ${allowed.join(', ')}.` })); return; }
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
      setUploadErrors((current) => ({ ...current, [field.name]: errorCopy(reason, 'The file could not be uploaded.').title }));
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
      setUploadErrors((current) => ({ ...current, [field.name]: errorCopy(reason, 'The file could not be downloaded.').title }));
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
          if (!Number.isFinite(parsed)) throw new Error(`${field.name} must be a valid number.`);
          result[field.name] = parsed;
          break;
        }
        case 'boolean': result[field.name] = raw === 'true'; break;
        case 'json': {
          try { result[field.name] = JSON.parse(raw) as unknown; }
          catch { setFieldErrors((current) => ({ ...current, [field.name]: 'Enter valid JSON.' })); throw new Error(`${field.name} needs valid JSON.`); }
          break;
        }
        case 'dateTime': {
          const date = new Date(raw);
          if (Number.isNaN(date.valueOf())) throw new Error(`${field.name} must be a valid date and time.`);
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
      setFieldErrors({ confirmPassword: 'Passwords do not match.' });
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
      const copy = errorCopy(reason, 'The record could not be saved.');
      setFormError(reason);
      setFieldErrors(Object.fromEntries(copy.violations.flatMap((violation) => {
        const match = violation.path?.match(/(?:^|\/)values\/([^/]+)|(?:^|\/)([^/]+)$/);
        const name = match?.[1] ?? match?.[2];
        return name ? [[name, violation.message ?? 'Review this value.']] : [];
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

  const formCopy = formError ? errorCopy(formError, 'The record could not be saved.') : undefined;
  return (
    <div className="record-editor">
      {mode === 'view' && record ? <>
        <div className="record-detail-identity"><span>Record ID</span><code>{record.id}</code><span><Clock3 aria-hidden="true" size={13} /> Updated {displayDate(record.updatedAt)}</span></div>
        <dl className="record-detail-values">{fields.map((field) => <div key={field.name}><dt>{field.name}</dt><dd>
          {field.type === 'file' && record[field.name] ? <><span>File attached</span><Button onClick={() => void download(field)} size="small" variant="quiet"><Download aria-hidden="true" size={13} />Download</Button></> : <><span>{formatValue(record[field.name])}</span>{field.type === 'relation' && expandedRelationCopy(record, field.name, expandedFields) && <small className="record-relation-expand">Related: {expandedRelationCopy(record, field.name, expandedFields)}</small>}</>}
        </dd></div>)}</dl>
        {recordErrorCopy(formCopy)}
        {confirmDelete && <div className="record-delete-confirm" role="alert"><strong>Delete this record?</strong><span>This removes the durable record. You can’t undo this action.</span><div><Button disabled={deleting} onClick={() => setConfirmDelete(false)} size="small">Cancel</Button><Button disabled={deleting} onClick={() => void remove()} size="small" variant="danger">{deleting ? 'Deleting…' : 'Delete record'}</Button></div></div>}
        <div className="record-editor-actions"><Button onClick={onCancel} variant="quiet">Close</Button>{collection.type !== 'Auth' && <><Button onClick={onEdit} variant="primary">Edit</Button><Button onClick={() => setConfirmDelete(true)} size="small" variant="danger"><Trash2 aria-hidden="true" size={14} />Delete</Button></>}</div>
      </> : <form onSubmit={(event) => void save(event)}>
        {formCopy && <ErrorState description={formCopy.message} title={formCopy.title} />}
        {collection.type === 'Auth' && isNew && <section className="record-auth-fields"><h3>Profile</h3><p>Email, profile details, and the account password are saved together.</p></section>}
        {fields.map((field) => <RecordField
          disabled={saving || readOnly}
          error={fieldErrors[field.name]}
          field={field}
          key={field.name}
          fileList={fileLists[field.name] ?? []}
          fileMeta={fileMeta[field.name] ?? []}
          onDownloadAt={(index) => void downloadAt(field, index)}
          onFile={(file) => void uploadFile(field, file)}
          onRemoveFile={(index) => removeFile(field, index)}
          onValue={(value) => setValue(field.name, value)}
          record={record}
          upload={uploaded[field.name]}
          uploadError={uploadErrors[field.name]}
          uploading={Boolean(uploading[field.name])}
          value={values[field.name] ?? ''}
        />)}
        {collection.type === 'Auth' && isNew && <section className="record-auth-fields"><h3>Authentication</h3>
          <FormField htmlFor="record-user-password" label="Password"><input autoComplete="new-password" disabled={saving} id="record-user-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></FormField>
          <FormField htmlFor="record-user-confirm-password" label="Confirm password"><input autoComplete="new-password" disabled={saving} id="record-user-confirm-password" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></FormField>
          {fieldErrors.confirmPassword && <span className="record-field-error" role="alert">{fieldErrors.confirmPassword}</span>}
        </section>}
        <div className="record-editor-actions"><Button disabled={saving} onClick={onCancel} type="button" variant="quiet">Cancel</Button><Button disabled={saving || Object.values(uploading).some(Boolean)} type="submit" variant="primary">{saving ? 'Saving…' : isNew ? (collection.type === 'Auth' ? 'Create user' : 'Create record') : 'Save changes'}</Button></div>
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
  onFile: (file?: File) => void;
  fileList?: string[];
  fileMeta?: UploadedCollectionFile[];
  onRemoveFile?: (index: number) => void;
  onDownloadAt?: (index: number) => void;
}) {
  const inputId = `record-field-${field.name}`;
  const fileInput = useRef<HTMLInputElement>(null);
  const hint = field.description || (field.type === 'relation' ? `Enter a record ID from the related Collection${field.relation?.targetCollectionId ? ` (${field.relation.targetCollectionId})` : ''}.` : undefined);
  const inputType = field.type === 'files' ? 'file' : fieldInputType(field);
  let control;
  switch (inputType) {
    case 'boolean': control = <select disabled={disabled} id={inputId} onChange={(event) => onValue(event.target.value)} value={value}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>; break;
    case 'json': control = <textarea disabled={disabled} id={inputId} onChange={(event) => onValue(event.target.value)} rows={5} value={value} />; break;
    case 'file': {
      const rules = fileRules(field);
      if (field.type === 'files') {
        const list = fileList ?? [];
        control = <div className="record-file-control" data-testid={'record-files-' + field.name}>
          <ul className="record-file-list">
            {list.map((entry, index) => {
              const meta = fileMeta?.find((item) => item.temporaryId === entry) ?? upload;
              const staged = entry.startsWith('tmp_');
              return <li key={entry + '-' + index}>
                <span>#{index}</span>
                <code>{entry}</code>
                {meta && <small>{meta.contentType} · {meta.size.toLocaleString()} bytes</small>}
                {!staged && !disabled && onDownloadAt && <Button onClick={() => onDownloadAt(index)} size="small" type="button" variant="quiet">Download</Button>}
                {!disabled && onRemoveFile && <Button onClick={() => onRemoveFile(index)} size="small" type="button" variant="quiet">Remove</Button>}
              </li>;
            })};
          </ul>
          <input accept={rules.allowed.join(',')} aria-label={field.name + ' files'} disabled={disabled || uploading} id={inputId} multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; for (const file of files) onFile(file); }} type="file" />
          <small>Up to {rules.maxFiles} files · {Math.ceil(rules.maxBytes / 1024 / 1024)} MB each · {rules.allowed.join(', ')}</small>
          {list.length >= rules.maxFiles && <span className="record-field-error" role="alert">This field already holds the maximum number of files.</span>}
          {uploading && <span role="status">Uploading file…</span>}
          {uploadError && <span className="record-field-error" role="alert">{uploadError}</span>}
        </div>;
        break;
      }
      control = <div className="record-file-control">
        {Boolean(record?.[field.name]) && <span className="record-file-current">File attached to this record <Button disabled={disabled || uploading} onClick={() => fileInput.current?.click()} size="small" type="button" variant="quiet">Replace</Button></span>}
        <input accept={rules.allowed.join(',')} aria-label={`${field.name} file`} disabled={disabled || uploading} id={inputId} onChange={(event) => onFile(event.target.files?.[0])} ref={fileInput} type="file" />
        <small>Single file · up to {Math.ceil(rules.maxBytes / 1024 / 1024)} MB · {rules.allowed.join(', ')}</small>
        {uploading && <span role="status">Uploading file…</span>}
        {upload && <span role="status">File ready · {upload.contentType} · {upload.size.toLocaleString()} bytes</span>}
        {uploadError && <span className="record-field-error" role="alert">{uploadError}</span>}
      </div>;
      break;
    }
    default: control = <input autoComplete="off" disabled={disabled} id={inputId} onChange={(event) => onValue(event.target.value)} step={inputType === 'number' ? 'any' : undefined} type={inputType === 'number' ? 'number' : inputType === 'dateTime' ? 'datetime-local' : 'text'} value={value} />;
  }
  return <FormField htmlFor={inputId} hint={hint} label={`${field.name}${field.required ? ' · Required' : ''}`}>
    {control}
    {error && <span className="record-field-error" role="alert">{error}</span>}
  </FormField>;
}
