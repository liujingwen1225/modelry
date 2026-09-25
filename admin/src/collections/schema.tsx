import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Clock3, Database, GitBranch, Layers3, LoaderCircle, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
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
import { useCollectionWorkspace } from './workspace-context';

type SchemaView = 'fields' | 'relations' | 'indexes' | 'history';
type FieldRow = FieldDefinition & { pendingOperation?: PendingOperation; original?: FieldDefinition };
type IndexRow = IndexDefinition & { pendingOperation?: PendingOperation; original?: IndexDefinition };
type Translate = ReturnType<typeof useI18n>['t'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetails(error: unknown, t: Translate) {
  if (!(error instanceof ApiClientError)) {
    return { title: t('schema.changeFailed'), message: error instanceof Error ? error.message : t('common.tryAgainWhenAvailable') };
  }
  return {
    title: error.apiError.message,
    message: [error.apiError.code, error.apiError.hint, `${t('common.requestId')}: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
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
    action: t(`schema.actions.${operation.action as 'add' | 'update' | 'remove'}`),
    kind: t(`schema.kinds.${kind as 'field' | 'relation' | 'index'}`),
    name,
  });
}

function diffLabel(change: Record<string, unknown>, t: Translate) {
  if (typeof change.name === 'string') return change.name;
  const kind = String(change.kind ?? '');
  const action = String(change.action ?? '');
  return kind && action ? t('schema.changeFallback', { kind, action }) : t('schema.itemFallback');
}

function resultChipState(state: string) {
  return state === 'review' ? 'pending' : state;
}

function previewTitle(preview: SchemaPreview, uniqueConflict: boolean, t: Translate) {
  if (preview.risk === 'blocked') return uniqueConflict ? t('schema.previewBlockedUniqueTitle') : t('schema.previewBlockedTitle');
  return t('schema.previewReviewTitle');
}

function previewBody(preview: SchemaPreview, uniqueConflict: boolean, t: Translate) {
  if (uniqueConflict) return t('schema.previewBlockedUniqueBody');
  return preview.risk === 'blocked' ? t('schema.previewBlockedBody') : t('schema.previewReviewBody');
}

export function CollectionSchemaPage() {
  const { t, formatDate } = useI18n();
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

  return (
    <div className="schema-workspace">
      <div className="schema-page-heading"><div><p className="eyebrow">{t('schema.eyebrow')}</p><h2>{t('schema.title')}</h2><p>{t('schema.description')}</p></div><span className="schema-version">{t('schema.modelVersion', { version: collection.schemaVersion ?? 1 })}</span></div>
      <nav aria-label={t('schema.viewsLabel')} className="schema-tabs">
        {(['fields', 'relations', 'indexes', 'history'] as const).map((tab) => <button aria-current={view === tab ? 'page' : undefined} className={view === tab ? 'is-active' : ''} key={tab} onClick={() => selectView(tab)} type="button">{t(`schema.views.${tab}`)}</button>)}
      </nav>
      {notice && <div className="schema-notice" role="status"><Check aria-hidden="true" size={15} />{t(notice)}</div>}
      {localError !== undefined && (() => { const copy = errorDetails(localError, t); return <ErrorState className="schema-error" description={copy.message} title={copy.title}><Button onClick={() => void refreshModel()} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('schema.refreshStatus')}</Button></ErrorState>; })()}
      {view === 'fields' && <section aria-labelledby="schema-view-heading" className="schema-panel">
        <div className="schema-panel-heading"><div><span className="schema-panel-icon"><Layers3 aria-hidden="true" size={16} /></span><div><h3 id="schema-view-heading">{t('schema.fieldsTitle')}</h3><p>{t(fields.length === 1 ? 'schema.fieldsSummaryOne' : 'schema.fieldsSummaryMany', { count: fields.length })}</p></div></div><Button onClick={() => { setEditorKind('field'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />{t('schema.addField')}</Button></div>
        {fields.length === 0 ? <EmptyState description={t('schema.noFieldsDescription')} title={t('schema.noFieldsTitle')} /> : <div className="schema-table-wrap"><table className="schema-table"><caption>{t('schema.fieldsCaption', { name: collection.name })}</caption><thead><tr><th scope="col">{t('schema.columnField')}</th><th scope="col">{t('schema.columnType')}</th><th scope="col">{t('schema.columnRequired')}</th><th scope="col">{t('schema.columnUnique')}</th><th scope="col">{t('schema.columnStatus')}</th><th scope="col"><span className="sr-only">{t('schema.columnActions')}</span></th></tr></thead><tbody>
          {fields.map((field) => <tr key={field.id ?? field.name}>
            <th scope="row"><strong>{field.name}</strong>{field.description && <small>{field.description}</small>}</th><td>{t(`schema.fieldTypes.${field.type}`)}</td><td>{t(field.required ? 'common.yes' : 'common.no')}</td><td>{t(field.unique ? 'common.yes' : 'common.no')}</td><td>{field.system ? <span className="schema-locked">{t('schema.systemLocked')}</span> : field.pendingOperation ? <StatusChip state="pending">{t('schema.statusPending')}</StatusChip> : <span className="schema-current">{t('schema.statusApplied')}</span>}</td>
            <td className="schema-actions">{!field.system && field.pendingOperation ? <Button onClick={() => void removeOperation(field.pendingOperation!)} size="small" type="button" variant="quiet">{t('schema.undo')}</Button> : !field.system && field.id && <><Button onClick={() => { setEditorKind(field.type === 'relation' ? 'relation' : 'field'); setEditingTarget(field); setEditingOperation(operations.find((operation) => operation.targetId === field.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">{t('schema.edit')}</Button><Button aria-label={t('schema.removeField', { name: field.name })} onClick={() => void stageRemoval(field, operationKind(field))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button></>}</td>
          </tr>)}
        </tbody></table></div>}
      </section>}

      {view === 'relations' && <section aria-labelledby="schema-view-heading" className="schema-panel">
        <div className="schema-panel-heading"><div><span className="schema-panel-icon schema-panel-icon--violet"><GitBranch aria-hidden="true" size={16} /></span><div><h3 id="schema-view-heading">{t('schema.relationsTitle')}</h3><p>{t('schema.relationsDescription')}</p></div></div><Button onClick={() => { setEditorKind('relation'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />{t('schema.addRelation')}</Button></div>
        {knownCollectionsError && <div className="collection-inline-warning" role="status">{t('schema.referencesUnavailable')}</div>}
        {relations.length === 0 ? <EmptyState description={t('schema.noRelationsDescription')} title={t('schema.noRelationsTitle')} /> : <div className="schema-table-wrap"><table className="schema-table"><caption>{t('schema.relationsCaption', { name: collection.name })}</caption><thead><tr><th scope="col">{t('schema.columnRelation')}</th><th scope="col">{t('schema.columnTarget')}</th><th scope="col">{t('schema.columnCardinality')}</th><th scope="col">{t('schema.columnStatus')}</th><th scope="col"><span className="sr-only">{t('schema.columnActions')}</span></th></tr></thead><tbody>{relations.map((field) => <tr key={field.id}><th scope="row"><strong>{field.name}</strong></th><td>{knownCollections.find((item) => item.id === field.relation?.targetCollectionId)?.name ?? t('schema.targetUnavailable')}</td><td>{field.relation?.cardinality ?? t('schema.notConfigured')}</td><td>{field.system ? t('schema.systemLocked') : field.pendingOperation ? <StatusChip state="pending">{t('schema.statusPending')}</StatusChip> : t('schema.statusApplied')}</td><td className="schema-actions">{field.pendingOperation ? <Button onClick={() => void removeOperation(field.pendingOperation!)} size="small" type="button" variant="quiet">{t('schema.undo')}</Button> : field.id && !field.system && <><Button onClick={() => { setEditorKind('relation'); setEditingTarget(field); setEditingOperation(operations.find((operation) => operation.targetId === field.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">{t('schema.edit')}</Button><Button aria-label={t('schema.removeField', { name: field.name })} onClick={() => void stageRemoval(field, 'relation')} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button></>}</td></tr>)}</tbody></table></div>}
      </section>}

      {view === 'indexes' && <section aria-labelledby="schema-view-heading" className="schema-panel">
        <div className="schema-panel-heading"><div><span className="schema-panel-icon schema-panel-icon--blue"><Database aria-hidden="true" size={16} /></span><div><h3 id="schema-view-heading">{t('schema.indexesTitle')}</h3><p>{t('schema.indexesDescription')}</p></div></div><Button onClick={() => { setEditorKind('index'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />{t('schema.addIndex')}</Button></div>
        {indexes.length === 0 ? <EmptyState description={t('schema.noIndexesDescription')} title={t('schema.noIndexesTitle')} /> : <div className="schema-table-wrap"><table className="schema-table"><caption>{t('schema.indexesCaption', { name: collection.name })}</caption><thead><tr><th scope="col">{t('schema.columnIndex')}</th><th scope="col">{t('schema.columnFields')}</th><th scope="col">{t('schema.columnUnique')}</th><th scope="col">{t('schema.columnStatus')}</th><th scope="col"><span className="sr-only">{t('schema.columnActions')}</span></th></tr></thead><tbody>{indexes.map((index) => <tr key={index.id ?? index.name}><th scope="row"><strong>{index.name}</strong></th><td>{index.fields.map((id) => fields.find((field) => field.id === id)?.name ?? id).join(', ')}</td><td>{t(index.unique ? 'common.yes' : 'common.no')}</td><td>{index.pendingOperation ? <StatusChip state="pending">{t('schema.statusPending')}</StatusChip> : t('schema.statusApplied')}</td><td className="schema-actions">{index.pendingOperation ? <Button onClick={() => void removeOperation(index.pendingOperation!)} size="small" type="button" variant="quiet">{t('schema.undo')}</Button> : index.id && <><Button onClick={() => { setEditorKind('index'); setEditingTarget(index); setEditingOperation(operations.find((operation) => operation.targetId === index.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">{t('schema.edit')}</Button><Button aria-label={t('schema.removeIndex', { name: index.name })} onClick={() => void stageRemoval(index, 'index')} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button></>}</td></tr>)}</tbody></table></div>}
      </section>}

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

      {view === 'history' && <section className="schema-panel schema-history-panel"><div className="schema-panel-heading"><div><span className="schema-panel-icon schema-panel-icon--blue"><Clock3 aria-hidden="true" size={16} /></span><div><h3>{t('schema.historyTitle')}</h3><p>{t('schema.historyDescription')}</p></div></div></div>
        {historyLoading && history.length === 0 && <LoadingState label={t('schema.historyLoading')} />}
        {historyError !== undefined && (() => { const copy = errorDetails(historyError, t); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => { setHistoryError(undefined); setHistoryRetryKey((value) => value + 1); }} size="small">{t('common.retry')}</Button></ErrorState>; })()}
        {!historyLoading && !historyError && history.length === 0 && <EmptyState description={t('schema.historyEmptyDescription')} title={t('schema.historyEmptyTitle')} />}
        {history.length > 0 && <ol className="schema-history-list">{history.map((entry) => {
          const changes = entry.diff?.length ?? 0;
          return <li key={entry.id}><span className="schema-history-mark"><Check aria-hidden="true" size={14} /></span><div className="schema-history-item"><div><strong>{t('schema.historyApplied')}</strong><time dateTime={entry.appliedAt}>{formatDate(entry.appliedAt)}</time></div><span>{t(changes === 1 ? 'schema.historySummaryOne' : 'schema.historySummaryMany', { count: changes, version: (collection.schemaVersion ?? 1) - Math.max(0, history.indexOf(entry)) })}</span><details><summary>{t('schema.technicalDetails')}</summary><dl><div><dt>{t('schema.changeId')}</dt><dd><code>{entry.changeSetId}</code></dd></div><div><dt>{t('schema.appliedModelRecord')}</dt><dd><code>{entry.id}</code></dd></div><div><dt>{t('schema.applyAttempt')}</dt><dd><code>{entry.applyAttemptId}</code></dd></div></dl>{entry.diff?.map((diff, index) => <pre key={index}>{JSON.stringify(diff, null, 2)}</pre>)}</details></div></li>;
        })}</ol>}
        {historyCursor && <Button disabled={historyLoading} onClick={() => void loadHistoryMore()} size="small">{historyLoading ? t('common.loading') : t('schema.loadOlder')}</Button>}
      </section>}

      {localPending && localPending.operations.length > 0 && <section aria-label={t('schema.pendingPanelLabel')} className="schema-pending-panel">
        <div className="schema-pending-panel__heading"><div><span className="schema-pending-icon"><Save aria-hidden="true" size={16} /></span><div><strong>{t(localPending.operations.length === 1 ? 'schema.pendingOne' : 'schema.pendingMany', { count: localPending.operations.length })}</strong><span>{t('schema.pendingSavedFor', { version: localPending.version })}</span></div></div><StatusChip state={localPending.status}>{t(pendingStatusKey)}</StatusChip></div>
        <ul className="schema-pending-operations">{localPending.operations.map((operation) => <li key={operation.id}><span>{operationName(operation, t)}</span><Button aria-label={t('schema.removeOperation', { name: operationName(operation, t) })} disabled={working} onClick={() => void removeOperation(operation)} size="small" type="button" variant="quiet"><X aria-hidden="true" size={14} />{t('schema.undo')}</Button></li>)}</ul>
        {localPending.status === 'failed' && <div className="schema-recovery-guidance"><AlertTriangle aria-hidden="true" size={15} /><div><strong>{t('schema.recoveryTitle')}</strong><span>{localPending.recoveryState?.summary || t('schema.recoveryFallback')}</span></div><Link to={`/changes?changeSet=${encodeURIComponent(localPending.changeSetId)}`}>{t('schema.openRecovery')} <ArrowRight aria-hidden="true" size={13} /></Link></div>}
        <div className="schema-pending-panel__actions"><Button disabled={working} onClick={() => void discard()} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} />{t('schema.discard')}</Button><Button disabled={working} onClick={() => void previewAndApply()} size="small" type="button" variant="primary">{working ? <><LoaderCircle aria-hidden="true" className="spin" size={14} />{t('schema.working')}</> : localPending.status === 'failed' ? t('schema.reviewAndRetry') : t('schema.reviewAndApply')}<ArrowRight aria-hidden="true" size={14} /></Button></div>
      </section>}
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

  return <Surface className="schema-editor" variant="raised">
    <div className="schema-editor__header"><div><p className="eyebrow">{t('schema.editorEyebrow')}</p><h3>{t(isUpdating ? 'schema.editorEditTitle' : 'schema.editorAddTitle', { kind: t(`schema.kinds.${kind}`) })}</h3><p>{t('schema.editorDescription')}</p></div><Button aria-label={t('schema.closeEditor')} onClick={onCancel} size="small" type="button" variant="quiet"><X aria-hidden="true" size={15} /></Button></div>
    <form className="schema-editor__form" noValidate onSubmit={submit}>
      <div className="schema-editor__grid">
        <FormField htmlFor="schema-edit-name" label={t(kind === 'index' ? 'schema.indexName' : 'schema.fieldName')}><input autoComplete="off" id="schema-edit-name" onChange={(event) => { setName(event.target.value); setFormError(''); }} value={name} /></FormField>
        {kind === 'index' ? <FormField htmlFor="schema-index-fields" label={t('schema.columnFields')}><select id="schema-index-fields" multiple onChange={(event) => setSelectedFields(Array.from(event.target.selectedOptions, (option) => option.value))} value={selectedFields}>{fields.filter((item) => !item.system).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField> : <FormField htmlFor="schema-edit-type" label={t('schema.columnType')}><select disabled={kind === 'relation'} id="schema-edit-type" onChange={(event) => setType(event.target.value as FieldType)} value={kind === 'relation' ? 'relation' : type}>{(['text', 'number', 'boolean', 'dateTime', 'json', 'relation', 'file', 'files'] as const).map((option) => <option key={option} value={option}>{t(`schema.fieldTypes.${option}`)}</option>)}</select></FormField>}
      </div>
      {kind === 'relation' && <div className="schema-editor__grid"><FormField htmlFor="schema-target" label={t('schema.targetCollection')}><select id="schema-target" onChange={(event) => setTargetCollectionId(event.target.value)} value={targetCollectionId}><option value="">{loadingTargets ? t('schema.targetLoading') : t('schema.chooseCollection')}</option>{targetCollections.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select>{targetError && <span className="collection-field-error">{t('schema.targetLoadFailed')}</span>}</FormField><FormField htmlFor="schema-cardinality" label={t('schema.cardinality')}><select id="schema-cardinality" onChange={(event) => setCardinality(event.target.value)} value={cardinality}>{(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many'] as const).map((option) => <option key={option} value={option}>{t(`schema.cardinalities.${option}`)}</option>)}</select></FormField></div>}
      {kind !== 'index' && <div className="schema-editor__properties"><label><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" />{t('schema.required')}</label><label><input checked={unique} disabled={type === 'files'} onChange={(event) => setUnique(event.target.checked)} type="checkbox" />{t('schema.unique')}</label>{type === 'files' && <span className="schema-hint">{t('schema.filesCannotBeUnique')}</span>}</div>}
      {kind === 'index' && <label className="schema-editor__properties"><input checked={unique} onChange={(event) => setUnique(event.target.checked)} type="checkbox" />{t('schema.uniqueIndex')}</label>}
      {kind !== 'index' && <details className="schema-editor__advanced"><summary><ChevronDown aria-hidden="true" size={14} />{t('schema.advancedSummary')}</summary><div className="schema-editor__grid"><FormField htmlFor="schema-edit-description" label={t('schema.fieldDescription')}><input id="schema-edit-description" onChange={(event) => setDescription(event.target.value)} value={description} /></FormField><FormField htmlFor="schema-edit-default" label={t('schema.defaultValue')}><input id="schema-edit-default" onChange={(event) => setDefaultValue(event.target.value)} value={defaultValue} /></FormField><FormField htmlFor="schema-edit-validation" hint={(type === 'file' || type === 'files') ? t('schema.fileValidationHint') : undefined} label={t('schema.validation')}><textarea id="schema-edit-validation" onChange={(event) => setValidation(event.target.value)} rows={3} value={validation} /></FormField></div></details>}
      {formError && <p className="collection-field-error" role="alert">{t(formError)}</p>}
      <div className="schema-editor__actions"><Button onClick={onCancel} type="button" variant="quiet">{t('common.cancel')}</Button><Button disabled={working || loadingTargets && kind === 'relation'} type="submit" variant="primary">{working ? t('schema.saving') : t('schema.save')}<Save aria-hidden="true" size={14} /></Button></div>
    </form>
  </Surface>;
}

function PreviewPanel({ preview, working, onCancel, onConfirm, onAttempt }: { preview: SchemaPreview; working: boolean; onCancel: () => void; onConfirm: () => void; onAttempt: () => void }) {
  const { t, formatNumber } = useI18n();
  const impact = preview.impact;
  const summary = typeof impact.summary === 'string' ? impact.summary : '';
  const rowsAffected = typeof impact.affectedRecords === 'number' ? impact.affectedRecords : undefined;
  const uniqueConflict = preview.risk === 'blocked' && preview.preconditions.some((item) => item.code === 'UNIQUE_VALUES_CONFLICT' && item.status === 'failed');
  return <section aria-labelledby="schema-preview-title" className={`schema-preview schema-preview--${preview.risk}`}>
    <div className="schema-preview__heading"><span className="schema-preview__icon">{preview.risk === 'blocked' ? <AlertTriangle aria-hidden="true" size={17} /> : <ShieldCheck aria-hidden="true" size={17} />}</span><div><p className="eyebrow">{t('schema.previewEyebrow')}</p><h3 id="schema-preview-title">{previewTitle(preview, uniqueConflict, t)}</h3><p>{previewBody(preview, uniqueConflict, t)}</p></div><StatusChip state={resultChipState(preview.risk)}>{preview.risk === 'review' ? t('schema.riskReview') : t('schema.riskBlocked')}</StatusChip></div>
    {preview.diff.length > 0 && <div className="schema-preview__section"><h4>{t('schema.whatWillChange')}</h4><ul>{preview.diff.map((change, index) => <li key={index}><span className={`schema-diff-mark schema-diff-mark--${String(change.action ?? 'change')}`}>{change.action === 'remove' ? '−' : change.action === 'update' ? '~' : '+'}</span><span>{diffLabel(change, t)}</span><code>{String(change.kind ?? '')}</code></li>)}</ul></div>}
    <div className="schema-preview__impact"><strong>{t('schema.impact')}</strong><span>{summary || t('schema.impactFallback')}</span>{rowsAffected !== undefined && <span>{t('schema.recordsAffected', { count: formatNumber(rowsAffected) })}</span>}</div>
    {preview.preconditions.length > 0 && <div className="schema-preview__section"><h4>{t('schema.checks')}</h4><ul>{preview.preconditions.map((condition, index) => <li className={`schema-precondition schema-precondition--${String(condition.status ?? 'unknown')}`} key={index}><span>{String(condition.message ?? condition.code ?? t('schema.precondition'))}</span><StatusChip state={String(condition.status ?? 'unknown')}>{String(condition.status ?? t('schema.check'))}</StatusChip></li>)}</ul></div>}
    <div className="schema-preview__actions"><Button disabled={working} onClick={onCancel} type="button" variant="quiet">{t('common.cancel')}</Button>{uniqueConflict && <Button disabled={working} onClick={onAttempt} type="button" variant="primary">{working ? t('schema.applying') : t('schema.attemptApply')}<ArrowRight aria-hidden="true" size={14} /></Button>}{preview.risk === 'review' && <Button disabled={working} onClick={onConfirm} type="button" variant="primary">{working ? t('schema.applying') : t('schema.confirmAndApply')}<ArrowRight aria-hidden="true" size={14} /></Button>}</div>
  </section>;
}
