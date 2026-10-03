import { Button as ControlButton } from '@/components/ui/button';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Command, Search, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOwnerSession } from '../auth/owner-session';
import { useI18n } from '../i18n/i18n';
import { fuzzyMatch, isCommandVisible, useCommandRegistry, type AdminCommand, type CommandContext } from './command-registry';
import { collectionIdFromPathname } from './route-context';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from './button';
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
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        aria-labelledby={titleId}
        className="max-h-[min(80dvh,640px)] w-[min(calc(100vw-32px),620px)] overflow-hidden"
        data-command-palette="true"
        initialFocus={inputRef}
        onKeyDown={handleKeyDown}
      >
        <DialogTitle className="sr-only" id={titleId}>{t('commands.paletteTitle')}</DialogTitle>
        <div className="flex min-h-[60px] items-center gap-3 border-b px-4 text-muted-foreground">
          <Search aria-hidden="true" size={18} />
          <Input
            aria-activedescendant={filtered[selectedIndex] ? `command-option-${filtered[selectedIndex].command.id}` : undefined}
            aria-controls="command-palette-options"
            aria-expanded="true"
            aria-label={t('commands.searchLabel')}
            autoComplete="off"
            className="min-h-11 rounded-md border-0 bg-transparent px-2 text-sm"
            onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }}
            placeholder={t('commands.searchLabel')}
            ref={inputRef}
            role="combobox"
            type="search"
            value={query}
          />
          <Button aria-label={t('shell.paletteClose')} className="size-11 min-h-11 shrink-0 px-0" onClick={onClose} type="button" variant="quiet">
            <X aria-hidden="true" size={16} />
          </Button>
        </div>
        <div aria-label={t('commands.paletteTitle')} className="min-h-12 overflow-y-auto p-1.5" id="command-palette-options" role="listbox">
          {filtered.length > 0 && filtered.map(({ command, label }, index) => (
            <div
              aria-label={label}
              aria-disabled={command.isEnabled ? !command.isEnabled(context) : undefined}
              aria-selected={index === selectedIndex}
              className={`flex min-h-11 items-center justify-between gap-3 rounded-md px-2.5 text-xs text-ink-secondary outline-none transition-colors hover:bg-accent-cta-soft hover:text-accent-cta-ink${index === selectedIndex ? ' bg-accent-cta-soft text-accent-cta-ink' : ''}`}
              id={`command-option-${command.id}`}
              key={command.id}
              onClick={() => execute(index)}
              onMouseDown={(event) => event.preventDefault()}
              ref={(element) => { optionRefs.current[index] = element; }}
              role="option"
            >
              <span>{label}</span>
              <span className="whitespace-nowrap text-xs text-muted-foreground">{t(command.category)}</span>
            </div>
          ))}
        </div>
        {filtered.length === 0 && <p className="m-0 px-4 py-5 text-xs text-muted-foreground" role="status">{t('shell.paletteEmpty')}</p>}
        <footer className="flex min-h-11 items-center justify-between gap-3 border-t px-3.5 text-xs text-muted-foreground">
          <span>{t('shell.paletteHint')}</span>
          <span><kbd className="rounded border bg-muted px-1.5 py-0.5 text-muted-foreground">{shortcut}</kbd></span>
        </footer>
      </DialogContent>
    </Dialog>
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
      <ControlButton variant="outline"
        aria-keyshortcuts={shortcutName}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-md border border-input px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent"
        data-command-palette-trigger
        onClick={showPalette}
        ref={triggerRef}
        title={`${t('shell.paletteTrigger')} (${shortcut})`}
        type="button"
      >
        <Command aria-hidden="true" size={15} />
        <span className="hidden min-[901px]:inline">{t('shell.paletteTrigger')}</span>
        <kbd className="hidden rounded border border-border bg-secondary px-[5px] py-[3px] font-[inherit] text-xs leading-[1.2] whitespace-nowrap text-muted-foreground min-[901px]:inline-block">{shortcut}</kbd>
      </ControlButton>
      {open && <CommandPaletteDialog commands={commands} context={context} onClose={closePalette} shortcut={shortcut} />}
    </>
  );
}
