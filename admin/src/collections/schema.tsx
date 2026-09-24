import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Check, ChevronDown, Clock3, Database, GitBranch, Layers3, LoaderCircle, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiClientError } from '../api/client';
import { Button, EmptyState, ErrorState, FormField, LoadingState, StatusChip, Surface } from '../components/ui';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorDetails(error: unknown) {
  if (!(error instanceof ApiClientError)) {
    return { title: 'Schema change could not be completed.', message: error instanceof Error ? error.message : 'Try again when the project is available.' };
  }
  return {
    title: error.apiError.message,
    message: [error.apiError.code, error.apiError.hint, `Request ID: ${error.apiError.requestId}`].filter(Boolean).join(' · '),
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

function operationName(operation: PendingOperation) {
  const definition = operationDefinition(operation);
  const name = typeof definition.name === 'string' ? definition.name : operation.targetId ?? 'Schema item';
  const kind = operation.kind === 'relation' ? 'relation' : operation.kind;
  return `${operation.action === 'add' ? 'Add' : operation.action === 'update' ? 'Update' : 'Remove'} ${kind}: ${name}`;
}

function fieldLabel(field: FieldDefinition) {
  return field.type === 'dateTime' ? 'Date & time' : field.type === 'json' ? 'JSON' : field.type.charAt(0).toUpperCase() + field.type.slice(1);
}

export function CollectionSchemaPage() {
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
  const [notice, setNotice] = useState('');
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
      setNotice('Saved to Pending Changes.');
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
      setNotice('Pending operation removed.');
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
        setNotice('The change needs recovery. It remains saved so you can review the details and retry.');
        setPreview(null);
        await refreshModel();
      } else {
        setNotice('Schema changes applied. The Collection now uses the updated model.');
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
      setNotice('Pending changes discarded. The applied model is unchanged.');
    } catch (error) { setLocalError(error); }
    finally { setWorking(false); }
  }

  const titles: Record<SchemaView, string> = { fields: 'Fields', relations: 'Relations', indexes: 'Indexes', history: 'Applied history' };
  return (
    <div className="schema-workspace">
      <div className="schema-page-heading"><div><p className="eyebrow">COLLECTION MODEL</p><h2>Schema</h2><p>Shape the data this Collection can hold. Saved edits remain here until you apply them.</p></div><span className="schema-version">Model v{collection.schemaVersion ?? 1}</span></div>
      <nav aria-label="Schema views" className="schema-tabs">
        {(['fields', 'relations', 'indexes', 'history'] as const).map((tab) => <button aria-current={view === tab ? 'page' : undefined} className={view === tab ? 'is-active' : ''} key={tab} onClick={() => selectView(tab)} type="button">{titles[tab]}</button>)}
      </nav>
      {notice && <div className="schema-notice" role="status"><Check aria-hidden="true" size={15} />{notice}</div>}
      {localError !== undefined && (() => { const copy = errorDetails(localError); return <ErrorState className="schema-error" description={copy.message} title={copy.title}><Button onClick={() => void refreshModel()} size="small"><RefreshCw aria-hidden="true" size={14} /> Refresh status</Button></ErrorState>; })()}
      {view === 'fields' && <section aria-labelledby="schema-view-heading" className="schema-panel">
        <div className="schema-panel-heading"><div><span className="schema-panel-icon"><Layers3 aria-hidden="true" size={16} /></span><div><h3 id="schema-view-heading">Fields</h3><p>{fields.length} {fields.length === 1 ? 'field' : 'fields'} · system fields are managed by Modelry</p></div></div><Button onClick={() => { setEditorKind('field'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />Add field</Button></div>
        {fields.length === 0 ? <EmptyState description="Add a field to describe the records in this Collection." title="No fields yet" /> : <div className="schema-table-wrap"><table className="schema-table"><caption>Fields in {collection.name}</caption><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Unique</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>
          {fields.map((field) => <tr key={field.id ?? field.name}>
            <th scope="row"><strong>{field.name}</strong>{field.description && <small>{field.description}</small>}</th><td>{fieldLabel(field)}</td><td>{field.required ? 'Yes' : 'No'}</td><td>{field.unique ? 'Yes' : 'No'}</td><td>{field.system ? <span className="schema-locked">System · Locked</span> : field.pendingOperation ? <StatusChip state="pending">Pending</StatusChip> : <span className="schema-current">Applied</span>}</td>
            <td className="schema-actions">{!field.system && field.pendingOperation ? <Button onClick={() => void removeOperation(field.pendingOperation!)} size="small" type="button" variant="quiet">Undo</Button> : !field.system && field.id && <><Button onClick={() => { setEditorKind(field.type === 'relation' ? 'relation' : 'field'); setEditingTarget(field); setEditingOperation(operations.find((operation) => operation.targetId === field.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">Edit</Button><Button aria-label={`Remove ${field.name}`} onClick={() => void stageRemoval(field, operationKind(field))} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button></>}</td>
          </tr>)}
        </tbody></table></div>}
      </section>}

      {view === 'relations' && <section aria-labelledby="schema-view-heading" className="schema-panel">
        <div className="schema-panel-heading"><div><span className="schema-panel-icon schema-panel-icon--violet"><GitBranch aria-hidden="true" size={16} /></span><div><h3 id="schema-view-heading">Relations</h3><p>Connect this Collection to another Collection with a Relation field.</p></div></div><Button onClick={() => { setEditorKind('relation'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />Add relation</Button></div>
        {knownCollectionsError && <div className="collection-inline-warning" role="status">Target Collection names are unavailable. Refresh this page to load them again.</div>}
        {relations.length === 0 ? <EmptyState description="A Relation is a Field that points to another Collection. Add one to connect your model." title="No relations yet" /> : <div className="schema-table-wrap"><table className="schema-table"><caption>Relations in {collection.name}</caption><thead><tr><th scope="col">Relation</th><th scope="col">Target</th><th scope="col">Cardinality</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{relations.map((field) => <tr key={field.id}><th scope="row"><strong>{field.name}</strong></th><td>{knownCollections.find((item) => item.id === field.relation?.targetCollectionId)?.name ?? 'Target unavailable'}</td><td>{field.relation?.cardinality ?? 'Not configured'}</td><td>{field.system ? 'System · Locked' : field.pendingOperation ? <StatusChip state="pending">Pending</StatusChip> : 'Applied'}</td><td className="schema-actions">{field.pendingOperation ? <Button onClick={() => void removeOperation(field.pendingOperation!)} size="small" type="button" variant="quiet">Undo</Button> : field.id && !field.system && <><Button onClick={() => { setEditorKind('relation'); setEditingTarget(field); setEditingOperation(operations.find((operation) => operation.targetId === field.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">Edit</Button><Button aria-label={`Remove ${field.name}`} onClick={() => void stageRemoval(field, 'relation')} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button></>}</td></tr>)}</tbody></table></div>}
      </section>}

      {view === 'indexes' && <section aria-labelledby="schema-view-heading" className="schema-panel">
        <div className="schema-panel-heading"><div><span className="schema-panel-icon schema-panel-icon--blue"><Database aria-hidden="true" size={16} /></span><div><h3 id="schema-view-heading">Indexes</h3><p>Indexes can cover one or more fields and may enforce uniqueness.</p></div></div><Button onClick={() => { setEditorKind('index'); setEditingOperation(null); setEditingTarget(null); }} size="small" type="button" variant="primary"><Plus aria-hidden="true" size={14} />Add index</Button></div>
        {indexes.length === 0 ? <EmptyState description="Add a composite or advanced Index when a query needs it. Single-field Unique belongs on the Field." title="No additional indexes" /> : <div className="schema-table-wrap"><table className="schema-table"><caption>Indexes in {collection.name}</caption><thead><tr><th scope="col">Index</th><th scope="col">Fields</th><th scope="col">Unique</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{indexes.map((index) => <tr key={index.id ?? index.name}><th scope="row"><strong>{index.name}</strong></th><td>{index.fields.map((id) => fields.find((field) => field.id === id)?.name ?? id).join(', ')}</td><td>{index.unique ? 'Yes' : 'No'}</td><td>{index.pendingOperation ? <StatusChip state="pending">Pending</StatusChip> : 'Applied'}</td><td className="schema-actions">{index.pendingOperation ? <Button onClick={() => void removeOperation(index.pendingOperation!)} size="small" type="button" variant="quiet">Undo</Button> : index.id && <><Button onClick={() => { setEditorKind('index'); setEditingTarget(index); setEditingOperation(operations.find((operation) => operation.targetId === index.id && operation.action === 'update') ?? null); }} size="small" type="button" variant="quiet">Edit</Button><Button aria-label={`Remove index ${index.name}`} onClick={() => void stageRemoval(index, 'index')} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} /></Button></>}</td></tr>)}</tbody></table></div>}
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

      {view === 'history' && <section className="schema-panel schema-history-panel"><div className="schema-panel-heading"><div><span className="schema-panel-icon schema-panel-icon--blue"><Clock3 aria-hidden="true" size={16} /></span><div><h3>Applied history</h3><p>Durable record of model changes that have been applied.</p></div></div></div>
        {historyLoading && history.length === 0 && <LoadingState label="Loading applied history" />}
        {historyError !== undefined && (() => { const copy = errorDetails(historyError); return <ErrorState description={copy.message} title={copy.title}><Button onClick={() => { setHistoryError(undefined); setHistoryRetryKey((value) => value + 1); }} size="small">Retry</Button></ErrorState>; })()}
        {!historyLoading && !historyError && history.length === 0 && <EmptyState description="Applied schema changes will appear here with their time and change summary." title="No applied history yet" />}
        {history.length > 0 && <ol className="schema-history-list">{history.map((entry) => <li key={entry.id}><span className="schema-history-mark"><Check aria-hidden="true" size={14} /></span><div className="schema-history-item"><div><strong>Schema changes applied</strong><time dateTime={entry.appliedAt}>{new Date(entry.appliedAt).toLocaleString()}</time></div><span>{entry.diff?.length ?? 0} {entry.diff?.length === 1 ? 'change' : 'changes'} · Model v{(collection.schemaVersion ?? 1) - Math.max(0, history.indexOf(entry))}</span><details><summary>Technical details</summary><dl><div><dt>Change ID</dt><dd><code>{entry.changeSetId}</code></dd></div><div><dt>Applied model record</dt><dd><code>{entry.id}</code></dd></div><div><dt>Apply attempt</dt><dd><code>{entry.applyAttemptId}</code></dd></div></dl>{entry.diff?.map((diff, index) => <pre key={index}>{JSON.stringify(diff, null, 2)}</pre>)}</details></div></li>)}</ol>}
        {historyCursor && <Button disabled={historyLoading} onClick={() => void loadHistoryMore()} size="small">{historyLoading ? 'Loading…' : 'Load older changes'}</Button>}
      </section>}

      {localPending && localPending.operations.length > 0 && <section aria-label="Pending schema changes" className="schema-pending-panel">
        <div className="schema-pending-panel__heading"><div><span className="schema-pending-icon"><Save aria-hidden="true" size={16} /></span><div><strong>{localPending.operations.length} pending {localPending.operations.length === 1 ? 'change' : 'changes'}</strong><span>Saved for this Collection · Version {localPending.version}</span></div></div><StatusChip state={localPending.status}>{localPending.status === 'needsReview' ? 'Needs review' : localPending.status === 'failed' ? 'Recovery needed' : 'Ready'}</StatusChip></div>
        <ul className="schema-pending-operations">{localPending.operations.map((operation) => <li key={operation.id}><span>{operationName(operation)}</span><Button aria-label={`Remove pending operation ${operationName(operation)}`} disabled={working} onClick={() => void removeOperation(operation)} size="small" type="button" variant="quiet"><X aria-hidden="true" size={14} />Undo</Button></li>)}</ul>
        {localPending.status === 'failed' && <div className="schema-recovery-guidance"><AlertTriangle aria-hidden="true" size={15} /><div><strong>The last attempt needs recovery.</strong><span>{localPending.recoveryState?.summary || 'Your pending changes are still saved. Review the preview and current model before retrying.'}</span></div><Link to={`/changes?changeSet=${encodeURIComponent(localPending.changeSetId)}`}>Open recovery details <ArrowRight aria-hidden="true" size={13} /></Link></div>}
        <div className="schema-pending-panel__actions"><Button disabled={working} onClick={() => void discard()} size="small" type="button" variant="quiet"><Trash2 aria-hidden="true" size={14} />Discard changes</Button><Button disabled={working} onClick={() => void previewAndApply()} size="small" type="button" variant="primary">{working ? <><LoaderCircle aria-hidden="true" className="spin" size={14} />Working…</> : localPending.status === 'failed' ? 'Review and retry' : 'Review & apply'}<ArrowRight aria-hidden="true" size={14} /></Button></div>
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
  const [formError, setFormError] = useState('');
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
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(cleanName)) { setFormError('Use a letter first, then letters, numbers, or underscores.'); return; }
    const reserved = new Set(['id', 'createdat', 'updatedat', 'password', ...(collection.type === 'Auth' ? ['email'] : [])]);
    if (kind !== 'index' && reserved.has(cleanName.toLowerCase()) && cleanName.toLowerCase() !== field?.name.toLowerCase()) { setFormError('This name is reserved for a system or authentication field.'); return; }
    const definition: Record<string, unknown> = kind === 'index' ? { name: cleanName, fields: selectedFields, unique } : { name: cleanName, type: kind === 'relation' ? 'relation' : type, required, unique, ...(description.trim() ? { description: description.trim() } : {}) };
    if (kind === 'index' && selectedFields.length === 0) { setFormError('Choose at least one Field for this Index.'); return; }
    if (kind === 'relation') {
      if (!targetCollectionId) { setFormError('Choose a target Collection.'); return; }
      definition.relation = { targetCollectionId, cardinality };
    }
    if (kind !== 'index') {
      if (validation.trim()) {
        try {
          const parsed: unknown = JSON.parse(validation);
          if (!isRecord(parsed)) throw new Error();
          definition.validation = parsed;
        } catch { setFormError('Validation must be a valid JSON object.'); return; }
      }
      if (defaultValue.trim()) {
        try { definition.default = JSON.parse(defaultValue); }
        catch { setFormError('Default value must be valid JSON.'); return; }
      }
    }
    const kindForRequest: OperationKind = kind === 'relation' ? 'relation' : kind;
    const match = editingOperation ?? pendingOperations.find((operation) => operation.targetId === (field?.id ?? index?.id) && operation.action === 'update');
    const targetId = (field?.original?.id ?? field?.id ?? index?.original?.id ?? index?.id);
    const action = match?.action ?? (isUpdating ? 'update' : 'add');
    onSave({ kind: kindForRequest, action, ...(targetId && action !== 'add' ? { targetId } : {}), definition }, match ?? undefined);
  }

  return <Surface className="schema-editor" variant="raised">
    <div className="schema-editor__header"><div><p className="eyebrow">PENDING SCHEMA CHANGE</p><h3>{isUpdating ? `Edit ${kind}` : `Add ${kind}`}</h3><p>This save becomes a durable Pending Change. It does not update the applied model yet.</p></div><Button aria-label="Close editor" onClick={onCancel} size="small" type="button" variant="quiet"><X aria-hidden="true" size={15} /></Button></div>
    <form className="schema-editor__form" noValidate onSubmit={submit}>
      <div className="schema-editor__grid">
        <FormField htmlFor="schema-edit-name" label={kind === 'index' ? 'Index name' : 'Field name'}><input autoComplete="off" id="schema-edit-name" onChange={(event) => { setName(event.target.value); setFormError(''); }} value={name} /></FormField>
        {kind === 'index' ? <FormField htmlFor="schema-index-fields" label="Fields"><select id="schema-index-fields" multiple onChange={(event) => setSelectedFields(Array.from(event.target.selectedOptions, (option) => option.value))} value={selectedFields}>{fields.filter((item) => !item.system).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField> : <FormField htmlFor="schema-edit-type" label="Type"><select disabled={kind === 'relation'} id="schema-edit-type" onChange={(event) => setType(event.target.value as FieldType)} value={kind === 'relation' ? 'relation' : type}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="dateTime">Date &amp; time</option><option value="json">JSON</option><option value="relation">Relation</option><option value="file">File</option></select></FormField>}
      </div>
      {kind === 'relation' && <div className="schema-editor__grid"><FormField htmlFor="schema-target" label="Target Collection"><select id="schema-target" onChange={(event) => setTargetCollectionId(event.target.value)} value={targetCollectionId}><option value="">{loadingTargets ? 'Loading…' : 'Choose a Collection'}</option>{targetCollections.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select>{targetError && <span className="collection-field-error">Could not load target Collections. Close and retry the editor.</span>}</FormField><FormField htmlFor="schema-cardinality" label="Cardinality"><select id="schema-cardinality" onChange={(event) => setCardinality(event.target.value)} value={cardinality}><option value="many-to-one">Many to one</option><option value="one-to-one">One to one</option><option value="one-to-many">One to many</option><option value="many-to-many">Many to many</option></select></FormField></div>}
      {kind !== 'index' && <div className="schema-editor__properties"><label><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" />Required</label><label><input checked={unique} onChange={(event) => setUnique(event.target.checked)} type="checkbox" />Unique</label></div>}
      {kind === 'index' && <label className="schema-editor__properties"><input checked={unique} onChange={(event) => setUnique(event.target.checked)} type="checkbox" />Unique Index</label>}
      {kind !== 'index' && <details className="schema-editor__advanced"><summary><ChevronDown aria-hidden="true" size={14} />Validation, defaults, and description</summary><div className="schema-editor__grid"><FormField htmlFor="schema-edit-description" label="Description"><input id="schema-edit-description" onChange={(event) => setDescription(event.target.value)} value={description} /></FormField><FormField htmlFor="schema-edit-default" label="Default value (JSON)"><input id="schema-edit-default" onChange={(event) => setDefaultValue(event.target.value)} value={defaultValue} /></FormField><FormField htmlFor="schema-edit-validation" label="Validation (JSON object)"><textarea id="schema-edit-validation" onChange={(event) => setValidation(event.target.value)} rows={3} value={validation} /></FormField></div></details>}
      {formError && <p className="collection-field-error" role="alert">{formError}</p>}
      <div className="schema-editor__actions"><Button onClick={onCancel} type="button" variant="quiet">Cancel</Button><Button disabled={working || loadingTargets && kind === 'relation'} type="submit" variant="primary">{working ? 'Saving…' : 'Save to Pending Changes'}<Save aria-hidden="true" size={14} /></Button></div>
    </form>
  </Surface>;
}

function PreviewPanel({ preview, working, onCancel, onConfirm, onAttempt }: { preview: SchemaPreview; working: boolean; onCancel: () => void; onConfirm: () => void; onAttempt: () => void }) {
  const impact = preview.impact;
  const summary = typeof impact.summary === 'string' ? impact.summary : '';
  const rowsAffected = typeof impact.affectedRecords === 'number' ? impact.affectedRecords : undefined;
  const uniqueConflict = preview.risk === 'blocked' && preview.preconditions.some((item) => item.code === 'UNIQUE_VALUES_CONFLICT' && item.status === 'failed');
  return <section aria-labelledby="schema-preview-title" className={`schema-preview schema-preview--${preview.risk}`}>
    <div className="schema-preview__heading"><span className="schema-preview__icon">{preview.risk === 'blocked' ? <AlertTriangle aria-hidden="true" size={17} /> : <ShieldCheck aria-hidden="true" size={17} />}</span><div><p className="eyebrow">RUNTIME PREVIEW</p><h3 id="schema-preview-title">{preview.risk === 'blocked' ? (uniqueConflict ? 'Existing values conflict with this unique change' : 'This change cannot be applied yet') : 'Review schema changes'}</h3><p>{uniqueConflict ? 'You can attempt the change. The Runtime will roll it back and save recovery details if duplicates remain.' : preview.risk === 'blocked' ? 'Resolve the listed checks and preview again.' : 'The Runtime checked the current model and its dependencies.'}</p></div><StatusChip state={preview.risk}>{preview.risk === 'review' ? 'Needs review' : 'Blocked'}</StatusChip></div>
    {preview.diff.length > 0 && <div className="schema-preview__section"><h4>What will change</h4><ul>{preview.diff.map((change, index) => <li key={index}><span className={`schema-diff-mark schema-diff-mark--${String(change.action ?? 'change')}`}>{change.action === 'remove' ? '−' : change.action === 'update' ? '~' : '+'}</span><span>{typeof change.name === 'string' ? change.name : `${String(change.kind ?? 'Schema')} ${String(change.action ?? 'change')}`}</span><code>{String(change.kind ?? '')}</code></li>)}</ul></div>}
    <div className="schema-preview__impact"><strong>Impact</strong><span>{summary || 'The Runtime checked the current model and its dependencies.'}</span>{rowsAffected !== undefined && <span>{rowsAffected.toLocaleString()} records affected</span>}</div>
    {preview.preconditions.length > 0 && <div className="schema-preview__section"><h4>Checks</h4><ul>{preview.preconditions.map((condition, index) => <li className={`schema-precondition schema-precondition--${String(condition.status ?? 'unknown')}`} key={index}><span>{String(condition.message ?? condition.code ?? 'Precondition')}</span><StatusChip state={String(condition.status ?? 'unknown')}>{String(condition.status ?? 'Check')}</StatusChip></li>)}</ul></div>}
    <div className="schema-preview__actions"><Button disabled={working} onClick={onCancel} type="button" variant="quiet">Cancel</Button>{uniqueConflict && <Button disabled={working} onClick={onAttempt} type="button" variant="primary">{working ? 'Applying…' : 'Attempt apply'}<ArrowRight aria-hidden="true" size={14} /></Button>}{preview.risk === 'review' && <Button disabled={working} onClick={onConfirm} type="button" variant="primary">{working ? 'Applying…' : 'Confirm & apply'}<ArrowRight aria-hidden="true" size={14} /></Button>}</div>
  </section>;
}
