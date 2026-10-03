import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SelectField } from './select-field';
import { selectOption } from '@/test-select';

const options = [
  { value: '', label: '请选择' },
  { value: 'title', label: '标题' },
  { value: 'body', label: '正文' },
  { value: 'missing', label: '密钥不可用', disabled: true },
];

function Form({ onSubmit }: { onSubmit: () => void }) {
  const [value, setValue] = useState('');
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <label htmlFor="field">字段</label>
    <SelectField id="field" value={value} onValueChange={setValue} options={options} aria-describedby="field-hint" />
    <p id="field-hint">选择已应用字段</p>
    <button type="submit">保存</button>
  </form>;
}

describe('共享选择控件', () => {
  it('关联标签和说明，选择不提交表单，Escape 后焦点返回', async () => {
    const user = userEvent.setup();
    const submit = vi.fn();
    render(<Form onSubmit={submit} />);
    const trigger = screen.getByRole('combobox', { name: '字段' });
    expect(trigger).toHaveAccessibleDescription('选择已应用字段');
    await selectOption(user, trigger, 'title');
    expect(trigger).toHaveTextContent('标题');
    expect(submit).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('option', { name: '密钥不可用' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('多选保留各字段并允许取消其中一项', async () => {
    const user = userEvent.setup();
    function MultiField() {
      const [value, setValue] = useState<string[]>([]);
      return <SelectField multiple aria-label="索引字段" value={value} onValueChange={setValue} options={options.slice(1, 3)} />;
    }
    render(<MultiField />);
    await user.click(screen.getByRole('combobox', { name: '索引字段' }));
    await user.click(await screen.findByRole('option', { name: '标题' }));
    await user.click(await screen.findByRole('option', { name: '正文' }));
    expect(screen.getByRole('option', { name: '标题' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: '正文' })).toHaveAttribute('aria-selected', 'true');
    await user.click(await screen.findByRole('option', { name: '标题' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('combobox', { name: '索引字段' })).toHaveAttribute('data-value', 'body');
  });
});
