import { useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useI18n } from '../i18n/i18n';
import { Button } from './button';

// 复制是用户可见能力：成功/失败都在控件自身与读屏文本里原地反馈（spec §13.1、§7.1）。
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const feedbackId = useId();

  async function handleCopy() {
    try {
      await copyText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <>
      <Button
        aria-label={label}
        aria-describedby={failed ? feedbackId : undefined}
        className="ml-auto min-h-6 px-1.5"
        onClick={() => void handleCopy()}
        size="small"
        type="button"
        variant="quiet"
      >
        {copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
      <span aria-live="polite" className="sr-only" id={feedbackId}>
        {failed ? t('common.copyFailed') : copied ? t('common.copiedToClipboard') : ''}
      </span>
    </>
  );
}
