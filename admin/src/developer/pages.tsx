import { useMemo } from 'react';
import { ArrowRight, Bot } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useRegisterCommands, type AdminCommand } from '../components/command-registry';
import { CopyButton, Surface } from '../components/ui';
import { useI18n } from '../i18n/i18n';

export function MCPGuidePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const commands = useMemo<AdminCommand[]>(() => [{
    id: 'surface.mcp',
    category: 'commands.categories.system',
    label: () => t('commands.mcp'),
    keywords: () => ['mcp', 'agent', 'coding agent', 'model context protocol'],
    execute: () => navigate('/settings/mcp'),
  }], [navigate, t]);
  useRegisterCommands(commands);

  return <div className="page-stack">
    <header className="page-heading">
      <div>
        <p className="eyebrow">{t('settings.navigation.developer')}</p>
        <h1>{t('settings.navigation.mcp')}</h1>
        <p className="page-description">{t('overview.agentDescription')}</p>
      </div>
    </header>
    <Surface className="overview-agent-card" variant="standard">
      <span className="overview-agent-card__icon"><Bot aria-hidden="true" size={18} /></span>
      <div className="overview-agent-card__content">
        <h2>{t('overview.agentTitle')}</h2>
        <p>{t('overview.agentInstruction')}</p>
        <div className="overview-agent-card__command"><code>{t('overview.agentSetup')}</code><CopyButton label={t('common.copy')} value={t('overview.agentSetup')} /></div>
        <Link className="text-link" to="/access">{t('overview.agentAccessLink')}<ArrowRight aria-hidden="true" size={14} /></Link>
      </div>
    </Surface>
  </div>;
}
