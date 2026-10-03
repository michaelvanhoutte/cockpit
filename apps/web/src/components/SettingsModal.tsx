import { Suspense, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { EmbeddedInSettings } from './ManageWindow';

/** POC: one modal, sections down the left, the existing windows drawn inline as its content. */
export type SettingsSection = { key: string; label: string; content: React.ReactNode };

export function SettingsModal({
  title,
  open,
  onClose,
  sections,
  returnFocusTo,
  initial,
}: {
  initial?: string | undefined;
  title: string;
  open: boolean;
  onClose: () => void;
  sections: SettingsSection[];
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const [picked, setPicked] = useState(initial ?? sections[0]?.key);
  const activeRef = useRef<HTMLButtonElement>(null);
  const current = sections.find((section) => section.key === picked) ?? sections[0];
  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          // Focus starts on the section that is showing, not the first one.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            activeRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 flex h-[min(40rem,calc(100dvh-4rem))] w-[min(56rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-black/10 bg-surface shadow-lg"
        >
          <nav aria-label={title} className="flex w-48 shrink-0 flex-col gap-1 border-r border-black/10 p-3">
            <Dialog.Title className="px-2 pb-2 text-base font-semibold">{title}</Dialog.Title>
            {sections.map((section) => (
              <button
                key={section.key}
                ref={section.key === current?.key ? activeRef : undefined}
                type="button"
                aria-current={section.key === current?.key}
                onClick={() => setPicked(section.key)}
                className={`rounded-md px-2 py-1.5 text-left text-sm ${
                  section.key === current?.key
                    ? 'bg-accent-tint text-accent-deep'
                    : 'text-ink-soft hover:bg-accent-tint/60'
                }`}
              >
                {section.label}
              </button>
            ))}
            <Dialog.Close className="mt-auto rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint">
              Close
            </Dialog.Close>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-5">
            <EmbeddedInSettings.Provider value={{ heading: current?.label ?? null }}>
              <Suspense fallback={null}>{current?.content}</Suspense>
            </EmbeddedInSettings.Provider>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
