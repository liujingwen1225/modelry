import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TranslationKey } from '../i18n/i18n';

export type AdminCapability = `admin:${string}`;

export type CommandPrincipal = { kind: 'owner'; id: string };

export type CommandContext = {
  pathname: string;
  search: string;
  hash: string;
  collectionId?: string;
  principal: CommandPrincipal | null;
  capabilities: readonly AdminCapability[];
  navigate: (to: string) => void;
};

export type AdminCommand = {
  id: string;
  category: TranslationKey;
  label: (context: CommandContext) => string;
  keywords?: (context: CommandContext) => string[];
  requiresCapabilities?: readonly AdminCapability[];
  isVisible?: (context: CommandContext) => boolean;
  isEnabled?: (context: CommandContext) => boolean;
  execute: (context: CommandContext) => void;
};

export type RecentCollection = { id: string; name: string; type: 'Normal' | 'Auth' };

const recentCollectionsKey = 'modelry-admin-recent-collections';

function readRecentCollections(): RecentCollection[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(recentCollectionsKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item: unknown): item is RecentCollection =>
      typeof item === 'object' && item !== null
      && 'id' in item && typeof item.id === 'string' && item.id.length > 0
      && 'name' in item && typeof item.name === 'string'
      && 'type' in item && (item.type === 'Normal' || item.type === 'Auth'),
    ).slice(0, 5);
  } catch {
    return [];
  }
}

export function createCommandRegistry<T extends { id: string }>() {
  const entries = new Map<string, T>();
  return {
    list: () => [...entries.values()],
    register(command: T) {
      if (entries.has(command.id)) throw new Error(`A command with ID "${command.id}" is already registered.`);
      entries.set(command.id, command);
      return () => {
        if (entries.get(command.id) === command) entries.delete(command.id);
      };
    },
  };
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

function subsequence(query: string, value: string): boolean {
  const queryCharacters = Array.from(query);
  const valueCharacters = Array.from(value);
  let queryIndex = 0;
  for (const character of valueCharacters) {
    if (character === queryCharacters[queryIndex]) queryIndex += 1;
    if (queryIndex === queryCharacters.length) return true;
  }
  return queryCharacters.length === 0;
}

export function fuzzyMatch(query: string, label: string, keywords: readonly string[] = []): boolean {
  const normalizedQuery = normalize(query.trim());
  if (!normalizedQuery) return true;
  return [label, ...keywords].some((candidate) => subsequence(normalizedQuery, normalize(candidate)));
}

export function isCommandVisible(command: AdminCommand, context: CommandContext): boolean {
  const required = command.requiresCapabilities;
  if (required?.some((capability) => !context.capabilities.includes(capability))) return false;
  return !command.isVisible || command.isVisible(context);
}

type RegistryContextValue = {
  commands: AdminCommand[];
  register: (command: AdminCommand) => () => void;
  recentCollections: RecentCollection[];
  rememberCollection: (collection: RecentCollection) => void;
};

const RegistryContext = createContext<RegistryContextValue | null>(null);

export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const registry = useRef(createCommandRegistry<AdminCommand>());
  const [revision, setRevision] = useState(0);
  const [recentCollections, setRecentCollections] = useState<RecentCollection[]>(readRecentCollections);
  const register = useCallback((command: AdminCommand) => {
    const unregister = registry.current.register(command);
    setRevision((value) => value + 1);
    return () => {
      unregister();
      setRevision((value) => value + 1);
    };
  }, []);
  const commands = useMemo(() => registry.current.list(), [revision]);
  const rememberCollection = useCallback((collection: RecentCollection) => {
    setRecentCollections((previous) => {
      if (previous[0]?.id === collection.id && previous[0]?.name === collection.name && previous[0]?.type === collection.type) return previous;
      const recent = [collection, ...previous.filter((item) => item.id !== collection.id)].slice(0, 5);
      try {
        window.localStorage.setItem(recentCollectionsKey, JSON.stringify(recent));
      } catch {
          // 最近访问记录只用于本地导航便利性。
      }
      return recent;
    });
  }, []);
  const value = useMemo(() => ({ commands, register, recentCollections, rememberCollection }), [commands, register, recentCollections, rememberCollection]);
  return <RegistryContext.Provider value={value}>{children}</RegistryContext.Provider>;
}

export function useCommandRegistry(): RegistryContextValue {
  const context = useContext(RegistryContext);
  if (!context) throw new Error('useCommandRegistry must be used inside CommandRegistryProvider.');
  return context;
}

export function useRegisterCommands(commands: readonly AdminCommand[]) {
  const { register } = useCommandRegistry();
  useEffect(() => {
    const unregister = commands.map((command) => register(command));
    return () => unregister.reverse().forEach((remove) => remove());
  }, [commands, register]);
}
