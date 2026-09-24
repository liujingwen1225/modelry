import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { en } from './locales/en';

export type Locale = 'en' | 'zh-CN';
type WidenResource<T> = T extends string ? string : { [Key in keyof T]: WidenResource<T[Key]> };
export type LocaleResources = WidenResource<typeof en>;
export type TranslationKey<T = LocaleResources> = T extends string
  ? never
  : { [Key in keyof T & string]: T[Key] extends string ? Key : `${Key}.${TranslationKey<T[Key]>}` }[keyof T & string];
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
export type TranslationValues = Record<string, string | number>;
export type LocaleResourceLoader = (locale: Locale) => Promise<LocaleResources>;
export type LoadedLocaleBundle = {
  locale: Locale;
  messages: LocaleResources | null;
  englishFallback: LocaleResources | null;
  failed: boolean;
};

const preferenceKey = 'modelry-admin-locale';
const apiErrorKeys: Record<string, TranslationKey> = {
  UNAUTHENTICATED: 'errors.unauthenticated',
  AUTHORIZATION_DENIED: 'errors.authorizationDenied',
  NOT_FOUND: 'errors.notFound',
  VALIDATION_FAILED: 'errors.validationFailed',
};
const resourceCache = new Map<Locale, Promise<LocaleResources>>();

export function resolveInitialLocale(preference: string | null | undefined, browserLocale: string | undefined): Locale {
  if (preference === 'en' || preference === 'zh-CN') return preference;
  if (preference !== null && preference !== undefined) return 'en';
  const normalizedBrowserLocale = browserLocale?.trim().toLowerCase();
  if (normalizedBrowserLocale === 'zh-cn') return 'zh-CN';
  if (normalizedBrowserLocale === 'en') return 'en';
  return 'en';
}

function defaultLocaleResourceLoader(locale: Locale): Promise<LocaleResources> {
  const cached = resourceCache.get(locale);
  if (cached) return cached;

  const pending = locale === 'en'
    ? import('./locales/en').then((module) => module.en)
    : import('./locales/zh-CN').then((module) => module.zhCN);
  resourceCache.set(locale, pending);
  void pending.catch(() => resourceCache.delete(locale));
  return pending;
}

export async function loadLocaleBundle(locale: Locale, loader: LocaleResourceLoader = defaultLocaleResourceLoader): Promise<LoadedLocaleBundle> {
  try {
    const messages = await loader(locale);
    if (locale === 'en') return { locale, messages, englishFallback: messages, failed: false };
    let englishFallback: LocaleResources | null = null;
    try { englishFallback = await loader('en'); }
    catch { /* 完整的当前 locale 可在英语 fallback 模块不可用时继续使用。 */ }
    return { locale, messages, englishFallback, failed: false };
  } catch {
    if (locale !== 'en') {
      try {
        const english = await loader('en');
        return { locale: 'en', messages: english, englishFallback: english, failed: false };
      } catch {
        // 继续显示明确的加载恢复状态，不把模块加载错误或资源内容暴露给用户。
      }
    }
    return { locale: 'en', messages: null, englishFallback: null, failed: true };
  }
}

function lookup(resource: unknown, key: string): string | undefined {
  let current: unknown = resource;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(message: string, values: TranslationValues = {}): string {
  return message.replace(/\{([a-zA-Z][\w]*)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
  );
}

export function translateMessage(
  locale: Locale,
  key: TranslationKey,
  values: TranslationValues = {},
  messages?: LocaleResources | null,
  englishFallback?: LocaleResources | null,
): string {
  if (!messages) {
    if (import.meta.env.MODE !== 'production') throw new Error(`Locale resources are unavailable for "${locale}".`);
    return `⟪${key}⟫`;
  }
  const selected = lookup(messages, key);
  if (selected !== undefined) return interpolate(selected, values);

  if (import.meta.env.MODE !== 'production') {
    // 只报告稳定 key 和 locale，避免把插值中的用户数据写入诊断信息。
    throw new Error(`Missing translation key "${key}" for locale "${locale}".`);
  }

  const fallback = lookup(englishFallback, key);
  return fallback === undefined ? `⟪${key}⟫` : interpolate(fallback, values);
}

function savedPreference(): string | null {
  try { return window.localStorage.getItem(preferenceKey); }
  catch { return null; }
}

function initialLocale(): Locale {
  return resolveInitialLocale(savedPreference(), typeof navigator === 'undefined' ? undefined : navigator.language);
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, values?: TranslationValues) => string;
  errorMessage: (canonicalCode: string) => string | undefined;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => string;
  formatPlural: (value: number, forms: Partial<Record<PluralCategory, string>>, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [requestedLocale] = useState(initialLocale);
  const [locale, setLocaleState] = useState<Locale>(requestedLocale);
  const [bundle, setBundle] = useState<LoadedLocaleBundle | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    let active = true;
    const version = ++requestVersion.current;
    void loadLocaleBundle(requestedLocale).then((loaded) => {
      if (!active || requestVersion.current !== version) return;
      setBundle(loaded);
      setLocaleState(loaded.locale);
    });
    return () => { active = false; };
  }, [requestedLocale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    if (bundle?.locale === nextLocale && !bundle.failed) return;
    const version = ++requestVersion.current;
    void loadLocaleBundle(nextLocale).then((loaded) => {
      if (requestVersion.current !== version) return;
      setBundle(loaded);
      setLocaleState(loaded.locale);
    });
  }, [bundle]);

  useEffect(() => {
    document.documentElement.lang = locale;
    try { window.localStorage.setItem(preferenceKey, locale); }
    catch { /* 当前会话中的 locale 选择仍然有效。 */ }
  }, [locale]);

  const translate = useCallback((key: TranslationKey, values?: TranslationValues) =>
    translateMessage(locale, key, values, bundle?.messages, bundle?.englishFallback), [bundle, locale]);
  const errorMessage = useCallback((canonicalCode: string) => {
    const key = apiErrorKeys[canonicalCode];
    return key ? translate(key) : undefined;
  }, [translate]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    t: translate,
    errorMessage,
    formatDate: (input, options) => new Intl.DateTimeFormat(locale, options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(input instanceof Date ? input : new Date(input)),
    formatNumber: (input, options) => new Intl.NumberFormat(locale, options).format(input),
    formatRelativeTime: (input, unit, options) => new Intl.RelativeTimeFormat(locale, options).format(input, unit),
    formatPlural: (input, forms, values = {}) => {
      const category = new Intl.PluralRules(locale).select(input) as PluralCategory;
      const phrase = forms[category] ?? forms.other ?? String(input);
      return interpolate(phrase, { count: input, ...values });
    },
  }), [locale, setLocale, translate, errorMessage]);

  if (!bundle) return <div aria-label="Loading Admin language resources" className="locale-load-state" role="status">Loading Admin…</div>;
  if (bundle.failed) {
    return <div className="locale-load-error" role="alert">Admin language resources could not be loaded. Refresh to retry.</div>;
  }
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside LocaleProvider.');
  return context;
}
