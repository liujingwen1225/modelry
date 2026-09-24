import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Command, Search, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOwnerSession } from '../auth/owner-session';
import { useI18n } from '../i18n/i18n';
import { fuzzyMatch, isCommandVisible, useCommandRegistry, type AdminCommand, type CommandContext } from './command-registry';
import { collectionIdFromPathname } from './route-context';

function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad/i.test(platform);
}

export function commandPaletteShortcut(platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return isMacPlatform(platform) ? '⌘K' : 'Ctrl+K';
}

function CommandPaletteDialog({
  commands,
  context,
  onClose,
  shortcut,
}: {
  commands: AdminCommand[];
  context: CommandContext;
  onClose: () => void;
  shortcut: string;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filtered = useMemo(() => commands
    .filter((command) => isCommandVisible(command, context))
    .map((command) => ({ command, label: command.label(context), keywords: command.keywords?.(context) ?? [] }))
    .filter(({ label, keywords }) => fuzzyMatch(query, label, keywords)), [commands, context, query]);

  useEffect(() => {
    inputRef.current?.focus();
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [filtered.length, selectedIndex]);

  function execute(index: number) {
    const item = filtered[index];
    if (!item || !isCommandVisible(item.command, context) || (item.command.isEnabled && !item.command.isEnabled(context))) return;
    item.command.execute(context);
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' && filtered.length > 0) {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp' && filtered.length > 0) {
      event.preventDefault();
      setSelectedIndex((index) => (index - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      execute(selectedIndex);
      return;
    }
    if (event.key === 'Tab') {
      const activeElement = document.activeElement;
      if (event.shiftKey && activeElement === inputRef.current) {
        event.preventDefault();
        closeRef.current?.focus();
      } else if (!event.shiftKey && activeElement === closeRef.current) {
        event.preventDefault();
        inputRef.current?.focus();
      } else if (activeElement !== inputRef.current && activeElement !== closeRef.current) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
  }

  function dismissOutside(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="command-palette-overlay" onMouseDown={dismissOutside}>
      <section
        aria-label={t('commands.paletteTitle')}
        aria-modal="true"
        className="command-palette"
        data-command-palette="true"
        onKeyDown={handleKeyDown}
        role="dialog"
      >
        <div className="command-palette__search">
          <Search aria-hidden="true" size={18} />
          <input
            aria-activedescendant={filtered[selectedIndex] ? `command-option-${filtered[selectedIndex].command.id}` : undefined}
            aria-controls="command-palette-options"
            aria-expanded="true"
            aria-label={t('commands.searchLabel')}
            autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
            placeholder={t('commands.searchLabel')}
            ref={inputRef}
            role="combobox"
            type="search"
            value={query}
          />
          <button aria-label={t('shell.paletteClose')} className="command-palette__close" onClick={onClose} ref={closeRef} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </div>
        <div aria-label={t('commands.paletteTitle')} className="command-palette__results" id="command-palette-options" role="listbox">
          {filtered.length > 0 && filtered.map(({ command, label }, index) => (
            <div
              aria-label={label}
              aria-disabled={command.isEnabled ? !command.isEnabled(context) : undefined}
              aria-selected={index === selectedIndex}
              className={`command-palette__option${index === selectedIndex ? ' command-palette__option--active' : ''}`}
              id={`command-option-${command.id}`}
              key={command.id}
              onClick={() => execute(index)}
              onMouseDown={(event) => event.preventDefault()}
              ref={(element) => { optionRefs.current[index] = element; }}
              role="option"
            >
              <span>{label}</span>
              <span className="command-palette__category">{t(command.category)}</span>
            </div>
          ))}
        </div>
        {filtered.length === 0 && <p className="command-palette__empty" role="status">{t('shell.paletteEmpty')}</p>}
        <footer className="command-palette__footer">
          <span>{t('shell.paletteHint')}</span>
          <span><kbd>{shortcut}</kbd></span>
        </footer>
      </section>
    </div>
  );
}

export function CommandPaletteControl() {
  const { commands } = useCommandRegistry();
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const { state: ownerSession } = useOwnerSession();
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const shortcut = commandPaletteShortcut();
  const ownerId = ownerSession.status === 'authenticated' ? ownerSession.session.owner.id : undefined;
  const context = useMemo<CommandContext>(() => {
    const collectionId = collectionIdFromPathname(pathname);
    const principal = ownerId ? { kind: 'owner' as const, id: ownerId } : null;
    return {
      pathname,
      search,
      hash,
      ...(collectionId ? { collectionId } : {}),
      principal,
      capabilities: principal ? ['admin:owner-session'] : [],
      navigate: (to) => navigate(to),
    };
  }, [pathname, search, hash, navigate, ownerId]);

  function showPalette() {
    const active = document.activeElement;
    previousFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : triggerRef.current;
    setOpen(true);
  }

  function closePalette() {
    setOpen(false);
    window.setTimeout(() => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
      else triggerRef.current?.focus();
    }, 0);
  }

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (open || event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      showPalette();
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [open]);

  const shortcutName = /⌘/.test(shortcut) ? 'Meta+K' : 'Control+K';
  return (
    <>
      <button
        aria-keyshortcuts={shortcutName}
        className="command-palette-trigger"
        onClick={showPalette}
        ref={triggerRef}
        title={`${t('shell.paletteTrigger')} (${shortcut})`}
        type="button"
      >
        <Command aria-hidden="true" size={15} />
        <span className="command-palette-trigger__label">{t('shell.paletteTrigger')}</span>
        <kbd>{shortcut}</kbd>
      </button>
      {open && <CommandPaletteDialog commands={commands} context={context} onClose={closePalette} shortcut={shortcut} />}
    </>
  );
}
