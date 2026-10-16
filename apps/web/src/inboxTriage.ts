import { plainKey, type Press } from './inboxKeys';

/**
 * What a key press does to the focused row ("Act on the focused Inbox row with
 * one key, and move on", issue 1111): Enter files it on its proposed Panel, Z
 * undoes the last change. Decided here, with the rest, so none of it is in the
 * initial bundle.
 */
export type TriageKey = 'accept' | 'move' | 'done' | 'dismiss' | 'open' | 'undo';

const TRIAGE: Record<string, TriageKey> = { Enter: 'accept', m: 'move', d: 'done', x: 'dismiss', o: 'open', z: 'undo' };

export function triageKey(event: Press, doc: Document = document): TriageKey | null {
  return TRIAGE[plainKey(event, doc) ?? ''] ?? null;
}

/**
 * Where the focus goes after a key acted on an Inbox row ("Act on the focused
 * Inbox row with one key, and move on", issue 1111). Fetched on the first such
 * key, so none of it is in the initial bundle.
 */

/**
 * What a triage key does to the row it was pressed on: the row's own action for
 * it, as its menu sends it, the focus following the row off the list.
 * `accept` is absent where Cockpit proposed no Panel, which is said.
 */
export function triage(
  event: Press,
  row: HTMLElement,
  actions: {
    accept: (() => void) | undefined;
    move: ((openedFrom: HTMLElement) => void) | undefined;
    done: () => void;
    dismiss: () => void;
    open: (() => void) | undefined;
  },
  show: ShowItem,
  saysNoProposal: () => void,
): void {
  const key = triageKey(event);
  if (!key || key === 'undo') return;
  const act = key === 'move' ? actions.move && (() => actions.move!(row)) : actions[key];
  if (!act) {
    if (key === 'accept') saysNoProposal();
    return;
  }
  if (key !== 'open') moveOnFrom(row, key === 'move', show);
  act();
}

/** The Item last acted on by a key, which Z brings back and focuses. */
let lastActedOn: string | null = null;

/**
 * Waits for `row` to leave the list - filed, done or dismissed - and focuses the
 * row that was after it (the one before, for the last), the docked form
 * following. Gives up when the row stays: after a few seconds, or for Move to…
 * once its picker has closed without the row going.
 */
export function moveOnFrom(row: HTMLElement, asksFirst: boolean, show: ShowItem): void {
  const list = row.closest('[data-inbox]');
  if (!list) return;
  const rows = [...list.querySelectorAll<HTMLElement>('li[data-item-row]')];
  const at = rows.indexOf(row);
  const next = rows[at + 1] ?? rows[at - 1];
  lastActedOn = row.dataset.itemId ?? null;
  if (!next) return;
  let sawPicker = false;
  let timer: ReturnType<typeof setTimeout>;
  const done = () => {
    watching.disconnect();
    clearTimeout(timer);
  };
  // The focus waits for the picker to close: its focus trap pulls the keyboard
  // back inside it, and would then drop it on the page when it goes.
  const watching = new MutationObserver(() => {
    const picker = document.querySelector('[role="dialog"]:not([data-docked-form])') !== null;
    if (picker) sawPicker = true;
    if (!row.isConnected && !picker) {
      done();
      focusRow(list, next.dataset.itemId!, show);
    } else if (row.isConnected && sawPicker && !picker) {
      // Closed with the row still there: chosen and not yet answered, or
      // cancelled - which only the row staying tells apart.
      sawPicker = false;
      clearTimeout(timer);
      timer = setTimeout(done, 3_000);
    }
  });
  watching.observe(document.body, { childList: true, subtree: true });
  timer = setTimeout(done, asksFirst ? 120_000 : 8_000);
}

/** Z: puts the last change back and focuses the Item it brings into the Inbox. */
export function undoAndFocus(event: Press, show: ShowItem): void {
  if (triageKey(event) !== 'undo') return;
  const brought = lastActedOn;
  const list = document.querySelector('[data-inbox]');
  // The undo bar's own button, where one is offered and not already working.
  const undo = [...document.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find((b) => b.textContent === 'Undo');
  if (!brought || !list || list.querySelector(`li[data-item-id="${brought}"]`) || !undo || undo.disabled) return;
  undo.click();
  const watching = new MutationObserver(() => {
    if (focusRow(list, brought, show)) done();
  });
  const done = () => {
    watching.disconnect();
    clearTimeout(timer);
  };
  watching.observe(list, { childList: true, subtree: true });
  const timer = setTimeout(done, 8_000);
}

type ShowItem = (itemId: string, options?: { keepFocus?: boolean }) => void;

function focusRow(list: Element, itemId: string, show: ShowItem): boolean {
  const row = list.querySelector<HTMLElement>(`li[data-item-id="${itemId}"]`);
  if (!row) return false;
  row.focus();
  show(itemId, { keepFocus: true });
  return true;
}
