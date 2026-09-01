/**
 * Moving one thing to a different place in a list, which is what both ways of
 * reordering a workspace produce ("Reorder workspaces", issue 31): the menu's
 * Move up and Move down, and the drag.
 *
 * It lives apart from the page because the two controls have to agree about
 * what a move is - a drag that put a workspace one place further along than
 * Move down does would be two orders for one gesture - and because the whole
 * order is what gets sent, so the answer here is the request.
 *
 * The list is left as it was rather than repaired when it is asked something
 * that makes no sense (a workspace that is not in it, a place past either end).
 * A move nobody can see is the one harmless outcome, and the page never asks
 * for one: the ends are unavailable in the menu and the drag clamps to the
 * list it is dragging inside.
 */

/** The list with `moving` taken out and put back at `to`, counting from zero. */
export function movedTo(order: readonly string[], moving: string, to: number): string[] {
  const from = order.indexOf(moving);
  if (from === -1) return [...order];
  const landing = Math.max(0, Math.min(order.length - 1, to));
  if (landing === from) return [...order];
  const rest = order.filter((id) => id !== moving);
  return [...rest.slice(0, landing), moving, ...rest.slice(landing)];
}

/**
 * The list with `moving` shifted `places` along - negative towards the front of
 * the list, which is the left of the tabs.
 */
export function movedBy(order: readonly string[], moving: string, places: number): string[] {
  const from = order.indexOf(moving);
  if (from === -1) return [...order];
  return movedTo(order, moving, from + places);
}
