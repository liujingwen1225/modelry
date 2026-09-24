import { describe, expect, it } from 'vitest';
import { createCommandRegistry, fuzzyMatch, isCommandVisible, type AdminCommand, type CommandContext } from './command-registry';

describe('Command Registry', () => {
  it('supports feature-owned command registration and removal', () => {
    const registry = createCommandRegistry<{ id: string; label: string }>();
    const command = { id: 'files.open', label: 'Open files' };
    const unregister = registry.register(command);

    expect(registry.list()).toEqual([command]);
    unregister();
    expect(registry.list()).toEqual([]);
  });

  it('rejects duplicate command IDs instead of silently replacing another surface command', () => {
    const registry = createCommandRegistry<{ id: string; label: string }>();
    registry.register({ id: 'api.open', label: 'Open API' });
    expect(() => registry.register({ id: 'api.open', label: 'Different action' })).toThrow(/api\.open/);
  });

  it('fuzzy matches only the supplied command label and keywords', () => {
    expect(fuzzyMatch('ccl', 'Create Collection', [])).toBe(true);
    expect(fuzzyMatch('schema', 'Open workspace', ['collection schema'])).toBe(true);
    expect(fuzzyMatch('record', 'Open workspace', ['collection schema'])).toBe(false);
    expect(fuzzyMatch('café', 'Cafe settings', [])).toBe(true);
  });

  it('checks declared Owner capabilities and route context without inventing missing claims', () => {
    const base: CommandContext = {
      pathname: '/collections/col_posts',
      search: '',
      hash: '',
      collectionId: 'col_posts',
      principal: { kind: 'owner', id: 'owner_1' },
      capabilities: [],
      navigate: () => undefined,
    };
    const command: AdminCommand = {
      id: 'collection.create-record',
      category: 'commands.categories.create',
      label: () => 'Create record',
      requiresCapabilities: ['admin:owner-session'],
      isVisible: (context) => Boolean(context.collectionId),
      execute: () => undefined,
    };

    expect(isCommandVisible(command, base)).toBe(false);
    expect(isCommandVisible(command, { ...base, capabilities: ['admin:owner-session'] })).toBe(true);
    expect(isCommandVisible(command, { ...base, capabilities: ['admin:owner-session'], collectionId: undefined })).toBe(false);
    expect(isCommandVisible({ ...command, requiresCapabilities: undefined, isVisible: undefined }, base)).toBe(true);
  });
});
