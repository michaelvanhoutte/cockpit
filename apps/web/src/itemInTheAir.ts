import { useSyncExternalStore } from 'react';

/**
 * Which Item a row drag is carrying, while one is in the air.
 *
 * **Recorded here because `dragover` cannot read it off the drag**: the id rides
 * under `ITEM_BEING_DRAGGED` (dropAt.ts), whose data a browser hands over only
 * on the drop. A sorted Panel has to say no *before* the drop, to a row it
 * already holds, from whichever list that row was picked up in ("Sort a panel
 * of items by the fields you choose", issue 526).
 *
 * Set by the row on `dragstart`, which every row drag begins with, so a row
 * taken off the screen mid-drag - whose `dragend` then never fires - leaves a
 * stale id only until the next drag overwrites it.
 */
let inTheAir: string | null = null;
let liftedFrom: string | null = null;
let selectionInTheAir: SelectionInTheAir | null = null;

/**
 * The selection a drag of one of its picked rows carries ("Drag a selection,
 * and drop it on the Dashboard it was picked on", issue 1217): every id, in the
 * order the rows are drawn, and the scope it is held in, which what is filed
 * leaves.
 */
export interface SelectionInTheAir {
  readonly ids: readonly string[];
  readonly scope: string;
}

/**
 * `fromPanelId` is the Panel the row was picked up from, which a drop onto
 * another Panel names as the one a move takes it off ("Move an Item from one
 * Panel's row without taking it off its other Panels", issue 923). Absent for a
 * row of the Inbox or of a Filter, which is on no Panel of its own to leave.
 *
 * `carrying` is the selection the row is the grabbed one of, where it is two
 * rows or more.
 */
export function liftItem(
  itemId: string,
  fromPanelId: string | null = null,
  carrying: SelectionInTheAir | null = null,
): void {
  inTheAir = itemId;
  liftedFrom = fromPanelId;
  selectionInTheAir = carrying;
  tell();
}

export function landItem(): void {
  inTheAir = null;
  liftedFrom = null;
  selectionInTheAir = null;
  tell();
}

/** The Panel the Item in the air was picked up from, or null if none, or if it is not this Item. */
export function panelLiftedFrom(itemId: string): string | null {
  return inTheAir === itemId ? liftedFrom : null;
}

export function itemInTheAir(): string | null {
  return inTheAir;
}

/** The selection in the air, or null when what is carried is one row. */
export function selectionCarried(): SelectionInTheAir | null {
  return selectionInTheAir;
}

// ---------------------------------------------------------------------------
// The rows fading while a selection is in the air.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/**
 * Said to the rows a tick later than the drag begins, **never inside
 * `dragstart`**: a browser takes the picture it draws under the pointer once
 * that event returns, and a row already faded by then is drawn faded in it.
 */
function tell() {
  setTimeout(() => {
    for (const listener of listeners) listener();
  }, 0);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The ids a selection in the air carries, for the rows to fade; null when none is. */
export function useCarriedIds(): ReadonlySet<string> | null {
  const carrying = useSyncExternalStore(subscribe, selectionCarried);
  return useIdsOf(carrying);
}

// One set per drag, so a row re-reading it does not see a new one each render.
let setOf: { for: SelectionInTheAir; ids: ReadonlySet<string> } | null = null;
function useIdsOf(carrying: SelectionInTheAir | null): ReadonlySet<string> | null {
  if (!carrying) return null;
  if (setOf?.for !== carrying) setOf = { for: carrying, ids: new Set(carrying.ids) };
  return setOf.ids;
}

/** `ids` in the order their rows are drawn on the screen, each once; one drawn nowhere is last. */
export function inTheOrderDrawn(ids: ReadonlySet<string>): string[] {
  const drawn = [...document.querySelectorAll<HTMLElement>('li[data-item-id]')].map((row) => row.dataset.itemId!);
  const first = new Map<string, number>();
  drawn.forEach((id, at) => first.has(id) || first.set(id, at));
  return [...ids].sort((a, b) => (first.get(a) ?? drawn.length) - (first.get(b) ?? drawn.length));
}
