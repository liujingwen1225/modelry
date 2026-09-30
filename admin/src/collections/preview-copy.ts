import type { TranslationKey } from '../i18n/i18n';

// Model Review 与 Changes Review 共用同一份运行时预览措辞，
// 避免同一份 Risk / Precondition 在两个入口被翻译成不同语言。
export type PreviewTranslate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export const preconditionMessageKeys: Record<string, TranslationKey> = {
  INVALID_MODEL: 'schema.preconditionMessages.invalidModel',
  REQUIRED_FIELD_NEEDS_DEFAULT: 'schema.preconditionMessages.requiredFieldNeedsDefault',
  RELATION_TARGET_MISSING: 'schema.preconditionMessages.relationTargetMissing',
  UNIQUE_VALUES_CONFLICT: 'schema.preconditionMessages.uniqueValuesConflict',
  FIELD_VALUE_INCOMPATIBLE: 'schema.preconditionMessages.fieldValueIncompatible',
  MODEL_COMPATIBLE: 'schema.preconditionMessages.modelCompatible',
};

export function preconditionMessage(code: unknown, t: PreviewTranslate) {
  const key = typeof code === 'string' ? preconditionMessageKeys[code] : undefined;
  return key ? t(key) : t('schema.preconditionMessages.fallback');
}

export function preconditionStatus(status: unknown, t: PreviewTranslate) {
  if (status === 'passed' || status === 'failed') return t(`schema.preconditionStatuses.${status}` as TranslationKey);
  return t('schema.preconditionStatuses.unknown');
}

export function diffLabel(change: Record<string, unknown>, t: PreviewTranslate) {
  if (typeof change.name === 'string') return change.name;
  const kind = String(change.kind ?? '');
  const action = String(change.action ?? '');
  return kind && action ? t('schema.changeFallback', { kind, action }) : t('schema.itemFallback');
}
