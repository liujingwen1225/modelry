import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Clock3, Database, GitBranch, Layers3, LoaderCircle, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import {
  applySchemaChange,
  discardSchemaChange,
  listSchemaHistory,
  listAllCollections,
  previewSchemaChange,
  removePendingOperation,
  savePendingOperation,
  updatePendingOperation,
  type AppliedMigration,
  type Collection,
  type FieldDefinition,
  type FieldType,
  type IndexDefinition,
  type OperationKind,
  type PendingChange,
  type PendingOperation,
  type PendingOperationRequest,
  type SchemaPreview,
} from './client';
import { diffLabel, preconditionMessage, preconditionStatus } from './preview-copy';
import { useCollectionWorkspace } from './workspace-context';

type SchemaView = 'fields' | 'relations' | 'indexes' | 'history';
type FieldRow = FieldDefinition & { pendingOperation?: PendingOperation; original?: FieldDefinition };
type IndexRow = IndexDefinition & { pendingOperation?: PendingOperation; original?: IndexDefinition };
type Translate = ReturnType<typeof useI18n>['t'];
type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'outline';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetails(error: unknown, t: Translate, errorMessage: ReturnType<typeof useI18n>['errorMessage']) {
  if (!(error instanceof ApiClientError)) {
    return { title: t('schema.changeFailed'), message: t('common.tryAgainWhenAvailable') };
  }
  return {
    title: errorMessage(error.apiError.code) ?? t('errors.requestFailed'),
    message: [t('common.errorCode'), error.apiError.code, `${t('common.requestId')}: ${error.apiError.requestId}`, t('common.tryAgainWhenAvailable')].join(' · '),
  };
}

function operationDefinition(operation: PendingOperation): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(operation.definition));
    return isRecord(parsed) ? parsed : {};
  } catch { return {}; }
}

function projectFields(applied: FieldDefinition[], operations: PendingOperation[]): FieldRow[] {
  const fields: FieldRow[] = applied.map((field) => ({ ...field }));
  for (const operation of operations) {
    if (operation.kind !== 'field' && operation.kind !== 'relation') continue;
    const definition = operationDefinition(operation) as unknown as FieldDefinition;
    const index = fields.findIndex((field) => field.id === operation.targetId);
    if (operation.action === 'add') fields.push({ ...definition, id: operation.id, pendingOperation: operation });
    if (operation.action === 'update' && index >= 0) fields[index] = { ...fields[index], ...definition, pendingOperation: operation, original: applied.find((field) => field.id === operation.targetId) };
    if (operation.action === 'remove' && index >= 0) fields.splice(index, 1);
  }
  return fields;
}

function projectIndexes(applied: IndexDefinition[], operations: PendingOperation[]): IndexRow[] {
  const indexes: IndexRow[] = applied.map((index) => ({ ...index }));
  for (const operation of operations) {
    if (operation.kind !== 'index') continue;
    const definition = operationDefinition(operation) as unknown as IndexDefinition;
    const index = indexes.findIndex((item) => item.id === operation.targetId);
    if (operation.action === 'add') indexes.push({ ...definition, id: operation.id, pendingOperation: operation });
    if (operation.action === 'update' && index >= 0) indexes[index] = { ...indexes[index], ...definition, pendingOperation: operation, original: applied.find((item) => item.id === operation.targetId) };
    if (operation.action === 'remove' && index >= 0) indexes.splice(index, 1);
  }
  return indexes;
}

function operationKind(field: FieldDefinition): OperationKind {
  return field.type === 'relation' ? 'relation' : 'field';
}

function operationName(operation: PendingOperation, t: Translate) {
  const definition = operationDefinition(operation);
  const name = typeof definition.name === 'string' ? definition.name : operation.targetId ?? t('schema.itemFallback');
  const kind = operation.kind === 'relation' ? 'relation' : operation.kind;
  return t('schema.operation', {
    action: t(`schema.actions.${operation.action}`),
    kind: t(`schema.kinds.${kind}`),
    name,
  });
}

function preconditionTone(status: unknown): BadgeVariant {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'danger';
  return 'default';
}

function riskTone(risk: SchemaPreview['risk']): BadgeVariant {
  if (risk === 'blocked') return 'danger';
  if (risk === 'review') return 'warning';
  return 'default';
}

function previewTitle(preview: SchemaPreview, uniqueConflict: boolean, t: Translate) {
  if (preview.risk === 'blocked') return uniqueConflict ? t('schema.previewBlockedUniqueTitle') : t('schema.previewBlockedTitle');
  return t('schema.previewReviewTitle');
}

function previewBody(preview: SchemaPreview, uniqueConflict: boolean, t: Translate) {
  if (uniqueConflict) return t('schema.previewBlockedUniqueBody');
  return preview.risk === 'blocked' ? t('schema.previewBlockedBody') : t('schema.previewReviewBody');
}

// Spec 0001 §6.5：Model 统一呈现 Fields / Relations / Indexes 与同一份 durable
// Pending Changes；每个子视图共享 Collection 身份与待应用状态，不制造第二份模型。
export function CollectionSchemaPage() {
  const { t, formatDate, errorMessage } = useI18n();
  const { collection, pendingChange, refreshCollection, refreshPendingChange } = useCollectionWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get('view');
  const view: SchemaView = requestedView === 'relations' || requestedView === 'indexes' || requestedView === 'history' ? requestedView : 'fields';
  const [localPending, setLocalPending] = useState<PendingChange | null>(pendingChange);
  const [localError, setLocalError] = useState<unknown>();
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [history, setHistory] = useState<AppliedMigration[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<unknown>();
  const [historyRetryKey, setHistoryRetryKey] = useState(0);
  const [knownCollections, setKnownCollections] = useState<Collection[]>([]);
  const [knownCollectionsError, setKnownCollectionsError] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<TranslationKey | ''>('');
  const [editorKind, setEditorKind] = useState<'field' | 'relation' | 'index' | null>(null);
  const [editingOperation, setEditingOperation] = useState<PendingOperation | null>(null);
  const [editingTarget, setEditingTarget] = useState<FieldRow | IndexRow | null>(null);

  useEffect(() => setLocalPending(pendingChange), [pendingChange]);

  const operations = localPending?.operations ?? [];
  const fields = useMemo(() => projectFields(collection.fields, operations), [collection.fields, operations]);
  const indexes = useMemo(() => projectIndexes(collection.indexes ?? [], operations), [collection.indexes, operations]);
  const relations = fields.filter((field) => field.type === 'relation');

  useEffect(() => {
    if (view !== 'history') return;
    const controller = new AbortController();
    setHistoryLoading(true);
    void listSchemaHistory(collection.id, { limit: 50 }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setHistory(page.data);
      setHistoryCursor(page.nextCursor);
      setHistoryError(undefined);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setHistoryError(error); }).finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [collection.id, historyRetryKey, view]);

  useEffect(() => {
    if (view !== 'relations') return;
    const controller = new AbortController();
    void listAllCollections(controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setKnownCollections(items);
      setKnownCollectionsError(false);
    }).catch(() => { if (!controller.signal.aborted) setKnownCollectionsError(true); });
    return () => controller.abort();
  }, [collection.id, view]);

  function selectView(next: SchemaView) {
    const query = new URLSearchParams(searchParams);
    if (next === 'fields') query.delete('view');
    else query.set('view', next);
    setSearchParams(query, { replace: true });
    setEditorKind(null);
    setEditingOperation(null);
    setEditingTarget(null);
  }

  async function saveOperation(input: PendingOperationRequest, pendingOperation?: PendingOperation) {
    setWorking(true);
    setLocalError(undefined);
    setNotice('');
    try {
      const updated = pendingOperation
        ? await updatePendingOperation(collection.id, pendingOperation.id, input)
        : await savePendingOperation(collection.id, input);
      setLocalPending(updated);
      setPreview(null);
      setLocalPending(await refreshPendingChange());
      setNotice('schema.noticeSaved');
      setEditorKind(null);
      setEditingOperation(null);
      setEditingTarget(null);
    } catch (error) { setLocalError(error); }
    finally { setWorking(false); }
  }

  async function removeOperation(operation: PendingOperation) {
    setWorking(true);
    setLocalError(undefined);
    try {
      await removePendingOperation(collection.id, operation.id);
      const refreshed = await refreshPendingChange();
      setLocalPending(refreshed);
      setPreview(null);
      setNotice('schema.noticeRemoved');
    } catch (error) { setLocalError(error); }
    finally { setWorking(false); }
  }

  async function stageRemoval(row: FieldRow | IndexRow, kind: OperationKind) {
    if (row.pendingOperation) {
      await removeOperation(row.pendingOperation);
      return;
    }
    if (!row.id) return;
    await saveOperation({ kind, action: 'remove', targetId: row.id, definition: {} });
  }

  async function loadHistoryMore() {
    if (!historyCursor || historyLoading) return;
    setHistoryLoading(true);
    try {
      const page = await listSchemaHistory(collection.id, { limit: 50, cursor: historyCursor });
      setHistory((items) => [...items, ...page.data]);
      setHistoryCursor(page.nextCursor);
    } catch (error) { setHistoryError(error); }
    finally { setHistoryLoading(false); }
  }

  async function refreshModel() {
    const [, refreshed] = await Promise.all([refreshCollection(), refreshPendingChange()]);
    setLocalPending(refreshed);
  }

  async function applyAfterPreview(result: SchemaPreview, confirmRisk: boolean) {
    if (!localPending) return;
    setWorking(true);
    setLocalError(undefined);
    try {
      const applied = await applySchemaChange(collection.id, result.version ?? localPending.version, confirmRisk);
      if (applied.state === 'recoveryRequired') {
        setNotice('schema.noticeRecovery');
        setPreview(null);
        await refreshModel();
      } else {
        setNotice('schema.noticeApplied');
        setPreview(null);
        setLocalPending(null);
        await refreshModel();
        if (view === 'history') {
          const page = await listSchemaHistory(collection.id, { limit: 50 });
          setHistory(page.data);
          setHistoryCursor(page.nextCursor);
        }
      }
    } catch (error) {
      setLocalError(error);
      setPreview(null);
      try { await refreshModel(); } catch (refreshError) { setLocalError(refreshError); }
    }
    finally { setWorking(false); }
  }

  async function previewAndApply() {
    if (!localPending) return;
    setWorking(true);
    setLocalError(undefined);
    setNotice('');
    try {
      const result = await previewSchemaChange(collection.id, localPending.version);
      setPreview(result);
      if (result.risk === 'safe') await applyAfterPreview(result, false);
    } catch (error) { setLocalError(error); }
    finally { setWorking(false); }
  }

  async function discard() {
    if (!localPending) return;
    setWorking(true);
    setLocalError(undefined);
    setNotice('');
    try {
      await discardSchemaChange(collection.id, localPending.version);
      setLocalPending(null);
      setPreview(null);
      await refreshModel();
      setNotice('schema.noticeDiscarded');
    } catch (error) { setLocalError(error); }
    finally { setWorking(false); }
  }

  const pendingStatusKey: TranslationKey = localPending?.status === 'needsReview'
    ? 'schema.statusNeedsReview'
    : localPending?.status === 'failed' ? 'schema.statusRecoveryNeeded' : 'schema.statusReady';
  const pendingTone: BadgeVariant = localPending?.status === 'failed' ? 'danger' : localPending?.status === 'needsReview' ? 'warning' : 'default';

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{t('schema.eyebrow')}</p>
          <h2>{t('schema.title')}</h2>
          <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('schema.description')}</p>
        </div>
        <Badge variant="outline">{t('schema.modelVersion', { version: collection.schemaVersion ?? 1 })}</Badge>
      </header>

      <nav aria-label={t('schema.viewsLabel')} className="flex gap-1 overflow-x-auto border-b">
        {(['fields', 'relations', 'indexes', 'history'] as const).map((tab) => (
          <button
            aria-current={view === tab ? 'page' : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${view === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            key={tab}
            onClick={() => selectView(tab)}
            type="button"
          >{t(`schema.views.${tab}`)}</button>
        ))}
      </nav>

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border bg-secondary px-3.5 py-2.5 text-xs text-ink-secondary" role="status">
          <Check aria-hidden="true" className="shrink-0 text-success" size={15} />
          {t(notice)}
        </div>
      )}
      {localError !== undefined && (() => {
        const copy = errorDetails(localError, t, errorMessage);
        return (
          <ErrorState description={copy.message} title={copy.title}>
            <div className="mt-3"><Button onClick={() => void refreshModel()} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('schema.refreshStatus')}</Button></div>
          </ErrorState>
        );
      })()}

      {view === 'fields' && (
        <section aria-labelledby="schema-view-heading" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-ink-secondary"><Layers3 size={16} /></span>
              <div>
                <h3 id="schema-view-heading">{t('schema.fieldsTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t(fields.length === 1 ? 'schema.fieldsSummaryOne' : 'schema.fieldsSummaryMany', { count: fields.length })}</p>
              </div>
            </div>
            <Button onClick={() => { setEditorKind('field'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />{t('schema.addField')}</Button>
          </div>
          {fields.length === 0 ? <EmptyState description={t('schema.noFieldsDescription')} title={t('schema.noFieldsTitle')} /> : (
            <Table>
              <TableCaption>{t('schema.fieldsCaption', { name: collection.name })}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('schema.columnField')}</TableHead>
                  <TableHead scope="col">{t('schema.columnType')}</TableHead>
                  <TableHead scope="col">{t('schema.columnRequired')}</TableHead>
                  <TableHead scope="col">{t('schema.columnUnique')}</TableHead>
                  <TableHead scope="col">{t('schema.columnStatus')}</TableHead>
                  <TableHead scope="col"><span className="sr-only">{t('schema.columnActions')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map((field) => (
                  <TableRow key={field.id ?? field.name}>
                    <TableHead className="bg-transparent" scope="row">
                      <strong className="block font-semibold text-foreground">{field.name}</strong>
                      {field.description && <small className="block text-[11px] font-normal text-muted-foreground">{field.description}</small>}
                    </TableHead>
                    <TableCell>{t(`schema.fieldTypes.${field.type}`)}</TableCell>
                    <TableCell>{t(field.required ? 'common.yes' : 'common.no')}</TableCell>
                    <TableCell>{t(field.unique ? 'common.yes' : 'common.no')}</TableCell>
                    <TableCell>
                      {field.system
                        ? <Badge variant="outline"><ShieldCheck aria-hidden="true" size={12} />{t('schema.systemLocked')}</Badge>
                        : field.pendingOperation
                          ? <Badge variant="default">{t('schema.statusPending')}</Badge>
                          : <span className="text-xs text-muted-foreground">{t('schema.statusApplied')}</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {!field.system && field.pendingOperation && <Button onClick={() => void removeOperation(field.pendingOperation!)} size="small" type="button" variant="quiet">{t('schema.undo')}</Button>}
                        {!field.system && field.id && !field.pendingOperation && <>
                          <Button onClick={() => { setEditorKind(field.type === 'relation' ? 'relation' : 'field'); setEditingTarget(field); setEditingOperation(operations.find((operation) => operation.targetId === field.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">{t('schema.edit')}</Button>
                          <Button aria-label={t('schema.removeField', { name: field.name })} onClick={() => void stageRemoval(field, operationKind(field))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button>
                        </>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}

      {view === 'relations' && (
        <section aria-labelledby="schema-view-heading" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-ink-secondary"><GitBranch size={16} /></span>
              <div>
                <h3 id="schema-view-heading">{t('schema.relationsTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t('schema.relationsDescription')}</p>
              </div>
            </div>
            <Button onClick={() => { setEditorKind('relation'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />{t('schema.addRelation')}</Button>
          </div>
          {knownCollectionsError && <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning" role="status">{t('schema.referencesUnavailable')}</div>}
          {relations.length === 0 ? <EmptyState description={t('schema.noRelationsDescription')} title={t('schema.noRelationsTitle')} /> : (
            <Table>
              <TableCaption>{t('schema.relationsCaption', { name: collection.name })}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('schema.columnRelation')}</TableHead>
                  <TableHead scope="col">{t('schema.columnTarget')}</TableHead>
                  <TableHead scope="col">{t('schema.columnCardinality')}</TableHead>
                  <TableHead scope="col">{t('schema.columnStatus')}</TableHead>
                  <TableHead scope="col"><span className="sr-only">{t('schema.columnActions')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {relations.map((field) => (
                  <TableRow key={field.id}>
                    <TableHead className="bg-transparent" scope="row"><strong className="font-semibold text-foreground">{field.name}</strong></TableHead>
                    <TableCell>{knownCollections.find((item) => item.id === field.relation?.targetCollectionId)?.name ?? t('schema.targetUnavailable')}</TableCell>
                    <TableCell>{field.relation?.cardinality ?? t('schema.notConfigured')}</TableCell>
                    <TableCell>{field.system ? t('schema.systemLocked') : field.pendingOperation ? <Badge variant="default">{t('schema.statusPending')}</Badge> : t('schema.statusApplied')}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {field.pendingOperation && <Button onClick={() => void removeOperation(field.pendingOperation!)} size="small" type="button" variant="quiet">{t('schema.undo')}</Button>}
                        {field.id && !field.system && !field.pendingOperation && <>
                          <Button onClick={() => { setEditorKind('relation'); setEditingTarget(field); setEditingOperation(operations.find((operation) => operation.targetId === field.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">{t('schema.edit')}</Button>
                          <Button aria-label={t('schema.removeField', { name: field.name })} onClick={() => void stageRemoval(field, 'relation')} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button>
                        </>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}

      {view === 'indexes' && (
        <section aria-labelledby="schema-view-heading" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-ink-secondary"><Database size={16} /></span>
              <div>
                <h3 id="schema-view-heading">{t('schema.indexesTitle')}</h3>
                <p className="text-xs text-muted-foreground">{t('schema.indexesDescription')}</p>
              </div>
            </div>
            <Button onClick={() => { setEditorKind('index'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />{t('schema.addIndex')}</Button>
          </div>
          {indexes.length === 0 ? <EmptyState description={t('schema.noIndexesDescription')} title={t('schema.noIndexesTitle')} /> : (
            <Table>
              <TableCaption>{t('schema.indexesCaption', { name: collection.name })}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('schema.columnIndex')}</TableHead>
                  <TableHead scope="col">{t('schema.columnFields')}</TableHead>
                  <TableHead scope="col">{t('schema.columnUnique')}</TableHead>
                  <TableHead scope="col">{t('schema.columnStatus')}</TableHead>
                  <TableHead scope="col"><span className="sr-only">{t('schema.columnActions')}</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {indexes.map((index) => (
                  <TableRow key={index.id ?? index.name}>
                    <TableHead className="bg-transparent" scope="row"><strong className="font-semibold text-foreground">{index.name}</strong></TableHead>
                    <TableCell>{index.fields.map((id) => fields.find((field) => field.id === id)?.name ?? id).join(', ')}</TableCell>
                    <TableCell>{t(index.unique ? 'common.yes' : 'common.no')}</TableCell>
                    <TableCell>{index.pendingOperation ? <Badge variant="default">{t('schema.statusPending')}</Badge> : t('schema.statusApplied')}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {index.pendingOperation && <Button onClick={() => void removeOperation(index.pendingOperation!)} size="small" type="button" variant="quiet">{t('schema.undo')}</Button>}
                        {index.id && !index.pendingOperation && <>
                          <Button onClick={() => { setEditorKind('index'); setEditingTarget(index); setEditingOperation(operations.find((operation) => operation.targetId === index.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">{t('schema.edit')}</Button>
                          <Button aria-label={t('schema.removeIndex', { name: index.name })} onClick={() => void stageRemoval(index, 'index')} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button>
                        </>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}

      {editorKind && <SchemaEditor
        collectionId={collection.id}
        editingOperation={editingOperation}
        editingTarget={editingTarget}
        fields={fields}
        kind={editorKind}
        onCancel={() => { setEditorKind(null); setEditingOperation(null); setEditingTarget(null); }}
        onSave={(input, operation) => void saveOperation(input, operation)}
        pendingOperations={operations}
        working={working}
      />}

      {view === 'history' && (
        <section className="flex min-w-0 flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-ink-secondary"><Clock3 size={16} /></span>
            <div>
              <h3>{t('schema.historyTitle')}</h3>
              <p className="text-xs text-muted-foreground">{t('schema.historyDescription')}</p>
            </div>
          </div>
          {historyLoading && history.length === 0 && <LoadingState label={t('schema.historyLoading')} />}
          {historyError !== undefined && (() => {
            const copy = errorDetails(historyError, t, errorMessage);
            return (
              <ErrorState description={copy.message} title={copy.title}>
                <div className="mt-3"><Button onClick={() => { setHistoryError(undefined); setHistoryRetryKey((value) => value + 1); }} size="small">{t('common.retry')}</Button></div>
              </ErrorState>
            );
          })()}
          {!historyLoading && !historyError && history.length === 0 && <EmptyState description={t('schema.historyEmptyDescription')} title={t('schema.historyEmptyTitle')} />}
          {history.length > 0 && (
            <ol className="flex min-w-0 flex-col gap-3">
              {history.map((entry) => {
                const changes = entry.diff?.length ?? 0;
                return (
                  <li className="flex min-w-0 gap-3 rounded-lg border bg-card p-3.5" key={entry.id}>
                    <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><Check size={14} /></span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong className="text-xs font-semibold text-foreground">{t('schema.historyApplied')}</strong>
                        <time className="text-[11px] text-muted-foreground" dateTime={entry.appliedAt}>{formatDate(entry.appliedAt)}</time>
                      </div>
                      <span className="text-xs text-muted-foreground">{t(changes === 1 ? 'schema.historySummaryOne' : 'schema.historySummaryMany', { count: changes, version: (collection.schemaVersion ?? 1) - Math.max(0, history.indexOf(entry)) })}</span>
                      <details className="text-[11px] text-muted-foreground [&_dl]:mt-2 [&_dl]:grid [&_dl]:gap-1 [&_pre]:mt-1.5 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:text-[10px] [&_summary]:w-fit [&_summary]:cursor-pointer [&_summary]:font-semibold [&_summary:hover]:text-foreground">
                        <summary>{t('schema.technicalDetails')}</summary>
                        <dl>
                          <div className="flex gap-2"><dt className="font-semibold">{t('schema.changeId')}</dt><dd className="m-0"><code>{entry.changeSetId}</code></dd></div>
                          <div className="flex gap-2"><dt className="font-semibold">{t('schema.appliedModelRecord')}</dt><dd className="m-0"><code>{entry.id}</code></dd></div>
                          <div className="flex gap-2"><dt className="font-semibold">{t('schema.applyAttempt')}</dt><dd className="m-0"><code>{entry.applyAttemptId}</code></dd></div>
                        </dl>
                        {entry.diff?.map((diff, index) => <pre key={index}>{JSON.stringify(diff, null, 2)}</pre>)}
                      </details>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {historyCursor && <div><Button disabled={historyLoading} onClick={() => void loadHistoryMore()} size="small">{historyLoading ? t('common.loading') : t('schema.loadOlder')}</Button></div>}
        </section>
      )}

      {localPending && localPending.operations.length > 0 && (
        <section aria-label={t('schema.pendingPanelLabel')} className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid size-8 place-items-center rounded-lg bg-muted text-ink-secondary"><Save size={16} /></span>
              <div>
                <strong className="block text-xs font-semibold text-foreground">{t(localPending.operations.length === 1 ? 'schema.pendingOne' : 'schema.pendingMany', { count: localPending.operations.length })}</strong>
                <span className="text-[11px] text-muted-foreground">{t('schema.pendingSavedFor', { version: localPending.version })}</span>
              </div>
            </div>
            <Badge variant={pendingTone}>{t(pendingStatusKey)}</Badge>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {localPending.operations.map((operation) => (
              <li className="flex items-center justify-between gap-3 rounded-md border bg-secondary px-3 py-2 text-xs" key={operation.id}>
                <span className="min-w-0 truncate text-ink-secondary">{operationName(operation, t)}</span>
                <Button aria-label={t('schema.removeOperation', { name: operationName(operation, t) })} disabled={working} onClick={() => void removeOperation(operation)} size="small" type="button" variant="quiet"><X aria-hidden="true" size={14} />{t('schema.undo')}</Button>
              </li>
            ))}
          </ul>
          {localPending.status === 'failed' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-xs text-danger">
              <AlertTriangle aria-hidden="true" className="shrink-0" size={15} />
              <div className="min-w-0 flex-1">
                <strong className="block">{t('schema.recoveryTitle')}</strong>
                <span className="opacity-90">{t('schema.recoveryFallback')}</span>
              </div>
              <Link className="font-semibold hover:underline" to={`/changes?changeSet=${encodeURIComponent(localPending.changeSetId)}`}>{t('schema.openRecovery')} <ArrowRight aria-hidden="true" size={13} /></Link>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={working} onClick={() => void discard()} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} />{t('schema.discard')}</Button>
            <Button disabled={working} onClick={() => void previewAndApply()} size="small" type="button" variant="primary">
              {working ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={14} />{t('schema.working')}</> : localPending.status === 'failed' ? t('schema.reviewAndRetry') : t('schema.reviewAndApply')}
              <ArrowRight aria-hidden="true" size={14} />
            </Button>
          </div>
        </section>
      )}
      {preview && preview.risk !== 'safe' && <PreviewPanel preview={preview} working={working} onAttempt={() => void applyAfterPreview(preview, true)} onCancel={() => setPreview(null)} onConfirm={() => void applyAfterPreview(preview, true)} />}
    </div>
  );
}

function SchemaEditor({
  collectionId, editingOperation, editingTarget, fields, kind, onCancel, onSave, pendingOperations, working,
}: {
  collectionId: string;
  editingOperation: PendingOperation | null;
  editingTarget: FieldRow | IndexRow | null;
  fields: FieldRow[];
  kind: 'field' | 'relation' | 'index';
  onCancel: () => void;
  onSave: (input: PendingOperationRequest, operation?: PendingOperation) => void;
  pendingOperations: PendingOperation[];
  working: boolean;
}) {
  const { t } = useI18n();
  const { collection } = useCollectionWorkspace();
  const field = kind === 'index' ? undefined : editingTarget as FieldRow | null;
  const index = kind === 'index' ? editingTarget as IndexRow | null : undefined;
  const initialDefinition: Record<string, unknown> = editingOperation
    ? operationDefinition(editingOperation)
    : editingTarget ? { ...editingTarget } : {};
  const [name, setName] = useState(typeof initialDefinition.name === 'string' ? initialDefinition.name : '');
  const [type, setType] = useState<FieldType>(typeof initialDefinition.type === 'string' ? initialDefinition.type as FieldType : kind === 'relation' ? 'relation' : 'text');
  const [required, setRequired] = useState(initialDefinition.required === true);
  const [unique, setUnique] = useState(initialDefinition.unique === true);
  const [description, setDescription] = useState(typeof initialDefinition.description === 'string' ? initialDefinition.description : '');
  const relation = isRecord(initialDefinition.relation) ? initialDefinition.relation : {};
  const [targetCollectionId, setTargetCollectionId] = useState(typeof relation.targetCollectionId === 'string' ? relation.targetCollectionId : '');
  const [cardinality, setCardinality] = useState(typeof relation.cardinality === 'string' ? relation.cardinality : 'many-to-one');
  const [selectedFields, setSelectedFields] = useState<string[]>(Array.isArray(initialDefinition.fields) ? initialDefinition.fields.filter((value): value is string => typeof value === 'string') : []);
  const [validation, setValidation] = useState(initialDefinition.validation ? JSON.stringify(initialDefinition.validation) : '');
  const [defaultValue, setDefaultValue] = useState(initialDefinition.default === undefined ? '' : JSON.stringify(initialDefinition.default));
  const [formError, setFormError] = useState<TranslationKey | ''>('');
  const [targetCollections, setTargetCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [targetError, setTargetError] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const isUpdating = Boolean(field?.id || index?.id);

  useEffect(() => {
    if (kind !== 'relation') return;
    const controller = new AbortController();
    setLoadingTargets(true);
    void listAllCollections(controller.signal).then((items) => {
      if (controller.signal.aborted) return;
      setTargetCollections(items.filter((item) => item.id !== collectionId).map((item) => ({ id: item.id, name: item.name })));
      setTargetError(false);
    }).catch(() => { if (!controller.signal.aborted) setTargetError(true); }).finally(() => { if (!controller.signal.aborted) setLoadingTargets(false); });
    return () => controller.abort();
  }, [collectionId, kind]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(cleanName)) { setFormError('schema.errorName'); return; }
    const reserved = new Set(['id', 'createdat', 'updatedat', 'password', ...(collection.type === 'Auth' ? ['email'] : [])]);
    if (kind !== 'index' && reserved.has(cleanName.toLowerCase()) && cleanName.toLowerCase() !== field?.name.toLowerCase()) { setFormError('schema.errorReserved'); return; }
    const definition: Record<string, unknown> = kind === 'index' ? { name: cleanName, fields: selectedFields, unique } : { name: cleanName, type: kind === 'relation' ? 'relation' : type, required, unique, ...(description.trim() ? { description: description.trim() } : {}) };
    if (kind === 'index' && selectedFields.length === 0) { setFormError('schema.errorIndexFields'); return; }
    if (kind === 'relation') {
      if (!targetCollectionId) { setFormError('schema.errorTarget'); return; }
      definition.relation = { targetCollectionId, cardinality };
    }
    if (kind !== 'index') {
      if (validation.trim()) {
        try {
          const parsed: unknown = JSON.parse(validation);
          if (!isRecord(parsed)) throw new Error();
          definition.validation = parsed;
        } catch { setFormError('schema.errorValidation'); return; }
      }
      if (defaultValue.trim()) {
        try { definition.default = JSON.parse(defaultValue); }
        catch { setFormError('schema.errorDefault'); return; }
      }
    }
    const kindForRequest: OperationKind = kind === 'relation' ? 'relation' : kind;
    const match = editingOperation ?? pendingOperations.find((operation) => operation.targetId === (field?.id ?? index?.id) && operation.action === 'update');
    const targetId = (field?.original?.id ?? field?.id ?? index?.original?.id ?? index?.id);
    const action = match?.action ?? (isUpdating ? 'update' : 'add');
    onSave({ kind: kindForRequest, action, ...(targetId && action !== 'add' ? { targetId } : {}), definition }, match ?? undefined);
  }

  return (
    <Surface className="p-4" variant="raised">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{t('schema.editorEyebrow')}</p>
          <h3>{t(isUpdating ? 'schema.editorEditTitle' : 'schema.editorAddTitle', { kind: t(`schema.kinds.${kind}`) })}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('schema.editorDescription')}</p>
        </div>
        <Button aria-label={t('schema.closeEditor')} onClick={onCancel} size="small" type="button" variant="quiet"><X aria-hidden="true" size={15} /></Button>
      </div>
      <form className="mt-4 flex flex-col gap-3.5" noValidate onSubmit={submit}>
        <div className="grid gap-3.5 md:grid-cols-2">
          <FormField htmlFor="schema-edit-name" label={t(kind === 'index' ? 'schema.indexName' : 'schema.fieldName')}><input autoComplete="off" id="schema-edit-name" onChange={(event) => { setName(event.target.value); setFormError(''); }} value={name} /></FormField>
          {kind === 'index' ? <FormField htmlFor="schema-index-fields" label={t('schema.columnFields')}><select id="schema-index-fields" multiple onChange={(event) => setSelectedFields(Array.from(event.target.selectedOptions, (option) => option.value))} value={selectedFields}>{fields.filter((item) => !item.system).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField> : <FormField htmlFor="schema-edit-type" label={t('schema.columnType')}><select disabled={kind === 'relation'} id="schema-edit-type" onChange={(event) => setType(event.target.value as FieldType)} value={kind === 'relation' ? 'relation' : type}>{(['text', 'number', 'boolean', 'dateTime', 'json', 'relation', 'file', 'files'] as const).map((option) => <option key={option} value={option}>{t(`schema.fieldTypes.${option}`)}</option>)}</select></FormField>}
        </div>
        {kind === 'relation' && <div className="grid gap-3.5 md:grid-cols-2"><FormField htmlFor="schema-target" label={t('schema.targetCollection')}><select id="schema-target" onChange={(event) => setTargetCollectionId(event.target.value)} value={targetCollectionId}><option value="">{loadingTargets ? t('schema.targetLoading') : t('schema.chooseCollection')}</option>{targetCollections.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select>{targetError && <span className="text-[11px] text-danger">{t('schema.targetLoadFailed')}</span>}</FormField><FormField htmlFor="schema-cardinality" label={t('schema.cardinality')}><select id="schema-cardinality" onChange={(event) => setCardinality(event.target.value)} value={cardinality}>{(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many'] as const).map((option) => <option key={option} value={option}>{t(`schema.cardinalities.${option}`)}</option>)}</select></FormField></div>}
        {kind !== 'index' && <div className="flex flex-wrap items-center gap-4 text-xs text-ink-secondary"><label className="inline-flex items-center gap-2"><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" />{t('schema.required')}</label><label className="inline-flex items-center gap-2"><input checked={unique} disabled={type === 'files'} onChange={(event) => setUnique(event.target.checked)} type="checkbox" />{t('schema.unique')}</label>{type === 'files' && <span className="text-[11px] text-muted-foreground">{t('schema.filesCannotBeUnique')}</span>}</div>}
        {kind === 'index' && <label className="inline-flex w-fit items-center gap-2 text-xs text-ink-secondary"><input checked={unique} onChange={(event) => setUnique(event.target.checked)} type="checkbox" />{t('schema.uniqueIndex')}</label>}
        {kind !== 'index' && <details className="rounded-lg border bg-card px-3.5 py-2.5 text-xs [&[open]>summary]:mb-3"><summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-ink-secondary"><ChevronDown aria-hidden="true" size={14} />{t('schema.advancedSummary')}</summary><div className="grid gap-3.5 md:grid-cols-2"><FormField htmlFor="schema-edit-description" label={t('schema.fieldDescription')}><input id="schema-edit-description" onChange={(event) => setDescription(event.target.value)} value={description} /></FormField><FormField htmlFor="schema-edit-default" label={t('schema.defaultValue')}><input id="schema-edit-default" onChange={(event) => setDefaultValue(event.target.value)} value={defaultValue} /></FormField><FormField htmlFor="schema-edit-validation" hint={(type === 'file' || type === 'files') ? t('schema.fileValidationHint') : undefined} label={t('schema.validation')}><textarea id="schema-edit-validation" onChange={(event) => setValidation(event.target.value)} rows={3} value={validation} /></FormField></div></details>}
        {formError && <p className="text-[11px] font-semibold text-danger" role="alert">{t(formError)}</p>}
        <div className="flex flex-wrap justify-end gap-2"><Button onClick={onCancel} type="button" variant="quiet">{t('common.cancel')}</Button><Button disabled={working || loadingTargets && kind === 'relation'} type="submit" variant="primary">{working ? t('schema.saving') : t('schema.save')}<Save aria-hidden="true" size={14} /></Button></div>
      </form>
    </Surface>
  );
}

function PreviewPanel({ preview, working, onCancel, onConfirm, onAttempt }: { preview: SchemaPreview; working: boolean; onCancel: () => void; onConfirm: () => void; onAttempt: () => void }) {
  const { t, formatNumber } = useI18n();
  const impact = preview.impact;
  const summary = typeof impact.summary === 'string' ? impact.summary : '';
  const rowsAffected = typeof impact.affectedRecords === 'number' ? impact.affectedRecords : undefined;
  const uniqueConflict = preview.risk === 'blocked' && preview.preconditions.some((item) => item.code === 'UNIQUE_VALUES_CONFLICT' && item.status === 'failed');
  return (
    <section aria-labelledby="schema-preview-title" className={`flex min-w-0 flex-col gap-3.5 rounded-lg border p-4 ${preview.risk === 'blocked' ? 'border-danger/40 bg-danger-soft' : 'border-warning/40 bg-warning-soft'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-ink-secondary">{preview.risk === 'blocked' ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}</span>
          <div className="min-w-0">
            <p className="eyebrow">{t('schema.previewEyebrow')}</p>
            <h3 id="schema-preview-title">{previewTitle(preview, uniqueConflict, t)}</h3>
            <p className="mt-1 text-xs text-ink-secondary">{previewBody(preview, uniqueConflict, t)}</p>
          </div>
        </div>
        <Badge variant={riskTone(preview.risk)}>{preview.risk === 'review' ? t('schema.riskReview') : t('schema.riskBlocked')}</Badge>
      </div>
      {preview.diff.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="m-0 text-xs font-semibold text-foreground">{t('schema.whatWillChange')}</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {preview.diff.map((change, index) => (
              <li className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs" key={index}>
                <span aria-hidden="true" className="font-mono font-bold text-ink-secondary">{change.action === 'remove' ? '−' : change.action === 'update' ? '~' : '+'}</span>
                <span className="min-w-0 truncate text-ink-secondary">{diffLabel(change, t)}</span>
                <code className="ml-auto text-[10px] text-muted-foreground">{String(change.kind ?? '')}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs">
        <strong className="font-semibold text-foreground">{t('schema.impact')}</strong>
        <span className="text-ink-secondary">{summary || t('schema.impactFallback')}</span>
        {rowsAffected !== undefined && <span className="text-muted-foreground">{t('schema.recordsAffected', { count: formatNumber(rowsAffected) })}</span>}
      </div>
      {preview.preconditions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="m-0 text-xs font-semibold text-foreground">{t('schema.checks')}</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {preview.preconditions.map((condition, index) => (
              <li className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs" key={index}>
                <span className="min-w-0 text-ink-secondary">{preconditionMessage(condition.code, t)}{typeof condition.code === 'string' && <> <code className="text-[10px] text-muted-foreground">{condition.code}</code></>}</span>
                <span className="ml-auto"><Badge variant={preconditionTone(condition.status)}>{preconditionStatus(condition.status, t)}</Badge></span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={working} onClick={onCancel} type="button" variant="quiet">{t('common.cancel')}</Button>
        {uniqueConflict && <Button disabled={working} onClick={onAttempt} type="button" variant="primary">{working ? t('schema.applying') : t('schema.attemptApply')}<ArrowRight aria-hidden="true" size={14} /></Button>}
        {preview.risk === 'review' && <Button disabled={working} onClick={onConfirm} type="button" variant="primary">{working ? t('schema.applying') : t('schema.confirmAndApply')}<ArrowRight aria-hidden="true" size={14} /></Button>}
      </div>
    </section>
  );
}
