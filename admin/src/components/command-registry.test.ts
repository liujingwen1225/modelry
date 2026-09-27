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
  });

  it('uses route visibility when no capability requirement is declared', () => {
    const context: CommandContext = {
      pathname: '/collections/col_posts',
      search: '',
      hash: '',
      collectionId: 'col_posts',
      principal: null,
      capabilities: [],
      navigate: () => undefined,
    };

    const visibleByDefault: AdminCommand = {
      id: 'navigation.workspace',
      category: 'commands.categories.navigate',
      label: () => 'Open workspace',
      execute: () => undefined,
    };
    const routeScoped: AdminCommand = {
      ...visibleByDefault,
      id: 'collection.create-record',
      isVisible: (value) => Boolean(value.collectionId),
    };

    expect(isCommandVisible(visibleByDefault, context)).toBe(true);
    expect(isCommandVisible(routeScoped, context)).toBe(true);
    expect(isCommandVisible({ ...routeScoped, isVisible: () => false }, context)).toBe(false);
    expect(isCommandVisible({ ...routeScoped, requiresCapabilities: [] }, context)).toBe(true);
  });

  it('supports future Admin capability names and hides commands until they are present', () => {
    const context: CommandContext = {
      pathname: '/settings',
      search: '',
      hash: '',
      principal: { kind: 'owner', id: 'owner_1' },
      capabilities: ['admin:owner-session'],
      navigate: () => undefined,
    };
    const command: AdminCommand = {
      id: 'settings.manage',
      category: 'commands.categories.system',
      label: () => 'Manage settings',
      requiresCapabilities: ['admin:settings-write'],
      execute: () => undefined,
    };

    expect(isCommandVisible(command, context)).toBe(false);
    expect(isCommandVisible(command, { ...context, capabilities: ['admin:settings-write'] })).toBe(true);
  });
});
