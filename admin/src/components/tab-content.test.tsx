import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../i18n/i18n';
import { TabContent } from './tab-content';

afterEach(() => vi.useRealTimers());

describe('页签切换过渡', () => {
  it('首次直接显示内容，连续切换只挂载最终页签', async () => {
    const mounted = vi.fn();
    function Panel({ name }: { name: string }) { mounted(name); return <p>{name}</p>; }
    const view = (name: string) => <LocaleProvider><TabContent activeKey={name}><Panel name={name} /></TabContent></LocaleProvider>;
    const { rerender } = render(view('A'));
    expect(await screen.findByText('A')).toBeInTheDocument();
    vi.useFakeTimers();
    rerender(view('B'));
    expect(screen.getByRole('status', { name: 'Switching tab…' })).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    rerender(view('C'));
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText('C')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60));
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalledWith('B');
  });

  it('切换返回原页签时取消待显示内容', async () => {
    const view = (name: string) => <LocaleProvider><TabContent activeKey={name}><p>{name}</p></TabContent></LocaleProvider>;
    const { rerender } = render(view('A'));
    await screen.findByText('A');
    vi.useFakeTimers();
    rerender(view('B'));
    rerender(view('A'));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.queryByText('B')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
