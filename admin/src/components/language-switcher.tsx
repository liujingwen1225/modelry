import { useI18n } from '../i18n/i18n';
import { Button } from './ui/button';

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const nextLocale = locale === 'en' ? 'zh-CN' : 'en';
  const label = t(locale === 'en' ? 'commands.switchToChinese' : 'commands.switchToEnglish');

  return (
    <Button
      aria-label={label}
      className="shrink-0 font-mono"
      size="icon"
      data-locale-switcher
      onClick={() => setLocale(nextLocale)}
      title={label}
      type="button"
      variant="ghost"
    >
      {locale === 'en' ? '中' : 'EN'}
    </Button>
  );
}
