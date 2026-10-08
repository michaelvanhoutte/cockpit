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

/**
 * `fromPanelId` is the Panel the row was picked up from, which a drop onto
 * another Panel names as the one a move takes it off ("Move an Item from one
 * Panel's row without taking it off its other Panels", issue 923). Absent for a
 * row of the Inbox or of a Filter, which is on no Panel of its own to leave.
 */
export function liftItem(itemId: string, fromPanelId: string | null = null): void {
  inTheAir = itemId;
  liftedFrom = fromPanelId;
}

export function landItem(): void {
  inTheAir = null;
  liftedFrom = null;
}

/** The Panel the Item in the air was picked up from, or null if none, or if it is not this Item. */
export function panelLiftedFrom(itemId: string): string | null {
  return inTheAir === itemId ? liftedFrom : null;
}

export function itemInTheAir(): string | null {
  return inTheAir;
}
