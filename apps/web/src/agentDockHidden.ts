import type { KeyPress } from './inboxCollapsed.js';

/**
 * Whether the agents' dock is hidden ("Keep your agents in a dock, and choose
 * which each dashboard shows", issue 570), and the key that toggles it.
 *
 * **Remembered in the browser, and forgotten at sign-out**, the same shape
 * `inboxCollapsed.ts` carries and for the same reason: it is a choice about
 * the chrome. A browser that refuses the write still hides for this visit:
 * the caller holds the state, this only remembers it.
 */

export type { KeyPress };

/** The key that toggles the dock, named in the gear's own entry. */
export const AGENT_DOCK_KEY = 'a';

const KEY = 'cockpit.agent-dock-hidden';

/** Hidden only where the stored value says so; anything else is shown. */
export function readAgentDockHidden(store: Storage | undefined): boolean {
  try {
    return store?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Shown is the default, so showing removes the entry rather than storing it. */
export function writeAgentDockHidden(store: Storage | undefined, hidden: boolean): void {
  try {
    if (hidden) store?.setItem(KEY, '1');
    else store?.removeItem(KEY);
  } catch {
    // Not remembering the choice is a smaller thing than one that throws.
  }
}

/** Called from `session/forget.ts`, alongside the Inbox's own collapse. */
export function forgetAgentDockHidden(store: Storage | undefined): void {
  writeAgentDockHidden(store, false);
}

/**
 * Whether this key press toggles the dock.
 *
 * Not while typing, not with a modifier held, not while a menu or a window is
 * open, and not for a key held down - the same four guards `togglesTheInbox`
 * carries, for the same reasons.
 */
export function togglesTheAgentDock(press: KeyPress, covered: boolean): boolean {
  if (press.key.toLowerCase() !== AGENT_DOCK_KEY) return false;
  if (press.ctrlKey || press.altKey || press.metaKey) return false;
  if (press.repeat || press.defaultPrevented) return false;
  return !press.typing && !covered;
}
