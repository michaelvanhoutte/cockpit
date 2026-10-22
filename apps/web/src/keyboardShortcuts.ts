import { isTypedInto, somethingIsOpenOverThePage } from './inboxCollapsed';

/** The key that opens the Keyboard shortcuts window, named beside its entry in the profile menu. */
export const SHORTCUTS_KEY = '?';

/**
 * Whether a key press is the one that opens the Keyboard shortcuts window
 * ("Keep C, I, G and F working while a form is docked, and list every key
 * behind ?", issue 1408).
 *
 * **The guards of I and C**: not while typing, not with Ctrl, Alt or ⌘ held,
 * not while a menu or a window is open (so the window already open is never
 * opened a second time), and not for a key held down. **Shift does not
 * disqualify it**, since it is how most layouts type `?`. Decided here, from the
 * event and the document alone, so the shell only has to act on the answer.
 */
export function opensTheShortcuts(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.key !== SHORTCUTS_KEY) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  return !isTypedInto(event.target) && !somethingIsOpenOverThePage(doc);
}
