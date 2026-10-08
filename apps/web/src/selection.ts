import { useEffect, useRef, useSyncExternalStore } from 'react';
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
 * **What the lists no longer show is not selected**, and that takes both
 * halves. `pickedInTheList` intersects with the rows in front of you, which is
 * what the ticks read; and the selection drops a row as it goes (`afterPruning`),
 * which is what stops one coming *back* still ticked - a row moved out from its
 * own menu and then put back by an undo used to return already picked.
 */

export interface Selection {
  /**
   * The items picked out, by id.
   *
   * Only rows the lists of its scope still show: one is dropped as it leaves,
   * so this never carries an id back into view.
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
 * Where a selection is held: one scope at a time, and the selection in it
 * ("Select across every panel of a dashboard", issue 863).
 *
 * **A scope is the open Dashboard, or one Workspace's Inbox** - never a single
 * list - so every Panel of a Dashboard picks into the same set, and an Item
 * shown on two of them is ticked on both and counted once.
 */
export interface Held {
  readonly scope: string | null;
  readonly selection: Selection;
}

export const NOTHING_HELD: Held = { scope: null, selection: NOTHING_PICKED };

export const dashboardScope = (dashboardId: string) => `dashboard:${dashboardId}`;
export const inboxScope = (workspaceId: string) => `inbox:${workspaceId}`;

/** What `scope` holds: nothing, unless it is the scope the selection is in. */
export function selectionIn(held: Held, scope: string): Selection {
  return held.scope === scope ? held.selection : NOTHING_PICKED;
}

/**
 * The selection after `scope` changes what it holds.
 *
 * **Starting a selection in another scope ends the one held**, which is how the
 * Inbox and a Dashboard take turns. **Housekeeping never starts one**: an update
 * from a scope that holds nothing which leaves nothing - the Inbox's list
 * dropping rows it no longer shows, say - is not a selection to take over with,
 * and an Inbox refresh once emptied a Dashboard's that way.
 */
export function afterUpdating(
  held: Held,
  scope: string,
  update: (was: Selection) => Selection,
): Held {
  const was = selectionIn(held, scope);
  const next = update(was);
  if (next === was) return held;
  // Nothing left is nothing held, so the next pick starts afresh.
  if (next.picked.size === 0) return held.scope === scope ? NOTHING_HELD : held;
  return { scope, selection: next };
}

/** The selection after `scope` is over; any scope's, when none is named. */
export function afterEnding(held: Held, scope?: string): Held {
  return scope === undefined || held.scope === scope ? NOTHING_HELD : held;
}

/** What `scope` holds, less every id no list of it shows now. */
export function afterPruning(held: Held, scope: string, shown: ReadonlySet<string>): Held {
  return afterUpdating(held, scope, (was) => {
    if ([...was.picked].every((id) => shown.has(id))) return was;
    return {
      picked: new Set([...was.picked].filter((id) => shown.has(id))),
      // The row a shift-click reaches back to has to be one of these too.
      reachingFrom: was.reachingFrom && shown.has(was.reachingFrom) ? was.reachingFrom : null,
    };
  });
}

/** Every id added to what `scope` holds, which keeps its anchor. */
export function afterPickingAll(held: Held, scope: string, ids: Iterable<string>): Held {
  return afterUpdating(held, scope, (was) => {
    const picked = new Set([...was.picked, ...ids]);
    return picked.size === was.picked.size ? was : { picked, reachingFrom: was.reachingFrom };
  });
}

/** The rows a list of some scope shows now. */
export interface ShownRows {
  readonly scope: string;
  readonly ids: readonly string[];
}

/** Every distinct id the lists of `scope` show between them. */
export function shownIn(lists: Iterable<ShownRows>, scope: string): Set<string> {
  const shown = new Set<string>();
  for (const list of lists) if (list.scope === scope) for (const id of list.ids) shown.add(id);
  return shown;
}

// ---------------------------------------------------------------------------
// The one held selection of this tab, and the lists reporting what they show.
//
// Module-level rather than a context, for the reason `undo.tsx` keeps one: the
// lists are drawn by a board that knows nothing about selecting, and the bar,
// the menus and the Inbox are siblings of it. The tab is the whole of its life
// - a reload holds nothing.
// ---------------------------------------------------------------------------

let held: Held = NOTHING_HELD;
const heldListeners = new Set<() => void>();
const set = (next: Held) => {
  if (next === held) return;
  held = next;
  for (const listener of heldListeners) listener();
};
const subscribeToHeld = (listener: () => void) => {
  heldListeners.add(listener);
  return () => {
    heldListeners.delete(listener);
  };
};

/** The selection `scope` holds, and re-reads as it changes. */
export function useSelection(scope: string): Selection {
  return selectionIn(
    useSyncExternalStore(subscribeToHeld, () => held),
    scope,
  );
}

/** Changes what `scope` holds; see `afterUpdating`. */
export function updateSelection(scope: string, update: (was: Selection) => Selection) {
  set(afterUpdating(held, scope, update));
}

/** Ends `scope`'s selection - or whichever is held, when none is named. */
export function endSelection(scope?: string) {
  set(afterEnding(held, scope));
}

/** Adds ids to what `scope` holds. */
export function pickAll(scope: string, ids: Iterable<string>) {
  set(afterPickingAll(held, scope, ids));
}

const lists = new Map<symbol, ShownRows>();
const listsListeners = new Set<() => void>();
const listsChanged = () => {
  for (const listener of listsListeners) listener();
};

/**
 * Says what this list shows, for as long as it is on screen. A Dashboard's
 * Panels each report here, and `shownOn` is what they show between them.
 */
export function useShowing(scope: string, ids: readonly string[]) {
  const key = useRef(Symbol('list')).current;
  useEffect(() => {
    const was = lists.get(key);
    lists.set(key, { scope, ids });
    // A board redraws its lists with the same rows far more often than with
    // different ones, and each report would otherwise wake the pruning.
    if (was && was.scope === scope && was.ids.length === ids.length && was.ids.every((id, at) => id === ids[at])) return;
    listsChanged();
  }, [key, scope, ids]);
  useEffect(
    () => () => {
      lists.delete(key);
      listsChanged();
    },
    [key],
  );
}

/** The distinct ids the lists on screen show for `scope` right now. */
export function shownOn(scope: string): Set<string> {
  return shownIn(lists.values(), scope);
}

/**
 * Keeps what `scope` holds to what its lists show, and ends it when `scope` does.
 * Null for a list that is not the one to do it.
 *
 * **Against every list of the scope at once, after they have all reported.**
 * Each list reports from its own effect, one after the other: pruning as each
 * did would see a row that moved from one Panel to another as gone from the
 * first before the second had said it was there, and drop it. So the pruning
 * waits for the end of the turn the reports were made in.
 */
export function useHeldTo(scope: string | null) {
  useEffect(() => {
    if (scope === null) return;
    let waiting = false;
    const prune = () => {
      if (waiting) return;
      waiting = true;
      queueMicrotask(() => {
        waiting = false;
        set(afterPruning(held, scope, shownOn(scope)));
      });
    };
    listsListeners.add(prune);
    return () => {
      listsListeners.delete(prune);
      // Leaving the Dashboard - for another, or for another Workspace - is the
      // end of its selection.
      endSelection(scope);
    };
  }, [scope]);
}
