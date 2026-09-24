import { describe, expect, it } from 'vitest';
import { createCommandRegistry, fuzzyMatch } from './command-registry';

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
});
