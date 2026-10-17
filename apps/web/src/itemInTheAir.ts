import { useSyncExternalStore } from 'react';
import { endSelection, keepAcrossSwitch } from './selection';

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
let crossedFrom: string | null = null;

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
  crossedFrom = null;
  tell();
}

export function landItem(): void {
  inTheAir = null;
  liftedFrom = null;
  selectionInTheAir = null;
  crossedFrom = null;
  keepAcrossSwitch(null);
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
// A selection carried across the Dashboard switch its own drag makes.
// ---------------------------------------------------------------------------

/**
 * The Dashboard scope the selection in the air is leaving by that drag's own
 * switch, or null ("Keep a dragged selection across the Dashboard switch its
 * drag makes", issue 1218).
 */
export function selectionCarriedAcross(): string | null {
  return crossedFrom;
}

/**
 * Called by the tab a drag has rested on, just before it switches Dashboard: the
 * selection `from` is in the air, so leaving its Dashboard does not end it and
 * it can be dropped on a Panel of the next. Any other switch is not this call
 * and ends it as it always did.
 *
 * **The drag's end is listened for on the document**, because the row it began
 * on is drawn on the Dashboard just left - gone from the page, where its own
 * `dragend` can no longer reach anything. A drag that ends without a drop is a
 * cancel, and the selection ends with it; the pointer is silent through a drag
 * and speaks again as it ends, which is what `pointermove` is for where no
 * `dragend` arrives.
 */
export function carryAcrossSwitch(from: string): void {
  if (selectionInTheAir?.scope !== from) return;
  crossedFrom = from;
  keepAcrossSwitch(from);
  for (const event of DRAG_IS_OVER) document.addEventListener(event, theDragIsOver);
}

const DRAG_IS_OVER = ['dragend', 'pointermove', 'pointerdown'] as const;

function theDragIsOver() {
  for (const event of DRAG_IS_OVER) document.removeEventListener(event, theDragIsOver);
  // Already landed - dropped on a Panel, which has filed what it had to - and
  // that drop ended the selection itself.
  const from = crossedFrom;
  if (from === null) return;
  landItem();
  endSelection(from);
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
