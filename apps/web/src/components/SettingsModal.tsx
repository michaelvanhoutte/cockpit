import { Suspense, useCallback, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { InSettings } from './ManageWindow';

/** One entry in the list down the left, and the window it draws on the right. */
export interface SettingsSection {
  key: string;
  /** The entry's name, which is also the heading of what it shows. */
  label: string;
  content: React.ReactNode;
}

/**
 * One modal holding several of the windows that used to open one at a time
 * ("Open Settings from the profile menu, with types, connections, agent
 * settings and MCP as its sections", issue 693): the sections down the left,
 * the chosen one's own content on the right.
 *
 * **Over the workspace rather than at an address**, like the windows it holds
 * (`ManageWindow.tsx`).
 *
 * **Each section is drawn inside its own `Suspense`**, so one whose code has
 * not arrived yet waits where it will appear and never takes the modal, or the
 * list beside it, down with it.
 *
 * **Opened on a given section**, which is the only one that looks selected and
 * the one the focus starts on - not the first. Closing puts the focus back on
 * the control that was used to ask for it.
 */
export function SettingsModal({
  title,
  sections,
  initial,
  onClose,
  returnFocusTo,
}: {
  title: string;
  sections: SettingsSection[];
  /** The section the modal opens on; the first when absent or unknown. */
  initial?: string | undefined;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const [picked, setPicked] = useState(initial);
  const current = sections.find((section) => section.key === picked) ?? sections[0];
  const selected = useRef<HTMLButtonElement>(null);
  /** A section with a change in flight keeps the modal open, as its own window would have kept itself. */
  const [held, setHeld] = useState(false);
  const hold = useCallback((now: boolean) => setHeld(now), []);

  return (
    <Dialog.Root open onOpenChange={(nowOpen) => !nowOpen && !held && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          // The focus starts on the section that is showing, not on the first.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            selected.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed inset-0 z-floating flex flex-col overflow-hidden bg-surface pb-[var(--edge-bottom)] pt-[var(--edge-top)] sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(40rem,calc(100dvh-4rem))] sm:w-[min(56rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:flex-row sm:rounded-lg sm:border sm:border-shade/10 sm:p-0 sm:shadow-lg"
        >
          <nav aria-label={title} className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-shade/10 p-3 sm:w-48 sm:flex-col sm:items-stretch sm:overflow-visible sm:border-b-0 sm:border-r">
            <Dialog.Title className="px-2 text-base font-semibold sm:pb-2">{title}</Dialog.Title>
            {sections.map((section) => {
              const here = section.key === current?.key;
              return (
                <button
                  key={section.key}
                  ref={here ? selected : undefined}
                  type="button"
                  aria-current={here ? 'true' : undefined}
                  onClick={() => setPicked(section.key)}
                  className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-sm ${
                    here ? 'bg-accent-tint text-accent-deep' : 'text-ink-soft hover:bg-accent-tint/60'
                  }`}
                >
                  {section.label}
                </button>
              );
            })}
            <Dialog.Close
              disabled={held}
              className="ml-auto shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint disabled:opacity-50 sm:ml-0 sm:mt-auto"
            >
              Close
            </Dialog.Close>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
            {current && (
              <InSettings.Provider value={{ heading: current.label, hold }}>
                {/* Keyed, so what one section was holding is not carried into the next. */}
                <Suspense
                  key={current.key}
                  fallback={
                    <section>
                      <h3 className="text-base font-semibold">{current.label}</h3>
                      <p className="mt-2 text-sm text-ink-faint">Loading…</p>
                    </section>
                  }
                >
                  {current.content}
                </Suspense>
              </InSettings.Provider>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
