import * as Dialog from '@radix-ui/react-dialog';
import { SHORTCUTS_FOOTER, SHORTCUT_GROUPS } from '../shortcutList';
import type { Shortcut } from '../shortcutList';
import { KEY_CAP } from './keyCap';

/**
 * Every key Cockpit handles, grouped by where it works ("Keep C, I, G and F
 * working while a form is docked, and list every key behind ?", issue 1408):
 * a centred window opened by `?` or from the profile menu, at a desk only.
 *
 * **Esc, ✕ and a press outside close it**, and the focus goes back to what had
 * it - the shell says which control that is, since the window has no trigger of
 * its own for Radix to return it to. What it lists is `shortcutList.ts`.
 */
export function KeyboardShortcutsWindow({
  onClose,
  returnFocusTo,
}: {
  onClose: () => void;
  /** What had the keyboard when the window opened, which gets it back. */
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  return (
    <Dialog.Root open onOpenChange={(nowOpen) => !nowOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed z-floating left-1/2 top-1/2 flex w-[min(47.5rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3.5 overflow-y-auto rounded-lg border border-shade/10 bg-surface px-6 pb-4.5 pt-5 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-[17px] font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="-mr-2 rounded-md px-2 py-1 text-lg leading-none text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
            >
              <span aria-hidden="true">✕</span>
            </Dialog.Close>
          </div>
          <div className="grid grid-cols-2 gap-x-8 text-[13px] text-ink-soft">
            {([1, 2] as const).map((column) => (
              <div key={column} className="flex flex-col gap-3.5">
                {SHORTCUT_GROUPS.filter((group) => group.column === column).map((group) => (
                  <section key={group.place} aria-label={group.place} className="flex flex-col gap-[5px]">
                    <h3 className="border-b border-accent/40 pb-[3px] text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-deep">
                      {group.place}
                    </h3>
                    {group.rows.map((row) => (
                      <Row key={row.does} row={row} />
                    ))}
                  </section>
                ))}
              </div>
            ))}
          </div>
          <p className="border-t border-shade/10 pt-2 text-[11px] text-ink-faint">{SHORTCUTS_FOOTER}</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ row }: { row: Shortcut }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{row.does}</span>
      <span className="flex shrink-0 items-center gap-1">
        {row.keys.map((key) => (
          <kbd key={key} className={KEY_CAP}>
            {key}
          </kbd>
        ))}
        {row.or && (
          <>
            or
            {row.or.map((key) => (
              <kbd key={key} className={KEY_CAP}>
                {key}
              </kbd>
            ))}
          </>
        )}
      </span>
    </div>
  );
}

// Also the default export, for the lazy `import()` the shell loads this behind.
export default KeyboardShortcutsWindow;
