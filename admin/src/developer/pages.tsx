import { Button as ControlButton } from '@/components/ui/button';
import { useEffect, useMemo, useState } from 'react';
import { Activity as ActivityIcon, Bot, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { useDiagnostics } from '../components/diagnostics-context';
import { Button, ButtonLink } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { EmptyState, ErrorState, LoadingState, StatusChip } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n } from '../i18n/i18n';
import { ApiClientError } from '../api/client';
import { listAuditRecords, listServiceAccounts, type AuditRecord, type ServiceAccount } from '../access/client';

type LoadState = 'loading' | 'ready' | 'error';

// Spec 0001 §3.1/§7.1：MCP 子页回答「智能体怎么接进来、绑定的账号能做什么、
// 它最近做了什么」。后端没有 MCP 专用接口，这里全部复用既有只读数据：
// Runtime 状态（diagnostics）、Service Account（Access & keys），以及按
// Service Account 过滤的 Audit 事实（Activity & Audit 共用同一批记录）。
function failureDescription(error: unknown, fallback: string, errorMessage: (code: string) => string | undefined) {
  return error instanceof ApiClientError ? errorMessage(error.apiError.code) ?? fallback : fallback;
}

function permissionTone(preset: ServiceAccount['permission']): 'outline' | 'primary' | 'warning' {
  if (preset === 'fullAccess') return 'primary';
  if (preset === 'custom') return 'warning';
  return 'outline';
}

function resultTone(result: string): 'ready' | 'unavailable' | 'info' {
  if (result === 'succeeded') return 'ready';
  if (result === 'denied' || result === 'failed') return 'unavailable';
  return 'info';
}

export function MCPGuidePage() {
  const { t, formatDate, errorMessage } = useI18n();
  const navigate = useNavigate();
  const { runtime } = useDiagnostics();
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [accountsState, setAccountsState] = useState<LoadState>('loading');
  const [accountsError, setAccountsError] = useState<unknown>();
  const [selectedId, setSelectedId] = useState<string>();
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [recordsState, setRecordsState] = useState<LoadState>('loading');
  const [recordsError, setRecordsError] = useState<unknown>();
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

  useEffect(() => {
    // 最近操作按绑定的 Service Account 过滤；Audit 是管理面安全事实的权威来源。
    if (accountsState !== 'ready') return;
    const controller = new AbortController();
    setRecordsState('loading');
    void listAuditRecords({
      limit: 8,
      actorKind: 'serviceAccount',
      ...(selected ? { actorId: selected.id } : {}),
    }, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setRecords(page.data);
      setRecordsError(undefined);
      setRecordsState('ready');
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setRecordsError(reason);
      setRecordsState('error');
    });
    return () => controller.abort();
  }, [accountsState, reloadKey, selected]);

  const commands = useMemo<AdminCommand[]>(() => [{
    id: 'surface.mcp',
    category: 'commands.categories.system',
    label: () => t('commands.mcp'),
    keywords: () => ['mcp', 'agent', 'coding agent', 'model context protocol'],
    execute: () => navigate('/mcp'),
  }], [navigate, t]);
  useRegisterCommands(commands);

  const runtimeReady = runtime.state === 'ready' && runtime.value.state === 'ready';
  const command = t('mcp.command');

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="sr-only">
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
                    className={`flex w-full flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:shadow-none ${isSelected ? 'border-primary bg-accent' : 'border-input bg-card '}`}
                    data-mcp-account-row
                    onClick={() => setSelectedId(account.id)}
                    type="button"
                  >
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
                  </ControlButton>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-5" variant="standard">
        <div className="flex items-start gap-2.5">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-ink-secondary"><ActivityIcon size={16} /></span>
          <div className="min-w-0">
            <h2>{t('mcp.activityTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected ? t('mcp.activityDescriptionFor', { name: selected.name }) : t('mcp.activityDescription')}</p>
          </div>
        </div>

        {recordsState === 'loading' && <LoadingState label={t('common.loading')} />}
        {recordsState === 'error' && (
          <ErrorState description={failureDescription(recordsError, t('mcp.activityUnavailable'), errorMessage)} title={t('mcp.activityUnavailable')}>
            <div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
          </ErrorState>
        )}
        {recordsState === 'ready' && records.length === 0 && (
          <EmptyState description={t('mcp.activityEmptyDescription')} title={t('mcp.activityEmptyTitle')} />
        )}
        {recordsState === 'ready' && records.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-mcp-agent-operations>
            {records.map((record) => (
              <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5" key={record.id}>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate font-mono text-xs font-semibold text-foreground">{record.action}</strong>
                  <small className="block truncate text-[11px] text-muted-foreground">
                    {String(record.resource.kind ?? '')}{typeof record.resource.id === 'string' ? ` · ${record.resource.id}` : ''} · {formatDate(record.time)}
                  </small>
                </span>
                <StatusChip state={resultTone(record.result)}>{record.result}</StatusChip>
                <Link className="text-xs font-semibold text-primary hover:underline" to={`/activity/audit/${encodeURIComponent(record.id)}`}>{t('activity.open')}</Link>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      <div className="flex flex-wrap items-center gap-2">
        <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/api">{t('navigation.apiWorkspace')}</Link>
        <span aria-hidden="true" className="text-subtle-foreground">·</span>
        <Link className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline" to="/api?tab=openapi">{t('api.workspaceTabs.openapi')}</Link>
      </div>
    </div>
  );
}
