import * as Dialog from '@radix-ui/react-dialog';

/**
 * The window a list of named things is managed in: the dashboards of a
 * workspace, the workspaces of the account, and its types.
 *
 * **Over what you were doing, rather than instead of it.** Managing any of
 * these is a detour, so the screen behind stays where it was and closing puts
 * you back with nothing to reload ("Rename and delete a dashboard from a
 * dashboard settings page", issue 90, which is where the shape came from).
 *
 * **The workspaces and the types moved in here from pages of their own**, and
 * the pages are why this component exists. A page has to be reached without a
 * workspace, and the app shell has no state for that: the header lost the
 * workspace's colour, its Capture… control and the selected tab, so leaving a
 * workspace turned the chrome into something that read as a different app. The
 * shell is now only ever drawn inside a workspace, which is the one state it
 * has, and the account-level lists are drawn over it.
 *
 * The three used to write this dialog out one at a time. What a window holds
 * differs; what a window *is* does not.
 */
export function ManageWindow({
  title,
  open,
  onClose,
  canClose = true,
  onEscapeKeyDown,
  returnFocusTo,
  ref,
  children,
}: {
  /** What is being managed, which is the whole of what this window is. */
  title: string;
  open: boolean;
  onClose: () => void;
  /**
   * False while a change is in flight, which is what stops Escape and a press
   * outside closing it: the refusal that might come back would have nowhere
   * left to appear.
   */
  canClose?: boolean;
  /**
   * Escape, where the window has something of its own open inside it that
   * should take the key first - a name being typed into a row. Radix listens
   * for the key on the document, above anything a field could stop, so the
   * window is where this is decided.
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
  /**
   * The window itself, for a list that has to put the focus back on it - a
   * deleted row takes the menu the question was asked from with it, and the
   * focus would otherwise fall to the page behind.
   */
  ref?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(nowOpen) => !nowOpen && canClose && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          ref={ref}
          // The title is the whole of what this is, so there is no separate
          // description to point at. Radix asks for the attribute to be
          // undefined rather than absent when a dialog genuinely has none.
          aria-describedby={undefined}
          {...(onEscapeKeyDown ? { onEscapeKeyDown } : {})}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          // Near the top on a phone rather than centred on it: renaming opens
          // the keyboard over the bottom half of the screen, and a dialog
          // centred on a 667px screen has its buttons behind it. The list
          // scrolls inside the window rather than growing past the screen,
          // because an account may hold plenty of workspaces. On a phone it can
          // reach both ends of the screen, so both the 16px it starts at and
          // the height it may grow to are measured inside the screen's own
          // edges (styles.css, `--edge-top`).
          className="fixed left-1/2 top-[calc(1rem_+_var(--edge-top))] flex max-h-[calc(100dvh_-_2rem_-_var(--edge-top)_-_var(--edge-bottom))] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg md:top-1/2 md:max-h-[min(40rem,calc(100dvh-8rem))] md:-translate-y-1/2"
        >
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The way out, in the same place in all three windows. */
export function CloseWindow({ disabled }: { disabled?: boolean }) {
  return (
    <div className="flex justify-end pt-4">
      <Dialog.Close
        disabled={disabled}
        className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
      >
        Done
      </Dialog.Close>
    </div>
  );
}
