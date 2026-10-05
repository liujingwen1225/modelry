import { Button as ControlButton } from '@/components/ui/button';
import { useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { useDiagnostics } from '../components/diagnostics-context';
import { Button, ButtonLink } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listServiceAccounts, type ServiceAccount } from '../access/client';

type LoadState = 'loading' | 'ready' | 'error';

// MCP 仅提供接入配置；会话、确认及执行历史统一由 Agent 工作台承载。
function failureDescription(error: unknown, fallback: string, errorMessage: (code: string) => string | undefined) {
  return error instanceof ApiClientError ? errorMessage(error.apiError.code) ?? fallback : fallback;
}

function permissionTone(preset: ServiceAccount['permission']): 'outline' | 'primary' | 'warning' {
  if (preset === 'fullAccess') return 'primary';
  if (preset === 'custom') return 'warning';
  return 'outline';
}

export function MCPConfiguration({ workspaceTo = '/agent' }: {workspaceTo?: string}) {
  const { t, formatDate, errorMessage } = useI18n();
  const { runtime } = useDiagnostics();
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [accountsState, setAccountsState] = useState<LoadState>('loading');
  const [accountsError, setAccountsError] = useState<unknown>();
  const [selectedId, setSelectedId] = useState<string>();
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
    return () => controller.abort();
  }, [reloadKey]);

  const activeAccounts = useMemo(() => accounts.filter((account) => account.status === 'active'), [accounts]);
  const selected = activeAccounts.find((account) => account.id === selectedId) ?? activeAccounts[0];

  const runtimeReady = runtime.state === 'ready' && runtime.value.state === 'ready';
  const command = t('mcp.command');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3"><p className="text-sm text-muted-foreground">{t('agent.mcpApprovalNotice')}</p><ButtonLink size="small" to={workspaceTo} variant="secondary">{t('agent.openWorkspace')}</ButtonLink></div>

      <Surface className="flex min-w-0 flex-col gap-4 border-t-0 pt-0" variant="section">
        <div>
          <h2 className="text-base font-semibold">{t('mcp.connectionTitle')}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('mcp.connectionDescription')}</p>
        </div>
        <dl className="m-0 grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 items-center justify-between gap-3 border-b py-3">
            <dt className="text-xs font-semibold text-muted-foreground">{t('mcp.apiOrigin')}</dt>
            <dd className="m-0 flex min-w-0 items-center gap-1.5">
              <code className="truncate font-mono text-[13px] text-ink-secondary">{origin || '—'}</code>
              {origin && <CopyButton label={t('mcp.copyOrigin')} value={origin} />}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b py-3">
            <dt className="text-xs font-semibold text-muted-foreground">{t('mcp.transport')}</dt>
            <dd className="m-0 text-xs text-ink-secondary">{t('mcp.transportValue')}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b py-3">
            <dt className="text-xs font-semibold text-muted-foreground">{t('mcp.runtime')}</dt>
            <dd className="m-0"><StatusChip state={runtimeReady ? 'ready' : 'unavailable'}>{t(runtimeReady ? 'mcp.runtimeReady' : 'mcp.runtimeUnavailable')}</StatusChip></dd>
          </div>
          {selected && (
            <div className="flex items-center justify-between gap-3 border-b py-3">
              <dt className="text-xs font-semibold text-muted-foreground">{t('mcp.accountLastUsed')}</dt>
              <dd className="m-0 text-xs text-ink-secondary">{selected.lastUsedAt ? formatDate(selected.lastUsedAt) : t('mcp.accountNeverUsed')}</dd>
            </div>
          )}
        </dl>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-3" variant="section">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><Terminal size={16} /></span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t('mcp.commandTitle')}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('mcp.commandHint')}</p>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted px-3 py-2.5">
          <code className="min-w-0 break-words font-mono text-[13px] text-ink-secondary">{command}</code>
          <CopyButton label={t('common.copy')} value={command} />
        </div>
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4" variant="section">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ShieldCheck size={16} /></span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{t('mcp.accountsTitle')}</h2>
              <p className="mt-1 max-w-[640px] text-sm leading-relaxed text-muted-foreground">{t('mcp.accountsDescription')}</p>
            </div>
          </div>
          {/* 服务账号与 API Key 现在属于 Access & auth / API Tokens（spec 0001 §3）。 */}
          <ButtonLink size="small" to="/access?tab=tokens">{t('navigation.accessAuth')}</ButtonLink>
        </div>

        {accountsState === 'loading' && <LoadingState label={t('common.loading')} />}
        {accountsState === 'error' && (
          <ErrorState description={failureDescription(accountsError, t('mcp.accountsUnavailable'), errorMessage)} title={t('mcp.accountsUnavailable')}>
            <div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
          </ErrorState>
        )}
        {accountsState === 'ready' && activeAccounts.length === 0 && (
          <EmptyState description={t('mcp.accountsEmptyDescription')} title={t('mcp.accountsEmptyTitle')}>
            <div className="mt-3"><ButtonLink size="small" to="/access?tab=tokens" variant="primary">{t('mcp.createAccount')}</ButtonLink></div>
          </EmptyState>
        )}
        {accountsState === 'ready' && activeAccounts.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {activeAccounts.map((account) => {
              const isSelected = selected?.id === account.id;
              return (
                <li key={account.id}>
                  <ControlButton variant="unstyled"
                    aria-pressed={isSelected}
                    className={`flex w-full flex-wrap items-center gap-3 border-b px-2 py-3 text-left transition-colors focus-visible:bg-accent focus-visible:text-foreground ${isSelected ? 'border-primary bg-accent' : 'border-border bg-transparent '}`}
                    data-mcp-account-row
                    onClick={() => setSelectedId(account.id)}
                    type="button"
                  >
                    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-ink-secondary"><Bot size={15} /></span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <strong className="truncate text-xs font-semibold text-foreground">{account.name}</strong>
                      {account.description && <small className="truncate text-xs text-muted-foreground">{account.description}</small>}
                    </span>
                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold">{t('mcp.accountPermission')}</span>
                      <Badge variant={permissionTone(account.permission)}>{t(`access.permissions.${account.permission}`)}</Badge>
                    </span>
                    <StatusChip state={account.status}>{t(`access.statuses.${account.status}`)}</StatusChip>
                  </ControlButton>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>

      <div className="flex flex-wrap items-center gap-2">
        <Link className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-primary hover:underline" to="/api">{t('navigation.apiWorkspace')}</Link>
        <span aria-hidden="true" className="text-subtle-foreground">·</span>
        <Link className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-primary hover:underline" to="/api?tab=openapi">{t('api.workspaceTabs.openapi')}</Link>
      </div>
    </div>
  );
}
