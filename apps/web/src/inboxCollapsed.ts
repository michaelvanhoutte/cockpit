/**
 * Whether the Inbox column is collapsed to a chip in the Dashboard bar
 * ("Collapse the Inbox to its heading, and open it again with one press",
 * issue 535), and the key that toggles it.
 *
 * **Remembered in the browser for every workspace, and forgotten at sign-out,
 * for the reasons `inboxWidth.ts` gives** - it is the same kind of thing, a
 * choice about the chrome. A browser that refuses the write still collapses for
 * this visit: the caller holds the state, this only remembers it.
 */

/** The key that toggles the Inbox, named in both buttons' tooltips. */
export const INBOX_KEY = 'i';

const KEY = 'cockpit.inbox-collapsed';

/** Collapsed only where the stored value says so; anything else is open. */
export function readInboxCollapsed(store: Storage | undefined): boolean {
  try {
    return store?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Open is the default, so opening removes the entry rather than storing it. */
export function writeInboxCollapsed(store: Storage | undefined, collapsed: boolean): void {
  try {
    if (collapsed) store?.setItem(KEY, '1');
    else store?.removeItem(KEY);
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`, alongside the column's own width. */
export function forgetInboxCollapsed(store: Storage | undefined): void {
  writeInboxCollapsed(store, false);
}

/** What the decision below reads off a key press, so a test needs no browser event. */
export type KeyPress = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  /** Whether the key went to a field that takes typing. */
  typing: boolean;
};

/**
 * Whether this key press toggles the Inbox.
 *
 * Not while typing, not with a modifier held (Ctrl+I, Alt+I and ⌘I are the
 * browser's and the system's), not while a menu or a window is open (`covered`),
 * and not for a key held down: a repeat would flicker the column open and shut.
 */
export function togglesTheInbox(press: KeyPress, covered: boolean): boolean {
  if (press.key.toLowerCase() !== INBOX_KEY) return false;
  if (press.ctrlKey || press.altKey || press.metaKey) return false;
  if (press.repeat || press.defaultPrevented) return false;
  return !press.typing && !covered;
}

/** Whether a focused element is one that takes typed text. */
export function isTypedInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    (target.tagName === 'INPUT' &&
      !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
        (target as HTMLInputElement).type,
      ))
  );
}

/** A menu or window is open over the page: Radix mounts these only while open. */
export function somethingIsOpenOverThePage(root: ParentNode = document): boolean {
  return root.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]') !== null;
}
