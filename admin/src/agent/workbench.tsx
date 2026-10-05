import { Link, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/i18n';
import { MCPConfiguration } from '../developer/pages';
import { AgentWorkspace } from './pages';

export function AgentPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const configuration = params.get('tab') === 'mcp';
  function destination(tab: 'agent' | 'mcp') {
    const next = new URLSearchParams(params);
    if (tab === 'mcp') next.set('tab', 'mcp'); else next.delete('tab');
    return '/agent' + (next.size ? '?' + next.toString() : '');
  }
  return <div className="flex min-w-0 flex-col gap-4">
    <header><h1 className="text-xl font-semibold">{t('agent.title')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('agent.description')}</p></header>
    <nav aria-label={t('agent.sections')} className="flex gap-4 border-b">
      {(['agent', 'mcp'] as const).map(tab => <Link key={tab} to={destination(tab)} aria-current={configuration === (tab === 'mcp') ? 'page' : undefined} className={'inline-flex min-h-11 items-center border-b-2 px-1 text-sm font-medium ' + (configuration === (tab === 'mcp') ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>{t(tab === 'mcp' ? 'agent.mcpConfiguration' : 'agent.workspaceTab')}</Link>)}
    </nav>
    {configuration ? <MCPConfiguration workspaceTo={destination('agent')} /> : <AgentWorkspace embedded />}
  </div>;
}
