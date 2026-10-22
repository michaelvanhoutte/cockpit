import { CAPTURE_KEY } from './captureShortcut';
import { INBOX_KEY } from './inboxCollapsed';
import { FIND_ITEM_KEY, PANEL_LIST_KEY } from './panelList';
import { SHORTCUTS_KEY } from './keyboardShortcuts';

/**
 * Every key Cockpit handles, grouped by where it works - what the Keyboard
 * shortcuts window draws ("Keep C, I, G and F working while a form is docked,
 * and list every key behind ?", issue 1408), in the wording of its chosen
 * design. The description editor's formatting keys are left out: its toolbar
 * already shows them.
 *
 * **Written by hand, held to the keys the code handles by a test**
 * (`tests/unit/keyboardShortcuts.test.tsx`): a key a listener gains without a
 * row here fails it.
 */

/** A row: what the keys do, the keys, and the keys that do the same in a second way. */
export type Shortcut = { does: string; keys: readonly string[]; or?: readonly string[] };

/** Which side of the window a group is drawn on, as the chosen design lays them out. */
export type ShortcutGroup = { place: string; column: 1 | 2; rows: readonly Shortcut[] };

const upper = (key: string) => key.toUpperCase();

/** In the order the window names them; the design draws three down each side. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    place: 'Anywhere',
    column: 1,
    rows: [
      { does: 'Capture a note', keys: [upper(CAPTURE_KEY)] },
      { does: 'Collapse or open the Inbox', keys: [upper(INBOX_KEY)] },
      { does: 'Go to a Panel · this Workspace', keys: [upper(PANEL_LIST_KEY), `⇧${upper(PANEL_LIST_KEY)}`] },
      { does: 'Find an Item · this Workspace', keys: [upper(FIND_ITEM_KEY), `⇧${upper(FIND_ITEM_KEY)}`] },
      { does: 'This list', keys: [SHORTCUTS_KEY] },
    ],
  },
  {
    place: 'On an Inbox row',
    column: 2,
    rows: [
      { does: 'Next / previous row', keys: ['J', 'K'], or: ['↓', '↑'] },
      { does: 'File on its proposed Panel', keys: ['Enter'] },
      { does: 'File its whole group', keys: ['⇧Enter'] },
      { does: 'Move to…', keys: ['M'] },
      { does: 'Mark done', keys: ['D'] },
      { does: 'Dismiss', keys: ['X'] },
      { does: 'Open', keys: ['O'] },
      { does: 'Undo the last one', keys: ['Z'] },
    ],
  },
  {
    place: 'Picking several Inbox rows',
    column: 1,
    rows: [
      { does: 'Extend the pick down / up', keys: ['⇧J', '⇧K'] },
      { does: 'File each on its proposed Panel', keys: ['Enter'] },
      { does: 'Drop the pick', keys: ['Esc'] },
    ],
  },
  {
    place: 'Docked Item form',
    column: 1,
    rows: [
      { does: 'Back to the Item’s row', keys: ['Esc'] },
      { does: 'Close it, from the row', keys: ['Esc'] },
    ],
  },
  {
    place: 'On a Panel’s row',
    column: 2,
    rows: [
      { does: 'Open', keys: ['Enter'] },
      { does: 'Its menu', keys: ['⇧F10'] },
    ],
  },
  {
    place: 'Capture',
    column: 2,
    rows: [{ does: 'Capture the note', keys: ['Ctrl Enter'] }],
  },
];

/** Said once under the list. */
export const SHORTCUTS_FOOTER = 'None of these act while you type in a field. Esc closes this list.';
