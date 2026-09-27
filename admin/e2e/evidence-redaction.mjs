import { appendFile } from 'node:fs/promises';

const sensitiveValues = new Set();

const sensitiveKey = (key) => {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'password'
    || normalized === 'passwd'
    || normalized === 'passphrase'
    || normalized === 'credential'
    || normalized === 'credentials'
    || normalized === 'authorization'
    || normalized === 'bearer'
    || normalized === 'proxyauthorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized === 'secret'
    || normalized === 'secrets'
    || normalized === 'apikey'
    || normalized === 'accesstoken'
    || normalized === 'refreshtoken'
    || normalized === 'idtoken'
    || normalized === 'token'
    || normalized === 'sessiontoken'
    || normalized === 'sessionid'
    || normalized === 'sessioncookie'
    || normalized === 'session'
    || normalized === 'resetcode'
    || normalized === 'resettoken'
    || normalized === 'verificationcode'
    || normalized === 'verificationtoken'
    || normalized === 'onetimecode'
    || normalized === 'signingsecret'
    || normalized === 'secretvalue'
    || normalized === 'secretkey'
    || normalized.endsWith('password')
    || normalized.endsWith('passphrase')
    || normalized.endsWith('credential')
    || normalized.endsWith('authorization')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('apikey');
};

function addSensitiveValue(value) {
  if (typeof value === 'string' && value.length >= 4) sensitiveValues.add(value);
}

function collectNamedValues(value, key = '') {
  if (typeof value === 'string') {
    if (sensitiveKey(key)) addSensitiveValue(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedValues(item);
    if (key.toLowerCase().includes('header')) {
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const name = item.name ?? item.key;
        if (name && sensitiveKey(name)) addSensitiveValue(String(item.value ?? ''));
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) collectNamedValues(child, childKey);
}

export function registerSensitiveValue(value) {
  addSensitiveValue(String(value ?? ''));
}

export function collectSensitiveValues(value) {
  collectNamedValues(value);
}

export function currentSensitiveValues() {
  return [...sensitiveValues];
}

const sensitiveKeyPattern = '(?:password|passwd|passphrase|credentials?|authorization|proxy[-_]?authorization|bearer|set[-_]?cookie|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session(?:[-_]?(?:id|token|cookie))?|token|secret(?:[-_]?(?:key|value))?|signing[-_]?secret|(?:reset|verification|one[-_]?time)[-_]?(?:code|token)|otp)';
const sensitiveAssignment = new RegExp(`((?:\\\\?["']?)${sensitiveKeyPattern}(?:\\\\?["']?)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'gi');
const unquotedSensitiveAssignment = new RegExp(`((?:\\\\?["']?)${sensitiveKeyPattern}(?:\\\\?["']?)\\s*[:=]\\s*)(?!\\\\?["'])[^\\r\\n]+`, 'gi');

function replaceLiteral(text, value) {
  const variants = new Set([value]);
  try {
    variants.add(encodeURIComponent(value));
    variants.add(Buffer.from(value, 'utf8').toString('base64'));
    variants.add(Buffer.from(value, 'utf8').toString('base64url'));
  } catch { /* Keep the plain value if an alternate representation cannot be made. */ }
  for (const candidate of variants) {
    if (candidate.length >= 4 && text.includes(candidate)) text = text.split(candidate).join('[REDACTED]');
  }
  return text;
}

export function redactEvidenceText(value, extraSensitiveValues = []) {
  let text = String(value ?? '');
  const literals = [...new Set([...sensitiveValues, ...extraSensitiveValues].filter((entry) => typeof entry === 'string' && entry.length >= 4))]
    .sort((left, right) => right.length - left.length);
  for (const literal of literals) text = replaceLiteral(text, literal);

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { text = JSON.stringify(redactStructuredEvidence(JSON.parse(text), extraSensitiveValues)); }
    catch { /* Continue with text patterns when this is a partial JSON fragment. */ }
  }

  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/%=-]{4,}/gi, 'Bearer [REDACTED]')
    .replace(/\bmdl_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bapp_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SESSION_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_SESSION_TOKEN]')
    .replace(/((?:^|[?&])(?:password|passwd|passphrase|token|access_token|session_token|api_key|apiKey|secret|reset_code|verification_code|code|otp)=)[^&#\s]*/gim, '$1[REDACTED]')
    .replace(sensitiveAssignment, (_match, prefix, quotedValue) => `${prefix}${quotedValue[0]}[REDACTED]${quotedValue[0]}`)
    .replace(unquotedSensitiveAssignment, (_match, prefix) => `${prefix}[REDACTED]`)
    .replace(/(^|\n)(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/gim, '$1$2[REDACTED]')
    .replace(/<input\b[^>]*>/gi, (tag) => {
      const sensitive = /\btype\s*=\s*["']?password["']?/i.test(tag)
        || /\b(?:name|id|autocomplete)\s*=\s*(?:"[^"]*(?:password|secret|token|credential|api[-_ ]?key|session|reset|verification)[^"]*"|'[^']*(?:password|secret|token|credential|api[-_ ]?key|session|reset|verification)[^']*'|[^\s>]*(?:password|secret|token|credential|api[-_ ]?key|session|reset|verification)[^\s>]*)/i.test(tag);
      return sensitive ? tag.replace(/(\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, '$1"[REDACTED]"') : tag;
    });

  return text;
}

export function redactStructuredEvidence(value, extraSensitiveValues = []) {
  if (typeof value === 'string') return redactEvidenceText(value, extraSensitiveValues);
  if (Array.isArray(value)) return value.map((entry) => redactStructuredEvidence(entry, extraSensitiveValues));
  if (!value || typeof value !== 'object') return value;

  const pairedName = value.k ?? value.key ?? value.name;
  const pairedValue = Object.hasOwn(value, 'v') ? 'v' : Object.hasOwn(value, 'value') ? 'value' : undefined;
  if (pairedName && pairedValue && sensitiveKey(pairedName)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      key === pairedValue ? redactValueTree(child) : redactStructuredEvidence(child, extraSensitiveValues),
    ]));
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key) && (typeof child === 'string' || typeof child === 'number')) {
      output[key] = '[REDACTED]';
    } else if ((key === 'headers' || key === 'requestHeaders' || key === 'responseHeaders') && Array.isArray(child)) {
      output[key] = child.map((header) => {
        if (!header || typeof header !== 'object') return redactStructuredEvidence(header, extraSensitiveValues);
        const name = String(header.name ?? header.key ?? '');
        return sensitiveKey(name)
          ? { ...header, value: '[REDACTED]' }
          : redactStructuredEvidence(header, extraSensitiveValues);
      });
    } else if ((key === 'headers' || key === 'requestHeaders' || key === 'responseHeaders') && child && typeof child === 'object') {
      output[key] = Object.fromEntries(Object.entries(child).map(([header, headerValue]) => [
        header,
        sensitiveKey(header) ? '[REDACTED]' : redactStructuredEvidence(headerValue, extraSensitiveValues),
      ]));
    } else {
      output[key] = redactStructuredEvidence(child, extraSensitiveValues);
    }
  }
  return output;
}

function redactValueTree(value) {
  if (typeof value === 'string' || typeof value === 'number') return '[REDACTED]';
  if (Array.isArray(value)) return value.map(redactValueTree);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).map((key) => [key, redactValueTree(value[key])]));
}

export function collectSensitiveValuesFromText(text) {
  const source = String(text ?? '');
  try {
    collectNamedValues(JSON.parse(source));
  } catch { /* Text may be a log line, URL, or form body rather than JSON. */ }
  let query = source;
  try { query = new URL(source).search.slice(1); }
  catch {
    const queryStart = source.indexOf('?');
    if (queryStart >= 0) query = source.slice(queryStart + 1).split('#', 1)[0];
  }
  const params = new URLSearchParams(query);
  for (const [key, value] of params.entries()) if (sensitiveKey(key) || /^(?:code|otp)$/i.test(key)) addSensitiveValue(value);
}

export async function persistSensitiveValues(filePath) {
  if (!filePath || sensitiveValues.size === 0) return;
  await appendFile(filePath, `${JSON.stringify([...sensitiveValues])}\n`, { encoding: 'utf8', mode: 0o600 });
  sensitiveValues.clear();
}

export function evidenceMaskInitScript() {
  if (!document.documentElement) {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      evidenceMaskInitScript();
    });
    observer.observe(document, { childList: true });
    return;
  }
  const style = document.createElement('style');
  style.setAttribute('data-modelry-evidence-mask', 'true');
  style.textContent = `
    input[type="password"],
    input[autocomplete*="password" i],
    input[id*="secret" i],
    input[name*="secret" i],
    textarea[id*="secret" i],
    textarea[name*="secret" i],
    [data-evidence-sensitive],
    .access-reveal__secret,
    .access-reveal__secret * {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
      text-shadow: none !important;
      caret-color: transparent !important;
      text-decoration-color: transparent !important;
    }
    .access-reveal__secret {
      background-image: repeating-linear-gradient(135deg, #777 0 2px, #bbb 2px 4px) !important;
      border-radius: 3px !important;
    }
  `;
  (document.head ?? document.documentElement).append(style);

  const fieldHasSensitivePayload = (target) => {
    const labels = target.labels ? [...target.labels].map((label) => label.textContent ?? '').join(' ') : '';
    const attributes = [target.name, target.id, target.getAttribute('autocomplete'), target.getAttribute('aria-label'), labels].join(' ');
    if (/(?:password|passwd|passphrase|secret|token|api[-_ ]?key|authorization|credential|verification|reset)/i.test(attributes)) return true;
    try {
      const value = JSON.parse(target.value);
      const inspect = (item) => {
        if (!item || typeof item !== 'object') return false;
        return Object.entries(item).some(([key, child]) => {
          const named = /(?:password|passwd|passphrase|secret|token|api[-_ ]?key|authorization|credential|verification|reset|otp)/i.test(key);
          return (named && typeof child === 'string') || inspect(child);
        });
      };
      return inspect(value);
    } catch { return false; }
  };
  const collectField = (target) => {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const sensitive = target.type === 'password' || fieldHasSensitivePayload(target);
    if (!sensitive) return;
    target.dataset.evidenceSensitive = 'true';
    if (typeof window.__modelryRecordEvidenceSecret === 'function') window.__modelryRecordEvidenceSecret(target.value);
  };
  const collectFields = (root) => {
    if (!(root instanceof Element || root instanceof Document)) return;
    if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) collectField(root);
    root.querySelectorAll('input,textarea').forEach(collectField);
  };
  document.addEventListener('input', (event) => collectField(event.target), true);
  document.addEventListener('change', (event) => collectField(event.target), true);

  const collectReveal = (root) => {
    const element = root instanceof Element ? root : root instanceof CharacterData ? root.parentElement : null;
    if (!(element instanceof Element)) return;
    const nodes = [];
    const ancestor = element.closest('.access-reveal__secret,[data-evidence-sensitive]');
    if (ancestor) nodes.push(ancestor);
    if (element.matches('.access-reveal__secret,[data-evidence-sensitive]')) nodes.push(element);
    nodes.push(...element.querySelectorAll('.access-reveal__secret,[data-evidence-sensitive]'));
    for (const node of nodes) {
      const code = node.querySelector('code');
      const value = (code?.textContent ?? node.textContent ?? '').trim();
      if (value && typeof window.__modelryRecordEvidenceSecret === 'function') window.__modelryRecordEvidenceSecret(value);
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) {
        const changedElement = node instanceof Element ? node : node instanceof CharacterData ? node.parentElement : null;
        if (changedElement) collectFields(changedElement);
        collectReveal(changedElement);
      }
      if (record.type === 'characterData') collectReveal(record.target.parentElement);
      if (record.type === 'attributes') collectReveal(record.target);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-evidence-sensitive'] });
  document.addEventListener('DOMContentLoaded', () => {
    collectFields(document.documentElement);
    collectReveal(document.documentElement);
  }, { once: true });
  collectFields(document.documentElement);
  collectReveal(document.documentElement);
}

export async function installEvidenceProtection(context) {
  await context.exposeBinding('__modelryRecordEvidenceSecret', (_source, value) => {
    if (typeof value === 'string') registerSensitiveValue(value);
  });
  await context.addInitScript(evidenceMaskInitScript);
}

export function observeEvidencePage(page) {
  const pending = new Set();
  const track = (task) => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  page.on('request', (request) => {
    collectSensitiveValuesFromText(request.url());
    collectSensitiveValuesFromText(request.postData() ?? '');
    track(request.allHeaders().then(collectSensitiveValues).catch(() => undefined));
  });
  page.on('response', (response) => {
    track((async () => {
      collectSensitiveValuesFromText(response.url());
      const headers = await response.allHeaders();
      collectSensitiveValues(headers);
      const contentType = headers['content-type'] ?? '';
      if (!/^application\/(?:json|[^;]+\+json)(?:\s*;|$)/i.test(contentType)) return;
      const contentLength = Number(headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > 1_048_576) return;
      const body = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 2_000);
        void response.text().then((text) => {
          clearTimeout(timer);
          resolve(text.length <= 1_048_576 ? text : undefined);
        }, () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      if (typeof body === 'string') collectSensitiveValuesFromText(body);
    })().catch(() => undefined));
  });
  return async () => { await Promise.allSettled([...pending]); };
}
