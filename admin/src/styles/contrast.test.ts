import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// themeTokens 解析 tokens.css，取出每个主题的调色板。
function themeTokens(): Record<'light' | 'dark', Record<string, string>> {
  const candidates = [resolve(process.cwd(), 'src/styles/tokens.css'), resolve(process.cwd(), 'admin/src/styles/tokens.css')];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error('tokens.css was not found from ' + process.cwd());
  const css = readFileSync(path, 'utf8');
  const themes: Record<'light' | 'dark', Record<string, string>> = { light: {}, dark: {} };
  const blocks = css.split('}');
  for (const block of blocks) {
    const selector = block.split('{')[0] ?? '';
    const body = block.split('{')[1] ?? '';
    const theme = selector.includes("data-theme='dark'") ? 'dark' : selector.includes('data-theme=\'light\'') || selector.includes(':root') ? 'light' : null;
    if (theme === null) continue;
    for (const line of body.split(';')) {
      const [name, value] = line.split(':');
      if (!name || !value) continue;
      const key = name.trim();
      if (key.startsWith('--color-')) themes[theme][key] = value.trim();
    }
  }
  return themes;
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const cleaned = hex.replace('#', '');
  const red = parseInt(cleaned.slice(0, 2), 16);
  const green = parseInt(cleaned.slice(2, 4), 16);
  const blue = parseInt(cleaned.slice(4, 6), 16);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrast(foreground: string | undefined, background: string | undefined): number {
  if (!foreground || !background) throw new Error('a theme token is missing: ' + String(foreground) + ' on ' + String(background));
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('theme contrast', () => {
  const themes = themeTokens();

  it('defines both light and dark palettes', () => {
    expect(Object.keys(themes.light).length).toBeGreaterThan(10);
    expect(Object.keys(themes.dark).length).toBeGreaterThan(10);
    for (const token of ['--color-ink', '--color-ink-secondary', '--color-ink-muted', '--color-surface', '--color-surface-soft', '--color-canvas']) {
      expect(themes.light[token], 'light ' + token).toBeDefined();
      expect(themes.dark[token], 'dark ' + token).toBeDefined();
    }
  });

  // WCAG AA：正文文本与主要表面至少 4.5:1；次要/静音文本至少 3:1。
  it.each(['light', 'dark'] as const)('keeps %s text readable on its surfaces', (theme) => {
    const palette = themes[theme];
    const surfaces = ['--color-surface', '--color-surface-soft', '--color-canvas'];
    for (const surface of surfaces) {
      expect(contrast(palette['--color-ink'], palette[surface]), 'ink on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette['--color-ink-secondary'], palette[surface]), 'secondary ink on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette['--color-ink-muted'], palette[surface]), 'muted ink on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(3);
    }
  });

  it.each(['light', 'dark'] as const)('keeps %s status colours readable on their soft surfaces', (theme) => {
    const palette = themes[theme];
    for (const pair of [
      ['--color-success', '--color-success-soft'],
      ['--color-warning', '--color-warning-soft'],
      ['--color-danger', '--color-danger-soft'],
      ['--color-info', '--color-info-soft'],
      ['--color-accent-ink', '--color-accent-soft'],
    ] as const) {
      expect(contrast(palette[pair[0]], palette[pair[1]]), pair[0] + ' on ' + pair[1] + ' (' + theme + ')').toBeGreaterThanOrEqual(3);
    }
  });

  it.each(['light', 'dark'] as const)('keeps %s action labels readable on their buttons', (theme) => {
    const palette = themes[theme];
    expect(contrast(palette['--color-accent-action-ink'], palette['--color-accent']), 'accent action ink (' + theme + ')').toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette['--color-danger-action-ink'], palette['--color-danger']), 'danger action ink (' + theme + ')').toBeGreaterThanOrEqual(4.5);
  });
});