import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Spec 0001 §17.2 / §18.6：对比度验证由自动化 Token 对比测试持续执行。
// 解析 globals.css 的 Light / Dark 两套语义 Token（hex 或 oklch，含 alpha），
// 以 WCAG 2.2 AA 校验关键前景/背景组合；状态色随 §17.2 的有限状态色集合一起校验，
// 并回归扫描品牌色残留（全部色值必须是 oklch，不允许 hex）。

function findFile(relative: string): string {
  const candidates = [resolve(process.cwd(), relative), resolve(process.cwd(), 'admin', relative)];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(relative + ' was not found from ' + process.cwd());
  return path;
}

function collectCssFiles(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectCssFiles(full));
    } else if (entry.endsWith('.css')) {
      results.push(full);
    }
  }
  return results;
}

type Palette = Record<string, string>;

// themeTokens parses globals.css and extracts each theme's palette.
function themeTokens(): Record<'light' | 'dark', Palette> {
  const css = readFileSync(findFile('src/styles/globals.css'), 'utf8');
  const themes: Record<'light' | 'dark', Palette> = { light: {}, dark: {} };
  const blocks = css.split('}');
  for (const block of blocks) {
    const selector = block.split('{')[0] ?? '';
    const body = block.split('{')[1] ?? '';
    const theme = selector.includes("data-theme='dark'") ? 'dark' : selector.includes("data-theme='light'") || selector.includes(':root') ? 'light' : null;
    if (theme === null) continue;
    for (const line of body.split(';')) {
      const separator = line.indexOf(':');
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key.startsWith('--') && /^((#[0-9a-fA-F]{3,8})|(oklch\([^)]*\)))$/.test(value)) themes[theme][key] = value;
    }
  }
  return themes;
}

function linearChannel(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function oklchToLinearRgb(lightness: number, chroma: number, hueDegrees: number): [number, number, number] {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function parseColor(value: string, theme: 'light' | 'dark'): [number, number, number] {
  if (value.startsWith('#')) {
    const cleaned = value.replace('#', '');
    const hex = cleaned.length <= 4 ? cleaned.split('').map((c) => c + c).join('') : cleaned;
    const alphaHex = hex.length === 8 ? hex.slice(6, 8) : null;
    const red = parseInt(hex.slice(0, 2), 16) / 255;
    const green = parseInt(hex.slice(2, 4), 16) / 255;
    const blue = parseInt(hex.slice(4, 6), 16) / 255;
    if (alphaHex === null) return [red, green, blue].map(linearChannel) as [number, number, number];
    const alpha = parseInt(alphaHex, 16) / 255;
    const backdrop = theme === 'dark' ? [0.09, 0.09, 0.09] : [1, 1, 1];
    return [red * alpha + backdrop[0]! * (1 - alpha), green * alpha + backdrop[1]! * (1 - alpha), blue * alpha + backdrop[2]! * (1 - alpha)].map(linearChannel) as [number, number, number];
  }
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/.exec(value);
  if (!match || !match[1] || !match[2] || !match[3]) throw new Error('unsupported colour value: ' + value);
  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = Number(match[3]);
  const [red, green, blue] = oklchToLinearRgb(lightness, chroma, hue);
  const alphaText = match[4];
  if (alphaText === undefined) return [red, green, blue];
  const alpha = alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  // 半透明边界/输入色按主题画布合成后再参与对比度计算。
  const backdropLinear = theme === 'dark' ? oklchToLinearRgb(0.145, 0, 0) : ([1, 1, 1] as [number, number, number]);
  return [
    red * alpha + backdropLinear[0] * (1 - alpha),
    green * alpha + backdropLinear[1] * (1 - alpha),
    blue * alpha + backdropLinear[2] * (1 - alpha),
  ];
}

function luminance(color: [number, number, number]): number {
  return 0.2126 * Math.min(1, Math.max(0, color[0])) + 0.7152 * Math.min(1, Math.max(0, color[1])) + 0.0722 * Math.min(1, Math.max(0, color[2]));
}

function contrast(foreground: string | undefined, background: string | undefined, theme: 'light' | 'dark'): number {
  if (!foreground || !background) throw new Error('a theme token is missing: ' + String(foreground) + ' on ' + String(background));
  const lighter = Math.max(luminance(parseColor(foreground, theme)), luminance(parseColor(background, theme)));
  const darker = Math.min(luminance(parseColor(foreground, theme)), luminance(parseColor(background, theme)));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('theme contrast (WCAG 2.2 AA)', () => {
  const themes = themeTokens();

  it('defines both light and dark palettes with the full semantic token set', () => {
    expect(Object.keys(themes.light).length).toBeGreaterThan(20);
    expect(Object.keys(themes.dark).length).toBeGreaterThan(20);
    for (const token of [
      '--foreground', '--ink-secondary', '--muted-foreground', '--card', '--secondary', '--background',
      '--primary', '--primary-foreground', '--destructive', '--destructive-foreground',
      '--sidebar', '--sidebar-foreground', '--sidebar-accent', '--border', '--input', '--ring',
      '--success', '--success-soft', '--warning', '--warning-soft', '--danger', '--danger-soft',
      '--info', '--info-soft',
    ]) {
      expect(themes.light[token], 'light ' + token).toBeDefined();
      expect(themes.dark[token], 'dark ' + token).toBeDefined();
    }
  });

  it('使用已知中性色验证线性亮度计算', () => {
    expect(contrast('oklch(0 0 0)', 'oklch(1 0 0)', 'light')).toBeCloseTo(21);
    expect(contrast('oklch(0.5 0 0)', 'oklch(1 0 0)', 'light')).toBeCloseTo(6, 2);
    expect(contrast('#000000', '#ffffff', 'light')).toBeCloseTo(21);
  });

  // WCAG AA：正文文本与主要表面至少 4.5:1；次要/静音文本同样至少 4.5:1。
  it.each(['light', 'dark'] as const)('keeps %s text readable on its surfaces', (theme) => {
    const palette = themes[theme];
    const surfaces = ['--card', '--secondary', '--background', '--sidebar', '--sidebar-accent'];
    for (const surface of surfaces) {
      expect(contrast(palette['--foreground'], palette[surface], theme), 'foreground on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette['--ink-secondary'], palette[surface], theme), 'secondary ink on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette['--subtle-foreground'], palette[surface], theme), 'subtle ink on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette['--muted-foreground'], palette[surface], theme), 'muted ink on ' + surface + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
    }
  });

  // Quiet Mono：主按钮与选中项使用黑白反差（Light 近黑底/近白字，Dark 反转）。
  it.each(['light', 'dark'] as const)('keeps %s action labels readable on their buttons', (theme) => {
    const palette = themes[theme];
    expect(contrast(palette['--primary-foreground'], palette['--primary'], theme), 'primary action ink (' + theme + ')').toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette['--destructive-foreground'], palette['--destructive'], theme), 'destructive action ink (' + theme + ')').toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette['--accent-foreground'], palette['--accent'], theme), 'accent ink (' + theme + ')').toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette['--sidebar-accent-foreground'], palette['--sidebar-accent'], theme), 'sidebar active ink (' + theme + ')').toBeGreaterThanOrEqual(4.5);
  });

  // 状态色（前景 + 柔和表面）承载状态文本标签，必须达到正文级 AA（spec 0001 §13.5 / §17.2）。
  it.each(['light', 'dark'] as const)('keeps %s status colours readable on their soft surfaces', (theme) => {
    const palette = themes[theme];
    for (const pair of [
      ['--success', '--success-soft'],
      ['--warning', '--warning-soft'],
      ['--danger', '--danger-soft'],
      ['--info', '--info-soft'],
      ['--accent-cta-ink', '--accent-cta-soft'],
    ] as const) {
      expect(contrast(palette[pair[0]], palette[pair[1]], theme), pair[0] + ' on ' + pair[1] + ' (' + theme + ')').toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('token hygiene', () => {
  it('keeps globals.css free of hex colours (all values are oklch)', () => {
    const css = readFileSync(findFile('src/styles/globals.css'), 'utf8');
    const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexMatches, 'unexpected hex colours in globals.css: ' + hexMatches.join(', ')).toHaveLength(0);
  });

  it('keeps the old brand colours out of every admin stylesheet', () => {
    const stylesDirectory = resolve(findFile('src/styles'), '..');
    const offenders: string[] = [];
    for (const file of collectCssFiles(stylesDirectory)) {
      const css = readFileSync(file, 'utf8');
      if (/#[0-9a-fA-F]{6}\b/.test(css)) offenders.push(file);
    }
    expect(offenders, 'brand-era hex colours remain in: ' + offenders.join(', ')).toHaveLength(0);
  });
});
