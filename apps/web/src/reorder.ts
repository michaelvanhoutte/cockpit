/**
 * Moving one thing to a different place in a list, which is what a drag
 * produces when it reorders a workspace ("Reorder workspaces", issue 31).
 *
 * It lives apart from the page because the whole order is what gets sent, so
 * the answer here is the request.
 *
 * The list is left as it was rather than repaired when it is asked something
 * that makes no sense (a workspace that is not in it, a place past either
 * end). A move nobody can see is the one harmless outcome, and the page never
 * asks for one: the drag clamps to the list it is dragging inside.
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
