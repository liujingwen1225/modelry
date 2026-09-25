import { useState } from 'react';
import { Button, FormField, StatusChip, Surface } from '../components/ui';
import { ApiClientError } from '../api/client';
import {
  simulateAccessRule,
  type PolicySimulationInput,
  type PolicySimulationPrincipalKind,
  type PolicySimulationResult,
} from './client';

const OPERATIONS = ['list', 'view', 'create', 'update', 'delete'] as const;
const PRINCIPALS: Array<{ value: PolicySimulationPrincipalKind; label: string }> = [
  { value: 'anonymous', label: 'Anonymous' },
  { value: 'applicationUser', label: 'App user' },
  { value: 'serviceAccount', label: 'Service account' },
  { value: 'owner', label: 'Owner (Control Plane preview)' },
];

// AccessRuleSimulation 让 Owner 在应用规则不变的前提下预演一次假设请求。
export function AccessRuleSimulation({ collectionId }: { collectionId: string }) {
  const [operation, setOperation] = useState<(typeof OPERATIONS)[number]>('list');
  const [principalKind, setPrincipalKind] = useState<PolicySimulationPrincipalKind>('anonymous');
  const [principalId, setPrincipalId] = useState('');
  const [recordId, setRecordId] = useState('');
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState<PolicySimulationResult | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const needsPrincipalId = principalKind === 'applicationUser' || principalKind === 'serviceAccount';

  async function simulate() {
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const input: PolicySimulationInput = {
        operation,
        principal: { kind: principalKind, ...(needsPrincipalId && principalId ? { id: principalId } : {}) },
      };
      if (recordId.trim() !== '') input.record = { recordId: recordId.trim() };
      else if (payload.trim() !== '') input.record = { payload: JSON.parse(payload) as Record<string, unknown> };
      setResult(await simulateAccessRule(collectionId, input));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface className="security-simulation" variant="standard">
      <div className="security-rules-heading">
        <div>
          <h2>Simulate a request</h2>
          <p>Preview one Access Rule decision. Only a real Application request is authoritative.</p>
        </div>
        <StatusChip state="info">Preview</StatusChip>
      </div>
      <div className="security-simulation__fields">
        <FormField htmlFor="simulate-operation" label="Operation">
          <select id="simulate-operation" onChange={(event) => setOperation(event.target.value as (typeof OPERATIONS)[number])} value={operation}>
            {OPERATIONS.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
          </select>
        </FormField>
        <FormField htmlFor="simulate-principal" label="Principal">
          <select id="simulate-principal" onChange={(event) => setPrincipalKind(event.target.value as PolicySimulationPrincipalKind)} value={principalKind}>
            {PRINCIPALS.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
          </select>
        </FormField>
        {needsPrincipalId && (
          <FormField htmlFor="simulate-principal-id" label="Principal id">
            <input id="simulate-principal-id" onChange={(event) => setPrincipalId(event.target.value)} value={principalId} />
          </FormField>
        )}
        <FormField htmlFor="simulate-record" label="Existing record id">
          <input id="simulate-record" onChange={(event) => setRecordId(event.target.value)} value={recordId} />
        </FormField>
        <FormField htmlFor="simulate-payload" hint="Inline values are evaluated as supplied and never stored." label="Inline record payload (JSON)">
          <textarea id="simulate-payload" onChange={(event) => setPayload(event.target.value)} rows={3} value={payload} />
        </FormField>
      </div>
      <div className="security-rule-editor-actions">
        <Button disabled={busy} onClick={() => void simulate()} type="button" variant="primary">{busy ? 'Simulating…' : 'Simulate'}</Button>
      </div>
      {result && (
        <div className="security-simulation__result" data-simulation-decision={result.allowed ? 'allow' : 'deny'} role="status">
          <StatusChip state={result.allowed ? 'ready' : 'unavailable'}>{result.allowed ? 'Allowed' : 'Denied'}</StatusChip>
          <span>{result.decidingMode ? `Rule: ${result.decidingMode}` : ''}</span>
          {result.code && <code>{result.code}</code>}
          <p>{result.notice}</p>
        </div>
      )}
      {error !== undefined && (
        <div className="security-dependency-error" role="alert">
          {error instanceof ApiClientError ? error.apiError.message : 'The simulation could not be completed.'}
        </div>
      )}
    </Surface>
  );
}