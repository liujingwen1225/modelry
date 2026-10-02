import { expect, type Locator, type Page } from '@playwright/test';

type Selection = string | { label: string };

export async function selectOption(page: Page, trigger: Locator, selection: Selection | Selection[]) {
  await trigger.click();
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  const multiple = await menu.getAttribute('aria-multiselectable') === 'true';
  const choices = Array.isArray(selection) ? selection : [selection];
  for (const choice of choices) {
    const option = typeof choice === 'string'
      ? menu.locator('[data-slot="select-item"]').and(page.locator(`[data-value=${JSON.stringify(choice)}]`))
      : menu.getByRole('option', { name: choice.label, exact: true });
    if (!multiple || await option.getAttribute('aria-selected') !== 'true') await option.click();
  }
  if (multiple) await trigger.press('Escape');
  await expect(menu).not.toBeVisible();
}
