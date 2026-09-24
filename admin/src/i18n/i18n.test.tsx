import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LocaleProvider, loadLocaleBundle, translateMessage, useI18n, resolveInitialLocale, type Locale, type LocaleResources, type TranslationKey } from './i18n';
import { en } from './locales/en';

function LocaleProbe() {
  const { locale, setLocale, t, errorMessage, formatDate, formatNumber, formatRelativeTime, formatPlural } = useI18n();
  return (
    <div>
      <output aria-label="Current locale">{locale}</output>
      <output aria-label="Overview">{t('navigation.overview')}</output>
      <output aria-label="Unauthenticated error">{errorMessage('UNAUTHENTICATED')}</output>
      <output aria-label="Date">{formatDate(new Date('2026-01-02T03:04:05Z'), { dateStyle: 'short', timeZone: 'UTC' })}</output>
      <output aria-label="Number">{formatNumber(1234.5)}</output>
      <output aria-label="Relative time">{formatRelativeTime(-1, 'day')}</output>
      <output aria-label="Plural">{formatPlural(2, { one: 'one record', other: '{count} records' })}</output>
      <button onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')} type="button">Change locale</button>
    </div>
  );
}

describe('Admin i18n foundation', () => {
  it('uses a saved preference before the browser locale and uses the browser only for first default', () => {
    expect(resolveInitialLocale('en', 'zh-CN')).toBe('en');
    expect(resolveInitialLocale(undefined, 'zh-TW')).toBe('zh-CN');
    expect(resolveInitialLocale(undefined, 'en-US')).toBe('en');
    expect(resolveInitialLocale(undefined, 'fr-FR')).toBe('en');
  });

  it('loads structured locale resources lazily and safely falls back when a locale chunk fails', async () => {
    const loaded = await loadLocaleBundle('zh-CN');
    expect(loaded.locale).toBe('zh-CN');
    expect(loaded.messages?.navigation.overview).toBe('总览');

    const loader = async (locale: Locale): Promise<LocaleResources> => {
      if (locale === 'zh-CN') throw new Error('chunk load failed');
      return en;
    };
    const fallback = await loadLocaleBundle('zh-CN', loader);
    expect(fallback).toMatchObject({ locale: 'en', messages: en, englishFallback: en, failed: false });

    const unavailable = await loadLocaleBundle('zh-CN', async () => { throw new Error('chunk load failed'); });
    expect(unavailable).toMatchObject({ locale: 'en', messages: null, englishFallback: null, failed: true });
  });

  it('switches immediately, persists the locale, and formats values with Intl', async () => {
    window.localStorage.setItem('modelry-admin-locale', 'en');
    const user = userEvent.setup();
    render(<LocaleProvider><LocaleProbe /></LocaleProvider>);

    expect(await screen.findByLabelText('Overview')).toHaveTextContent('Overview');
    expect(screen.getByLabelText('Unauthenticated error')).toHaveTextContent('Your session has expired.');
    expect(screen.getByLabelText('Number')).toHaveTextContent(new Intl.NumberFormat('en').format(1234.5));
    await user.click(screen.getByRole('button', { name: 'Change locale' }));
    expect(screen.getByLabelText('Overview')).toHaveTextContent('总览');
    expect(screen.getByLabelText('Number')).toHaveTextContent(new Intl.NumberFormat('zh-CN').format(1234.5));
    expect(screen.getByLabelText('Date')).toHaveTextContent(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: 'UTC' }).format(new Date('2026-01-02T03:04:05Z')));
    expect(screen.getByLabelText('Relative time')).toHaveTextContent(new Intl.RelativeTimeFormat('zh-CN').format(-1, 'day'));
    expect(screen.getByLabelText('Plural')).toHaveTextContent('2 records');
    await waitFor(() => expect(window.localStorage.getItem('modelry-admin-locale')).toBe('zh-CN'));
  });

  it('fails visibly for missing keys in development/test without echoing interpolation values', () => {
    expect(() => translateMessage('en', 'missing.secretKey' as TranslationKey, { value: 'do-not-echo-this' }, en, en))
      .toThrow(/missing\.secretKey/);
    try {
      translateMessage('en', 'missing.secretKey' as TranslationKey, { value: 'do-not-echo-this' }, en, en);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo-this');
    }
  });
});
