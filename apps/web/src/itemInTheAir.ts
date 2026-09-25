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

export function liftItem(itemId: string): void {
  inTheAir = itemId;
}

export function landItem(): void {
  inTheAir = null;
}

export function itemInTheAir(): string | null {
  return inTheAir;
}
