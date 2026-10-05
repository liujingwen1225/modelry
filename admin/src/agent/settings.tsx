import { useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectField } from '@/components/ui/select-field';
import { Button } from '../components/button';
import { FormField } from '../components/form-field';
import { LoadingState } from '../components/states';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { useOwnerSession } from '../auth/owner-session';
import { agentGet, agentSend, ordinaryTool, type AgentConfig, type AgentPolicy, type AgentTool } from './client';

const permissionFor = (tool: AgentTool) => /Required Permission: `([^`]+)`/.exec(tool.description)?.[1] ?? '';
export function AgentPolicyEditor({identity}: {identity: string}) {
  const {t} = useI18n(); const {state} = useOwnerSession();
  const [policy, setPolicy] = useState<AgentPolicy>();
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {if (state.status !== 'authenticated' || state.session.role !== 'owner') return; const controller = new AbortController(); setPolicy(undefined); Promise.all([agentGet<AgentPolicy>('/policies/' + encodeURIComponent(identity), controller.signal), agentGet<AgentTool[]>('/tools', controller.signal)]).then(([p, ts]) => {setPolicy(p); setTools(ts);}, reason => {if (!controller.signal.aborted) setError(String(reason.message));}); return () => controller.abort();}, [identity, state]);
  const permissions = useMemo(() => [...new Set(tools.map(permissionFor).filter(Boolean))].sort(), [tools]);
  const normal = useMemo(() => new Set(tools.filter(tool => !tool.annotations?.readOnlyHint && ordinaryTool(tool.name)).map(permissionFor)), [tools]);
  async function save() {if (!policy) return; setBusy(true); setError(''); setNotice(''); try {setPolicy(await agentSend<AgentPolicy>('/policies/' + encodeURIComponent(identity), policy, 'PUT')); setNotice(t('agent.saved'));} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}}
  if (state.status !== 'authenticated' || state.session.role !== 'owner') return null;
  if (!policy) return error ? <p role="alert">{error}</p> : <LoadingState label={t('common.loading')} />;
  const groupLabel = (permission: string) => {const [group, action] = permission.split('.'); return `${t(('agent.groups.' + group) as TranslationKey)} · ${t(('agent.permissions.' + action) as TranslationKey)}`;};
  return <section className="flex min-w-0 flex-col gap-3">
    <div><h2 className="text-base font-semibold">{t('agent.permissionsTitle')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('agent.policyDescription')}</p></div>
    <FormField htmlFor={'agent-policy-' + identity} label={t('agent.executionMode')}><SelectField id={'agent-policy-' + identity} value={policy.mode} onValueChange={value => setPolicy({...policy, mode: value as AgentPolicy['mode']})} options={(['readOnly', 'confirmWrites', 'autoWrites'] as const).map(value => ({value, label: t(('agent.modes.' + value) as TranslationKey)}))} /></FormField>
    <div className="divide-y rounded-md border">{permissions.map(permission => <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-2" key={permission}>
      <label className="flex min-h-9 items-center gap-2 text-sm"><Checkbox checked={policy.allowedOperations.includes(permission)} onCheckedChange={checked => setPolicy({...policy, allowedOperations: checked ? [...policy.allowedOperations, permission] : policy.allowedOperations.filter(p => p !== permission), autoOperations: checked ? policy.autoOperations : policy.autoOperations.filter(p => p !== permission)})} />{groupLabel(permission)}</label>
      {policy.mode === 'autoWrites' && normal.has(permission) && <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground"><Checkbox disabled={!policy.allowedOperations.includes(permission)} checked={policy.autoOperations.includes(permission)} onCheckedChange={checked => setPolicy({...policy, autoOperations: checked ? [...policy.autoOperations, permission] : policy.autoOperations.filter(p => p !== permission)})} />{t('agent.autoExecute')}</label>}
    </div>)}</div>
    <p className="text-xs text-muted-foreground">{t('agent.highRiskNotice')}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    <div><Button onClick={() => void save()} disabled={busy}>{t('agent.savePermissions')}</Button></div>
  </section>;
}
export function AgentSettingsPage() {
  const {t} = useI18n(); const {state} = useOwnerSession();
  const [config, setConfig] = useState<AgentConfig>();
  const [key, setKey] = useState(''); const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  useEffect(() => {const controller = new AbortController(); agentGet<AgentConfig>('/config', controller.signal).then(setConfig, reason => {if (!controller.signal.aborted) setError(reason.message);}); return () => controller.abort();}, []);
  if (state.status !== 'authenticated' || state.session.role !== 'owner') return <p>{t('agent.ownerOnly')}</p>;
  async function save() {if (!config) return; setBusy(true); setError(''); setNotice(''); try {setConfig(await agentSend<AgentConfig>('/config', {baseUrl: config.baseUrl, model: config.model, revision: config.revision, ...(key ? {apiKey: key} : {}), clearApiKey: clear}, 'PUT')); setKey(''); setClear(false); setNotice(t('agent.saved'));} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}}
  async function test() {setBusy(true); setError(''); setNotice(''); try {await agentSend('/config/test'); setNotice(t('agent.connected'));} catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));} finally {setBusy(false);}}
  return <div className="flex min-w-0 flex-col gap-6">
    <section className="flex flex-col gap-3"><div><h1 className="text-xl font-semibold">{t('agent.settingsTitle')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('agent.settingsDescription')}</p></div>
      {!config && !error && <LoadingState label={t('common.loading')} />}
      {config && <><FormField htmlFor="agent-base-url" label={t('agent.baseUrl')}><Input id="agent-base-url" type="url" value={config.baseUrl} onChange={event => setConfig({...config, baseUrl: event.target.value})} /></FormField>
        <FormField htmlFor="agent-model" label={t('agent.model')}><Input id="agent-model" value={config.model} onChange={event => setConfig({...config, model: event.target.value})} /></FormField>
        <FormField htmlFor="agent-api-key" label={t('agent.apiKey')}><Input id="agent-api-key" type="password" autoComplete="new-password" value={key} disabled={clear} placeholder={config.apiKeyConfigured ? t('agent.keyConfigured') : t('agent.keyOptional')} onChange={event => setKey(event.target.value)} /></FormField>
        <label className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={clear} onCheckedChange={checked => {setClear(Boolean(checked)); if (checked) setKey('');}} />{t('agent.clearKey')}</label>
        <div className="flex flex-wrap gap-2"><Button onClick={() => void save()} disabled={busy}>{t('agent.saveModel')}</Button><Button variant="secondary" onClick={() => void test()} disabled={busy}>{t('agent.testConnection')}</Button></div>
      </>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
      <p className="text-xs text-muted-foreground">{t('agent.modelSnapshotNotice')}</p>
    </section>
    <div className="border-t pt-5"><AgentPolicyEditor identity="builtin" /></div>
  </div>;
}
