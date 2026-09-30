import { useEffect, useMemo, useState } from 'react';
import { Activity as ActivityIcon, Bot, Check, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useDiagnostics } from '../components/diagnostics-context';
import { Button, ButtonLink, CopyButton, EmptyState, ErrorState, LoadingState, StatusChip, Surface } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listServiceAccounts, type ServiceAccount } from '../access/client';
import { listActivity, type ActivityFact } from '../activity/client';

type LoadState = 'loading' | 'ready' | 'error';

// Spec 0001 §7.1：MCP 子页回答「智能体怎么接进来、它能做什么、最近做了什么」。
// 后端没有 MCP 专用接口，因此这里全部复用既有只读数据：
// Runtime 状态（diagnostics）、Service Account（Access & keys）、Activity（最近操作）。
const agentActivityKinds = ['change.applied', 'change.pending', 'change.failed', 'extension.run'] as const;

// 失败时说明具体哪个数据不可用，并给出重试入口（spec §5.3 的失败语义）。
function failureDescription(error: unknown, fallback: string, errorMessage: (code: string) => string | undefined) {
  return error instanceof ApiClientError ? errorMessage(error.apiError.code) ?? fallback : fallback;
}

function permissionTone(preset: ServiceAccount['permission']): 'outline' | 'primary' | 'warning' {
  if (preset === 'fullAccess') return 'primary';
  if (preset === 'custom') return 'warning';
  return 'outline';
}

export function MCPGuidePage() {
  const { t, formatDate, errorMessage } = useI18n();
  const navigate = useNavigate();
  const { runtime } = useDiagnostics();
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [accountsState, setAccountsState] = useState<LoadState>('loading');
  const [accountsError, setAccountsError] = useState<unknown>();
  const [activity, setActivity] = useState<ActivityFact[]>([]);
  const [activityState, setActivityState] = useState<LoadState>('loading');
  const [activityError, setActivityError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setAccountsState('loading');
    void listServiceAccounts({ limit: 100 }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setAccounts(page.data);
      setAccountsError(undefined);
      setAccountsState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setAccountsError(reason);
      setAccountsState('error');
    });
    setActivityState('loading');
    void listActivity({ limit: 8, kinds: [...agentActivityKinds] }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setActivity(page.data);
      setActivityError(undefined);
      setActivityState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setActivityError(reason);
      setActivityState('error');
    });
    return () => controller.abort();
  }, [reloadKey]);

  const commands = useMemo<AdminCommand[]>(() => [{
    id: 'surface.mcp',
    category: 'commands.categories.system',
    label: () => t('commands.mcp'),
    keywords: () => ['mcp', 'agent', 'coding agent', 'model context protocol'],
    execute: () => navigate('/connect/mcp'),
  }], [navigate, t]);
  useRegisterCommands(commands);

  const runtimeReady = runtime.state === 'ready' && runtime.value.state === 'ready';
  const activeAccounts = accounts.filter((account) => account.status === 'active');
  const selected = activeAccounts[0];
  const command = t('mcp.command');

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">{t('mcp.eyebrow')}</p>
        <h1>{t('mcp.title')}</h1>
        <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('mcp.description')}</p>
      </header>

      <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
        <div>
          <h2>{t('mcp.connectionTitle')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('mcp.connectionDescription')}</p>
        </div>
        <dl className="m-0 grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('mcp.apiOrigin')}</dt>
            <dd className="m-0 flex min-w-0 items-center gap-1.5">
              <code className="truncate font-mono text-xs text-ink-secondary">{origin || '—'}</code>
              {origin && <CopyButton label={t('mcp.copyOrigin')} value={origin} />}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('mcp.transport')}</dt>
            <dd className="m-0 text-xs text-ink-secondary">{t('mcp.transportValue')}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-secondary px-3 py-2.5">
            <dt className="text-[11px] font-semibold text-muted-foreground">{t('mcp.runtime')}</dt>
            <dd className="m-0"><StatusChip state={runtimeReady ? 'ready' : 'unavailable'}>{t(runtimeReady ? 'mcp.runtimeReady' : 'mcp.runtimeUnavailable')}</StatusChip></dd>
          </div>
          {selected && (
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-secondary px-3 py-2.5">
              <dt className="text-[11px] font-semibold text-muted-foreground">{t('mcp.accountLastUsed')}</dt>
              <dd className="m-0 text-xs text-ink-secondary">{selected.lastUsedAt ? formatDate(selected.lastUsedAt) : t('mcp.accountNeverUsed')}</dd>
            </div>
          )}
        </dl>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-3 p-5" variant="standard">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><Terminal size={16} /></span>
          <div className="min-w-0">
            <h2>{t('mcp.commandTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('mcp.commandHint')}</p>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted px-3 py-2.5">
          <code className="min-w-0 break-words font-mono text-xs text-ink-secondary">{command}</code>
          <CopyButton label={t('common.copy')} value={command} />
        </div>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ShieldCheck size={16} /></span>
            <div className="min-w-0">
              <h2>{t('mcp.accountsTitle')}</h2>
              <p className="mt-1 max-w-[640px] text-xs leading-relaxed text-muted-foreground">{t('mcp.accountsDescription')}</p>
            </div>
          </div>
          <ButtonLink size="small" to="/access">{t('mcp.manageAccounts')}</ButtonLink>
        </div>

        {accountsState === 'loading' && <LoadingState label={t('common.loading')} />}
        {accountsState === 'error' && (
          <ErrorState description={failureDescription(accountsError, t('mcp.accountsUnavailable'), errorMessage)} title={t('mcp.accountsUnavailable')}>
            <div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
          </ErrorState>
        )}
        {accountsState === 'ready' && activeAccounts.length === 0 && (
          <EmptyState description={t('mcp.accountsEmptyDescription')} title={t('mcp.accountsEmptyTitle')}>
            <div className="mt-3"><ButtonLink size="small" to="/access" variant="primary">{t('mcp.createAccount')}</ButtonLink></div>
          </EmptyState>
        )}
        {accountsState === 'ready' && activeAccounts.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {activeAccounts.map((account) => (
              <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5" data-mcp-account-row key={account.id}>
                <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-ink-secondary"><Bot size={15} /></span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="truncate text-xs font-semibold text-foreground">{account.name}</strong>
                  {account.description && <small className="truncate text-[11px] text-muted-foreground">{account.description}</small>}
                </span>
                <span className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-semibold">{t('mcp.accountPermission')}</span>
                  <Badge variant={permissionTone(account.permission)}>{t(`access.permissions.${account.permission}`)}</Badge>
                </span>
                <StatusChip state={account.status}>{t(`access.statuses.${account.status}`)}</StatusChip>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ActivityIcon size={16} /></span>
          <div className="min-w-0">
            <h2>{t('mcp.activityTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('mcp.activityDescription')}</p>
          </div>
        </div>

        {activityState === 'loading' && <LoadingState label={t('common.loading')} />}
        {activityState === 'error' && (
          <ErrorState description={failureDescription(activityError, t('mcp.activityUnavailable'), errorMessage)} title={t('mcp.activityUnavailable')}>
            <div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
          </ErrorState>
        )}
        {activityState === 'ready' && activity.length === 0 && (
          <EmptyState description={t('mcp.activityEmptyDescription')} title={t('mcp.activityEmptyTitle')} />
        )}
        {activityState === 'ready' && activity.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {activity.map((fact) => (
              <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5" key={fact.id}>
                <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-success-soft text-success"><Check size={13} /></span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="truncate text-xs font-semibold text-foreground">{fact.title ?? t(('activity.kinds.' + fact.kind) as TranslationKey)}</strong>
                  <small className="truncate text-[11px] text-muted-foreground"><code className="font-mono">{fact.resourceId}</code> · {formatDate(fact.occurredAt)}</small>
                </span>
                <Link className="text-xs font-semibold text-primary hover:underline" to={fact.deepLink}>{t('activity.open')}</Link>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      <div className="flex flex-wrap items-center gap-2">
        <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/connect/api">{t('navigation.connectApi')}</Link>
        <span aria-hidden="true" className="text-subtle-foreground">·</span>
        <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/connect/sdk">{t('navigation.connectSdk')}</Link>
      </div>
    </div>
  );
}
