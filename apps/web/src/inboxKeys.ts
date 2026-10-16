import { isTypedInto } from './inboxCollapsed';

/**
 * Moving through the Inbox from the keyboard ("Move through the Inbox with J
 * and K, the docked form following", issue 1110): J and ↓ to the next row, K
 * and ↑ to the previous one.
 */

export type Press = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'defaultPrevented' | 'isComposing' | 'target'
>;

/**
 * The key of a plain press that belongs to the Inbox's list, or null. Shift is
 * left to the keys that extend a selection with it, a chord is the browser's or
 * the system's, and a field, a menu and a window keep their own keys.
 */
export function plainKey(event: Press, doc: Document): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  return isTypedInto(event.target) || coveredByAWindow(doc)
    ? null
    : event.key.length === 1
      ? event.key.toLowerCase()
      : event.key;
}

/** Which way a key press moves the focus: 1 for the next row, -1 for the previous, null for neither. */
export function inboxStep(event: Press, doc: Document = document): 1 | -1 | null {
  return STEPS[plainKey(event, doc) ?? ''] ?? null;
}

/**
 * A menu or window is open over the list - except the Item form docked beside
 * it, which is there to be read as the focus moves (`data-docked-form`,
 * `ItemForm.tsx`).
 */
function coveredByAWindow(root: ParentNode): boolean {
  return (
    root.querySelector('[role="menu"], [role="dialog"]:not([data-docked-form]), [role="alertdialog"]') !== null
  );
}

const STEPS: Record<string, 1 | -1> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };
