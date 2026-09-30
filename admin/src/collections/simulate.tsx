import { useState } from 'react';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { ApiClientError } from '../api/client';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import type { AccessRuleMode } from './client';
import {
  simulateAccessRule,
  type PolicySimulationInput,
  type PolicySimulationPrincipalKind,
  type PolicySimulationResult,
} from './client';

const OPERATIONS = ['list', 'view', 'create', 'update', 'delete'] as const;
const KNOWN_MODES: AccessRuleMode[] = ['noAccess', 'anyone', 'signedInUsers', 'recordOwner', 'custom'];
const PRINCIPALS: Array<{ value: PolicySimulationPrincipalKind; key: TranslationKey }> = [
  { value: 'anonymous', key: 'security.simulationPrincipals.anonymous' },
  { value: 'applicationUser', key: 'security.simulationPrincipals.applicationUser' },
  { value: 'serviceAccount', key: 'security.simulationPrincipals.serviceAccount' },
  { value: 'owner', key: 'security.simulationPrincipals.owner' },
];

// AccessRuleSimulation 让 Owner 在应用规则不变的前提下预演一次假设请求。
export function AccessRuleSimulation({ collectionId }: { collectionId: string }) {
  const { t, errorMessage } = useI18n();
  const [operation, setOperation] = useState<(typeof OPERATIONS)[number]>('list');
  const [principalKind, setPrincipalKind] = useState<PolicySimulationPrincipalKind>('anonymous');
  const [principalId, setPrincipalId] = useState('');
  const [recordId, setRecordId] = useState('');
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState<PolicySimulationResult | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const needsPrincipalId = principalKind === 'applicationUser' || principalKind === 'serviceAccount';
  const decidingMode = result?.decidingMode;
  const decidingModeLabel = decidingMode && KNOWN_MODES.includes(decidingMode as AccessRuleMode)
    ? t(`accessModes.${decidingMode as AccessRuleMode}.label`)
    : decidingMode;

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
    <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div className="min-w-0">
          <h2>{t('security.simulationTitle')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('security.simulationDescription')}</p>
        </div>
        <StatusChip state="info">{t('security.simulationPreview')}</StatusChip>
      </div>
      <div className="grid gap-3.5 min-[561px]:grid-cols-2">
        <FormField htmlFor="simulate-operation" label={t('security.simulationOperation')}>
          <select id="simulate-operation" onChange={(event) => setOperation(event.target.value as (typeof OPERATIONS)[number])} value={operation}>
            {OPERATIONS.map((candidate) => <option key={candidate} value={candidate}>{t(`security.operations.${candidate}`)}</option>)}
          </select>
        </FormField>
        <FormField htmlFor="simulate-principal" label={t('security.simulationPrincipal')}>
          <select id="simulate-principal" onChange={(event) => setPrincipalKind(event.target.value as PolicySimulationPrincipalKind)} value={principalKind}>
            {PRINCIPALS.map((candidate) => <option key={candidate.value} value={candidate.value}>{t(candidate.key)}</option>)}
          </select>
        </FormField>
        {needsPrincipalId && (
          <FormField htmlFor="simulate-principal-id" label={t('security.simulationPrincipalId')}>
            <input id="simulate-principal-id" onChange={(event) => setPrincipalId(event.target.value)} value={principalId} />
          </FormField>
        )}
        <FormField htmlFor="simulate-record" label={t('security.simulationRecordId')}>
          <input id="simulate-record" onChange={(event) => setRecordId(event.target.value)} value={recordId} />
        </FormField>
        <FormField htmlFor="simulate-payload" hint={t('security.simulationPayloadHint')} label={t('security.simulationPayload')}>
          <textarea id="simulate-payload" onChange={(event) => setPayload(event.target.value)} rows={3} value={payload} />
        </FormField>
      </div>
      <div className="flex flex-wrap justify-end gap-1.5 border-t pt-3">
        <Button disabled={busy} onClick={() => void simulate()} type="button" variant="primary">{busy ? t('security.simulationSimulating') : t('security.simulationSimulate')}</Button>
      </div>
      {result && (
        <div className="flex flex-col gap-2 rounded-lg border bg-secondary px-3.5 py-3 text-xs" data-simulation-decision={result.allowed ? 'allow' : 'deny'} role="status">
          <StatusChip state={result.allowed ? 'ready' : 'unavailable'}>{result.allowed ? t('security.simulationAllowed') : t('security.simulationDenied')}</StatusChip>
          <span className="text-ink-secondary">{result.decidingMode ? t('security.simulationRule', { mode: decidingModeLabel ?? '' }) : ''}</span>
          {result.code && <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">{result.code}</code>}
          <p className="m-0 text-[11px] text-muted-foreground">{t('security.simulationNotice')}</p>
        </div>
      )}
      {error !== undefined && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3 text-xs text-ink-secondary" role="alert">
          <strong>{error instanceof ApiClientError ? errorMessage(error.apiError.code) ?? t('errors.requestFailed') : t('security.simulationFailed')}</strong>
          {error instanceof ApiClientError && <span>{t('common.errorCode')}: {error.apiError.code} · {t('common.requestId')}: {error.apiError.requestId} · {t('common.tryAgainWhenAvailable')}</span>}
        </div>
      )}
    </Surface>
  );
}
