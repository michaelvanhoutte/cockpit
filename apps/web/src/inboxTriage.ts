import { itemLabel, uuidv7, workspaceIsDecided, type Item } from '@cockpit/shared';
import { CommandRefused } from './api/client';
import type { CommandArgs } from './api/queries';
import { plainKey, type Press } from './inboxKeys';
import { updateSelection, type Selection } from './selection';
import type { Undoable } from './undo';

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

/**
 * Shift+Enter on a row ("File a proposal group in one action, and offer Show and
 * Also show on… after it", issue 1167): files the row's whole proposal group
 * (`act` is the group's filing), or the row alone outside one, the focus moving
 * to the first row after the group. Where Cockpit proposed no Panel it files
 * nothing and says so.
 */
export function triageGroup(
  event: Press,
  row: HTMLElement,
  act: (() => void) | undefined,
  show: ShowItem,
  saysNoProposal: () => void,
): void {
  if (!event.shiftKey || plainKey(event, document, true) !== 'Enter') return;
  if (!act) {
    saysNoProposal();
    return;
  }
  const group = row.closest('[data-proposal-group]');
  moveOnFrom(row, false, show, group ? [...group.querySelectorAll<HTMLElement>('li[data-item-row]')] : [row]);
  act();
}

/** The Item last acted on by a key, which Z brings back and focuses. */
let lastActedOn: string | null = null;

/**
 * Waits for `row` to leave the list - filed, done or dismissed - and focuses the
 * row that was after it (the one before, for the last), the docked form
 * following. For a `group` of rows filed together, `row` is its last and the
 * focus goes to the row after the group, or the one before it. Gives up when the row stays: after a few seconds, or for Move to…
 * once its picker has closed without the row going.
 */
export function moveOnFrom(row: HTMLElement, asksFirst: boolean, show: ShowItem, group: readonly HTMLElement[] = [row]): void {
  const list = row.closest('[data-inbox]');
  if (!list) return;
  const rows = [...list.querySelectorAll<HTMLElement>('li[data-item-row]')];
  const first = rows.indexOf(group[0]!);
  const last = rows.indexOf(group[group.length - 1]!);
  const next = rows[last + 1] ?? rows[first - 1];
  lastActedOn = group[0]!.dataset.itemId ?? null;
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

/**
 * The selection once the focus has moved from `from` to `to` with Shift held
 * ("Accept the proposals of a selection with Enter", issue 1112): the rows from
 * where the selection began to the row reached, and no others taken away.
 *
 * **Moving back towards where it began shrinks it**, so Shift+J twice and
 * Shift+K once leaves two rows; the anchor is the row a shift-click reaches
 * back to (`Selection.reachingFrom`), or `from` where `from` is not picked.
 */
export function afterExtending(ids: readonly string[], selection: Selection, from: string, to: string): Selection {
  const anchor = selection.picked.has(from) && selection.reachingFrom && ids.includes(selection.reachingFrom) ? selection.reachingFrom : from;
  const span = (end: string) => {
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(end)];
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  };
  const picked = new Set(selection.picked);
  const away = (id: string) => Math.abs(ids.indexOf(id) - ids.indexOf(anchor));
  // Back towards the anchor gives up the row left, and only that one: a row
  // picked on its own inside the span stays picked.
  if (away(to) < away(from)) picked.delete(from);
  else for (const id of span(to)) picked.add(id);
  return { picked, reachingFrom: anchor };
}

/** Shift+J / K reached `to` from `from`: the Inbox's selection grows or shrinks to it. */
export function extendSelection(scope: string, ids: readonly string[], from: string, to: string): void {
  updateSelection(scope, (was) => afterExtending(ids, was, from, to));
}

/** What `acceptSelection` is handed by the list that holds the selection. */
export interface AcceptingSelection {
  picked: readonly Item[];
  /** The Panel an Item's drawn proposal names, or undefined where it has none. */
  panelFor: (item: Item) => string | undefined;
  filings: readonly { itemId: string; panelId: string; position: number }[];
  workspaceId: string;
  scope: string;
  send: (command: CommandArgs) => Promise<unknown>;
  whereItIs: (item: Item) => { panelId: string; order: string[] }[];
  nameOf: (panelId: string | null) => string;
  putSeveralBack: (moved: readonly Item[], wasOn: ReadonlyMap<string, { panelId: string; order: string[] }[]>) => Promise<void>;
  offerToUndo: (change: Undoable) => void;
  /** Show and Also show on… for what moved, offered where it all went to one Panel. */
  nextSteps: (moved: Item[], panelId: string) => Pick<Undoable, 'show' | 'alsoShowOn'>;
}

let accepting = false;

/**
 * Enter with a selection held: files each picked Item on its own proposed
 * Panel, one filing each as a single acceptance sends it. Those without a
 * proposal stay picked and where they are, and the undo bar says what happened
 * - how many moved, how many had none, which was refused - with one Undo for
 * the Items that moved.
 *
 * **A refusal stops only its own Item.** The Items are on different Panels, so
 * one refused leaves the rest to go; the order each carries is built from the
 * Items already filed onto that Panel, never from one that was refused.
 */
export async function acceptSelection(d: AcceptingSelection): Promise<void> {
  if (accepting) return;
  const chosen = d.picked.filter((item) => d.panelFor(item));
  const none = d.picked.length - chosen.length;
  if (d.picked.length === 0) return;
  if (chosen.length === 0) {
    d.offerToUndo({ what: `${d.picked.length === 2 ? 'Neither' : 'None'} of the ${d.picked.length} selected had a proposed Panel` });
    return;
  }
  accepting = true;
  const wasOn = new Map(chosen.map((item) => [item.id, d.whereItIs(item)] as const));
  const sentTo = new Map<string, string[]>();
  const moved: Item[] = [];
  const refused: { item: Item; why: string }[] = [];
  try {
    for (const item of chosen) {
      const panelId = d.panelFor(item)!;
      const filed = sentTo.get(panelId) ?? [];
      const held = d.filings.filter((f) => f.panelId === panelId).sort((a, b) => a.position - b.position).map((f) => f.itemId);
      try {
        await d.send({
          name: 'move_item_to_panel',
          payload: {
            commandId: uuidv7(),
            issuedAt: new Date().toISOString(),
            workspaceId: d.workspaceId,
            itemId: item.id,
            panelId,
            order: [...filed, item.id, ...held.filter((id) => id !== item.id && !filed.includes(id))],
          },
        });
        sentTo.set(panelId, [...filed, item.id]);
        moved.push(item);
      } catch (error) {
        refused.push({ item, why: error instanceof CommandRefused ? error.message : 'It could not be moved.' });
      }
    }
  } finally {
    accepting = false;
  }
  const filed = new Set(moved.map((item) => item.id));
  if (filed.size > 0) {
    updateSelection(d.scope, (was) => ({ picked: new Set([...was.picked].filter((id) => !filed.has(id))), reachingFrom: null }));
  }
  const panels = new Set(moved.map((item) => d.panelFor(item)));
  const [only] = moved.length === 1 ? moved : [];
  const where = panels.size === 1 ? d.nameOf([...panels][0]!) : 'their proposed Panels';
  // What is said of the Items that did not move, whole at the bar's end.
  const rest = [
    none > 0 && `${none} had no proposal`,
    refused.length > 0 &&
      `“${itemLabel(refused[0]!.item)}”${refused.length > 1 ? ` and ${refused.length - 1} more were` : ' was'} refused: ${refused[0]!.why}`,
  ].filter(Boolean);
  // A single Item keeps its title, which the bar shortens, never what follows it.
  const split = only && { title: `“${itemLabel(only)}”`, rest: [` moved to ${where}`, ...rest].join(', ') };
  const what = split ? split.title + split.rest : [moved.length > 0 && `${moved.length} items moved to ${where}`, ...rest].filter(Boolean).join(', ');
  // Withheld where one of them belonged to no Workspace: moving it decided
  // which, and that cannot be put back (`fileSeveral`).
  const decides = moved.some((item) => !workspaceIsDecided(item));
  d.offerToUndo({
    what,
    ...(split ? { split } : {}),
    ...(moved.length === 0 || decides ? {} : { undo: () => d.putSeveralBack(moved, wasOn) }),
    // Only when everything that moved went to one Panel: with several, there is
    // no one Panel to show or to also show them on.
    ...(moved.length > 0 && panels.size === 1 ? d.nextSteps(moved, [...panels][0]!) : {}),
  });
}
