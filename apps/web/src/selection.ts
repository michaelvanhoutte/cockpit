import { useCallback, useEffect, useRef } from 'react';
import type { Item } from '@cockpit/shared';

/**
 * The rows picked out of a list to be acted on together ("Select several items,
 * and file them all in one go", issue 169).
 *
 * **The deciding is here, and pure**, the way `whatTheSwipeMeant` is: what a
 * click on a tick means has cases - a plain click, one holding shift, a shift
 * with nothing to reach back to - and a decision kept out of the handler is one
 * that can be proved without a rendered list.
 *
 * **What the list no longer shows is not selected**, and that takes both
 * halves. `pickedInTheList` intersects with the rows in front of you, which is
 * what the count and the ticks read; and the list drops a row from the
 * selection as it goes, which is what stops one coming *back* still ticked -
 * a row moved out from its own menu and then put back by an undo used to
 * return already picked.
 */

export interface Selection {
  /**
   * The items picked out, by id.
   *
   * Only rows the list still shows: the list drops one as it leaves, so this
   * never carries an id back into view.
   */
  readonly picked: ReadonlySet<string>;
  /**
   * The last row picked on its own, which a shift-click reaches back to.
   *
   * Null when there is nothing to reach back to - before the first click, and
   * after a row is unpicked - and a shift-click then picks that one row rather
   * than doing nothing, because a range with one end is a click.
   */
  readonly reachingFrom: string | null;
}

export const NOTHING_PICKED: Selection = { picked: new Set(), reachingFrom: null };

/**
 * The selection after a tick is clicked.
 *
 * **A shift-click adds the span and never takes one away.** Reaching from one
 * row to another says "these as well"; making it a toggle would mean a range
 * that unpicked half of what it crossed, which is not what the gesture is for.
 */
export function afterClicking(
  ids: readonly string[],
  selection: Selection,
  id: string,
  withShift: boolean,
): Selection {
  const from = withShift ? selection.reachingFrom : null;
  const reachingTo = ids.indexOf(id);
  const reachingBack = from === null ? -1 : ids.indexOf(from);
  // A row that has left the list since it was picked cannot be reached back to,
  // so the shift means what a plain click means rather than a span with one end
  // missing.
  if (reachingBack !== -1 && reachingTo !== -1) {
    const span = ids.slice(
      Math.min(reachingBack, reachingTo),
      Math.max(reachingBack, reachingTo) + 1,
    );
    return { picked: new Set([...selection.picked, ...span]), reachingFrom: selection.reachingFrom };
  }

  const picked = new Set(selection.picked);
  // **Only a plain click puts one back.** A shift-click with nothing to reach
  // back to means this row, which is a range of one - so it adds, the way every
  // other shift-click does. Toggling here instead let a shift-click that found
  // no anchor take a row *out*: pick two, put the second back (which is what
  // empties the anchor), then shift-click the first, and the selection was
  // gone.
  if (picked.has(id) && !withShift) picked.delete(id);
  else picked.add(id);
  // Unpicking leaves nothing to reach back from: the next shift-click means
  // this row alone, which is what a range whose anchor was just taken away is.
  return { picked, reachingFrom: picked.has(id) ? id : null };
}

/** The picked rows the list actually shows, in the order it shows them. */
export function pickedInTheList(selection: Selection, items: readonly Item[]): Item[] {
  return items.filter((item) => selection.picked.has(item.id));
}

/**
 * Every list on screen that could be holding a selection.
 *
 * A module-level set rather than a context, for the reason `undo.tsx` keeps
 * one: the lists are siblings drawn by a board that knows nothing about
 * selecting, and threading a provider through it to say "not you" would make
 * every panel take part in a conversation only two of them are having.
 */
const listsOnScreen = new Set<() => void>();

/**
 * One list at a time holds a selection.
 *
 * Answers with the function to call when this list starts one; it empties every
 * other list's. **Starting one, not changing one** - a second tick in the same
 * list must not empty the list it is in.
 */
export function useOnlyOneListSelecting(empty: () => void): () => void {
  const latest = useRef(empty);
  latest.current = empty;
  const mine = useRef<(() => void) | null>(null);
  mine.current ??= () => latest.current();

  useEffect(() => {
    const entry = mine.current!;
    listsOnScreen.add(entry);
    return () => {
      listsOnScreen.delete(entry);
    };
  }, []);

  return useCallback(() => {
    for (const other of listsOnScreen) if (other !== mine.current) other();
  }, []);
}
