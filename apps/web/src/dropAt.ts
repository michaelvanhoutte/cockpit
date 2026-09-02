/**
 * Where a dropped row would land in the list under it ("Drag an item into a
 * panel, and drop it where you want it", issue 141).
 *
 * **The deciding is here, and pure, for the reason the swipe's is** (swipe.ts):
 * jsdom has no layout engine and reports every rectangle as zero, so a test
 * that drove a drag against it would be measuring nothing. What can be proved
 * without a browser is the arithmetic — given where the rows are and where the
 * pointer is, which gap is it over — and that is the part with the off-by-one
 * in it.
 */

/**
 * The type a dragged item is carried under.
 *
 * Its own type rather than `text/plain`, because a dashboard is already full of
 * drags: a panel is dragged by its header onto another panel, and a list that
 * accepted anything would file a panel into itself. The type is readable during
 * `dragover` while the data is not, which is exactly what a list needs to know
 * whether to offer a place at all.
 */
export const ITEM_BEING_DRAGGED = 'application/x-cockpit-item';

/**
 * Which gap the pointer is over: 0 before the first row, 1 between the first
 * and the second, and the length of the list to land after all of them.
 *
 * `midpoints` are the vertical middles of the rows, top to bottom. A row is
 * counted as passed once the pointer is below its middle, which is what makes
 * the gap the person is aiming at the one nearest the pointer rather than the
 * one whose row it happens to be inside.
 *
 * An empty list answers 0, which is the only place there is.
 */
export function whereItWouldLand(midpoints: readonly number[], y: number): number {
  return midpoints.filter((middle) => y > middle).length;
}

/**
 * Where an item already in the list would land, expressed as the place it ends
 * up rather than the gap it was dropped in.
 *
 * They differ by one for every gap below the row being moved: dropping row 0
 * into the gap "after row 2" is the third gap, and the row ends up second once
 * it has been taken out of its old place. Without this a row dragged downwards
 * always stopped one short of where it was let go.
 */
export function placeAfterMoving(gap: number, movingFrom: number | null): number {
  if (movingFrom === null || gap <= movingFrom) return gap;
  return gap - 1;
}
