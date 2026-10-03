import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

// 使用真实弹出菜单交互，避免继续把自定义 Select 当作原生 select。
export async function selectOption(user: Pick<ReturnType<typeof userEvent.setup>, 'click'>, trigger: Element, value: string) {
  await user.click(trigger);
  const options = await screen.findAllByRole('option');
  const option = options.find((item) => item.getAttribute('data-value') === value);
  if (!option) throw new Error(`找不到选项：${value}`);
  await user.click(option);
}
