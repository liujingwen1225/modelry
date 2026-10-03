import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { WorkspaceActions, WorkspaceToolbar } from './workspace-toolbar';

describe('共享顶部工作栏', () => {
  it('操作移到导航右侧后仍保留事件和状态，卸载工作面时清除操作', async () => {
    function Panel() {
      const [count, setCount] = useState(0);
      return <><WorkspaceActions><button onClick={() => setCount(count + 1)}>刷新 {count}</button></WorkspaceActions><p>内容</p></>;
    }
    const { container, rerender } = render(<WorkspaceToolbar navigation={<nav>页签</nav>}><Panel /></WorkspaceToolbar>);
    const toolbar = container.querySelector('[data-workspace-toolbar]') as HTMLElement;
    await userEvent.click(within(toolbar).getByRole('button', { name: '刷新 0' }));
    expect(within(toolbar).getByRole('button', { name: '刷新 1' })).toBeInTheDocument();
    rerender(<WorkspaceToolbar navigation={<nav>页签</nav>}><p>其它内容</p></WorkspaceToolbar>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('独立工作面保留原有操作位置', () => {
    render(<WorkspaceActions><button>创建</button></WorkspaceActions>);
    expect(screen.getByRole('button', { name: '创建' })).toBeInTheDocument();
  });
});
