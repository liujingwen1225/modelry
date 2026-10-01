import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Download, RefreshCw } from 'lucide-react';
import { useSearchParams, Link } from 'react-router-dom';
import { Button, ButtonLink } from '../components/button';
import { CopyButton } from '../components/copy-button';
import { EmptyState, ErrorState, LoadingState } from '../components/states';
import { Surface } from '../components/surface';
import { useI18n, type TranslationKey } from '../i18n/i18n';
import { ApiClientError } from './client';
import { RequestsPage } from './requests';
import { ApiEndpointBrowser } from './workspace';
import { fetchApplicationAPIContract, type ApplicationAPIContract } from '../portability/client';

// Spec 0001 §3 / §7.1：API 工作区是唯一的一级页面，四个 Tab 存在 URL 的 `?tab=` 里，
// 因此分享、刷新与前进/后退都落在同一个工作面：
//   endpoints（默认，端点浏览 + 内嵌 Runner）
//   playground（全宽请求工作面）
//   openapi（当前 Runtime 真实提供的契约 + 接入卡片）
//   logs（应用请求日志，保留 search / filter / sort / cursor / collection）
// 请求详情仍是独立路由 /api/requests/:requestId。

const workspaceTabs = ['endpoints', 'playground', 'openapi', 'logs'] as const;
type WorkspaceTab = typeof workspaceTabs[number];

const workspaceTabLabels: Record<WorkspaceTab, TranslationKey> = {
  endpoints: 'api.workspaceTabs.endpoints',
  playground: 'api.workspaceTabs.playground',
  openapi: 'api.workspaceTabs.openapi',
  logs: 'api.workspaceTabs.logs',
};

// 未知或缺失的 tab 一律归一到 endpoints，不制造 404 也不丢弃其它 query（spec 0001 §15）。
function activeTabFrom(value: string | null): WorkspaceTab {
  return workspaceTabs.includes(value as WorkspaceTab) ? value as WorkspaceTab : 'endpoints';
}

export function ApiWorkspacePage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [origin, setOrigin] = useState('');
  const activeTab = activeTabFrom(params.get('tab'));

  // Base URL 只在浏览器里读取；它是当前 Runtime 的来源，不写入任何持久状态。
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  // Tab 是 URL 状态：用真实链接表达，可分享、可新开标签页、可前进后退（spec 0001 §15）。
  // 切换 Tab 只改 `tab`：collection / endpoint / runLimit / runSearch / runFilter / runSort
  // 等共享上下文保留下来，从端点列表进入调试台时选中端点与输入因此不会丢（spec 0001 §7.1）。
  function tabTarget(tab: WorkspaceTab): string {
    const next = new URLSearchParams(params);
    next.set('tab', tab);
    return `/api?${next.toString()}`;
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="min-w-0">
        <p className="eyebrow">API</p>
        <h1>{t('api.workspaceTitle')}</h1>
        <p className="mt-2 max-w-[620px] text-[13px] leading-relaxed text-muted-foreground">{t('api.workspaceDescription')}</p>
      </header>

      <Surface className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-3.5 py-3" variant="standard">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className="text-[10px] font-bold tracking-[0.05em] text-muted-foreground uppercase">{t('api.baseUrlLabel')}</span>
          <code className="min-w-0 break-all font-mono text-xs text-foreground" data-api-base-url>{origin || '—'}</code>
        </div>
        {origin && <CopyButton label={t('api.copyBaseUrl')} value={origin} />}
      </Surface>

      {/* 真实 <nav> + <Link> 语义：键盘可达，当前 Tab 用 aria-current="page" 表达。 */}
      <nav aria-label={t('api.workspaceTabsLabel')} className="flex flex-wrap items-center gap-1 overflow-x-auto border-b">
        {workspaceTabs.map((tab) => (
          <Link
            aria-current={activeTab === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${activeTab === tab ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            key={tab}
            replace
            to={tabTarget(tab)}
          >
            {t(workspaceTabLabels[tab])}
          </Link>
        ))}
      </nav>

      {activeTab === 'endpoints' && <ApiEndpointBrowser variant="inline" />}
      {activeTab === 'playground' && <PlaygroundTab />}
      {activeTab === 'openapi' && <OpenApiTab />}
      {activeTab === 'logs' && <RequestLogPage />}
    </div>
  );
}

// 调试台：请求工作面占满整宽——方法/路径、参数与请求体、Run request，
// 然后固定展示 Response 的 status、duration 与 Request ID（spec 0001 §7.1）。
function PlaygroundTab() {
  const { t } = useI18n();
  return <div className="flex min-w-0 flex-col gap-4">
    <header className="min-w-0">
      <h2>{t('api.playgroundTitle')}</h2>
      <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('api.playgroundDescription')}</p>
    </header>
    <ApiEndpointBrowser variant="workspace" />
  </div>;
}

// /api?tab=logs：请求日志复用既有 RequestsPage 的筛选、分页与 allowlist 字段，
// 页面级标题让给 API 工作区，避免同一屏出现两个一级标题（spec 0001 §9.1）。
export function RequestLogPage() {
  return <RequestsPage embedded />;
}

// OpenAPI Tab：契约事实来自当前 Runtime 实际暴露的 Contract（/admin/api/v1/developer/contract）；
// 接入卡片只提供真实动作——下载契约、复制示例命令、SDK 生成指引与 MCP 说明入口（spec 0001 §7.1、§13.4）。
function OpenApiTab() {
  const { t, errorMessage } = useI18n();
  const [contract, setContract] = useState<ApplicationAPIContract>();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>();
  const [reloadKey, setReloadKey] = useState(0);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void fetchApplicationAPIContract(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setContract(value);
      setState('ready');
      setError(undefined);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason);
      setState('error');
    });
    return () => controller.abort();
  }, [reloadKey]);

  // 示例命令只使用契约里真实存在的第一个 Collection；契约为空时不虚构任何路由。
  const curlExample = useMemo(() => {
    const first = contract?.collections[0];
    if (!first || !origin) return undefined;
    return `curl -X GET '${origin}${contract?.apiBasePath ?? '/api/v1'}/${encodeURIComponent(first.name)}' -H 'Accept: application/json'`;
  }, [contract, origin]);

  const failureDescription = error instanceof ApiClientError
    ? errorMessage(error.apiError.code) ?? t('portability.loadFailedDescription')
    : t('portability.loadFailedDescription');

  function downloadContract() {
    if (!contract) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(contract, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'openapi.json';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="flex min-w-0 flex-col gap-4">
    <header className="min-w-0">
      <h2>{t('api.openApiTabTitle')}</h2>
      <p className="mt-1.5 max-w-[680px] text-[13px] leading-relaxed text-muted-foreground">{t('api.openApiTabDescription')}</p>
    </header>

    {state === 'loading' && <LoadingState label={t('api.loadingWorkspace')} />}
    {state === 'error' && (
      <ErrorState description={failureDescription} title={t('portability.loadFailed')}>
        <div className="mt-3"><Button onClick={() => setReloadKey((value) => value + 1)} size="small"><RefreshCw aria-hidden="true" size={14} /> {t('common.retry')}</Button></div>
      </ErrorState>
    )}

    {state === 'ready' && contract && <>
      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="min-w-0">
          <h3>{t('portability.contract.title')}</h3>
          <p className="mt-1.5 max-w-[720px] text-[13px] leading-relaxed text-muted-foreground">{t('portability.contract.description')}</p>
        </div>
        {contract.collections.length === 0
          ? <EmptyState description={t('api.noEndpointsDescription')} title={t('api.noEndpointsTitle')} />
          : <>
            <dl className="m-0 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-lg border bg-secondary px-3 py-2.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('portability.facts.runtimeVersion')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary">{contract.version}</dd></div>
              <div className="rounded-lg border bg-secondary px-3 py-2.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('portability.contract.hash')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary"><code className="font-mono" data-testid="contract-hash">{contract.contentHash}</code></dd></div>
              <div className="rounded-lg border bg-secondary px-3 py-2.5"><dt className="text-[11px] font-semibold text-muted-foreground">{t('portability.facts.collections')}</dt><dd className="m-0 mt-1 break-words text-xs text-ink-secondary">{contract.collections.length}</dd></div>
            </dl>
            <ul className="m-0 flex list-none flex-col p-0 text-xs">
              {contract.collections.slice(0, 5).map((collection) => (
                <li className="flex flex-wrap items-center gap-2.5 border-b py-2 last:border-b-0" key={collection.id}>
                  <strong className="text-xs font-semibold text-foreground">{collection.name}</strong>
                  <span className="text-[11px] text-muted-foreground">{collection.type}</span>
                  <code className="ml-auto font-mono text-[11px] text-ink-secondary">{collection.endpoints.length} {t('portability.contract.endpoints')}</code>
                </li>
              ))}
            </ul>
          </>}
      </Surface>

      <Surface className="flex min-w-0 flex-col gap-4 p-4" variant="standard">
        <div className="min-w-0">
          <h3>{t('api.integrationTitle')}</h3>
          <p className="mt-1.5 max-w-[720px] text-[13px] leading-relaxed text-muted-foreground">{t('api.integrationDescription')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={downloadContract} size="small" type="button" variant="primary"><Download aria-hidden="true" size={14} /> {t('api.downloadOpenApi')}</Button>
          {curlExample && <CopyButton label={t('api.copyCurl')} value={curlExample} />}
          <ButtonLink size="small" to="/mcp">{t('api.mcpLink')} <ArrowRight aria-hidden="true" size={14} /></ButtonLink>
        </div>
        {curlExample && <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border bg-muted px-3 py-2.5"><code className="min-w-0 break-all font-mono text-xs text-ink-secondary">{curlExample}</code></div>}
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">{t('api.sdkGuidance')}</p>
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground">{t('portability.contract.generateHint')}</p>
      </Surface>
    </>}
  </div>;
}
