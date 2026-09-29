import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Command, Search, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOwnerSession } from '../auth/owner-session';
import { useI18n } from '../i18n/i18n';
import { fuzzyMatch, isCommandVisible, useCommandRegistry, type AdminCommand, type CommandContext } from './command-registry';
import { collectionIdFromPathname } from './route-context';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Button } from './ui';
import { Input } from '@/components/ui/input';

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
  const titleId = useId();
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
    if (event.key === 'Tab') {
      const popup = event.currentTarget;
      const focusable = popup.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
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
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-30 bg-[rgb(12_19_23_/_48%)] backdrop-blur-[2px]" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <DialogPrimitive.Popup
            aria-labelledby={titleId}
            className="flex max-h-[min(72vh,640px)] w-[min(100%,620px)] flex-col overflow-hidden rounded-lg border bg-card text-foreground shadow-floating outline-none"
            data-command-palette="true"
            initialFocus={inputRef}
            onKeyDown={handleKeyDown}
          >
        <DialogPrimitive.Title className="sr-only" id={titleId}>{t('commands.paletteTitle')}</DialogPrimitive.Title>
        <div className="flex min-h-[60px] items-center gap-3 border-b px-4 text-muted-foreground">
          <Search aria-hidden="true" size={18} />
          <Input
            aria-activedescendant={filtered[selectedIndex] ? `command-option-${filtered[selectedIndex].command.id}` : undefined}
            aria-controls="command-palette-options"
            aria-expanded="true"
            aria-label={t('commands.searchLabel')}
            autoComplete="off"
            className="min-h-0 rounded-none border-0 bg-transparent px-0 py-0 text-sm focus-visible:border-0 focus-visible:outline-0 focus-visible:ring-0"
            onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
            placeholder={t('commands.searchLabel')}
            ref={inputRef}
            role="combobox"
            type="search"
            value={query}
          />
          <Button aria-label={t('shell.paletteClose')} className="size-8 min-h-8 shrink-0 px-0" onClick={onClose} type="button" variant="quiet">
            <X aria-hidden="true" size={16} />
          </Button>
        </div>
        <div aria-label={t('commands.paletteTitle')} className="min-h-12 overflow-y-auto p-1.5" id="command-palette-options" role="listbox">
          {filtered.length > 0 && filtered.map(({ command, label }, index) => (
            <div
              aria-label={label}
              aria-disabled={command.isEnabled ? !command.isEnabled(context) : undefined}
              aria-selected={index === selectedIndex}
              className={`flex min-h-10 items-center justify-between gap-3 rounded-md px-2.5 text-xs text-ink-secondary outline-none transition-colors hover:bg-accent-cta-soft hover:text-accent-cta-ink${index === selectedIndex ? ' bg-accent-cta-soft text-accent-cta-ink' : ''}`}
              id={`command-option-${command.id}`}
              key={command.id}
              onClick={() => execute(index)}
              onMouseDown={(event) => event.preventDefault()}
              ref={(element) => { optionRefs.current[index] = element; }}
              role="option"
            >
              <span>{label}</span>
              <span className="whitespace-nowrap text-[10px] text-subtle-foreground">{t(command.category)}</span>
            </div>
          ))}
        </div>
        {filtered.length === 0 && <p className="m-0 px-4 py-5 text-xs text-muted-foreground" role="status">{t('shell.paletteEmpty')}</p>}
        <footer className="flex min-h-10 items-center justify-between gap-3 border-t px-3.5 text-[10px] text-subtle-foreground">
          <span>{t('shell.paletteHint')}</span>
          <span><kbd className="rounded border bg-muted px-1.5 py-0.5 text-subtle-foreground">{shortcut}</kbd></span>
        </footer>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
