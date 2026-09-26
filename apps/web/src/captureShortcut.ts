import { isTypedInto, somethingIsOpenOverThePage } from './inboxCollapsed';

/**
 * Whether a key press is the one that opens Capture ("Capture over the screen
 * you are on, and open it with C", issue 536).
 *
 * **`C` works anywhere inside Cockpit except where something else has the
 * keys**: a field being typed in, a menu or a window that is open, and any
 * chord - Ctrl+C still copies. Decided here, from the event and the document
 * alone, so the shell only has to act on the answer.
 */
export function opensCapture(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.key !== 'c' && event.key !== 'C') return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  // Already taken by whoever handled it first, and a key held down is not a
  // second press.
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  return !isTypedInto(event.target) && !somethingIsOpenOverThePage(doc);
}
