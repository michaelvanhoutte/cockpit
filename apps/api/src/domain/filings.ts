import type { Filing, MoveItemToPanelCommand } from '@cockpit/shared';

/**
 * Pure handlers for filing an item on a panel (architecture, "Hono + Zod on
 * Cloudflare Workers": domain imports nothing from the other layers).
 *
 * A filing is one item on one panel, with a position in that panel's order
 * ("Panels hold the items filed into them, and the Inbox holds the rest",
 * issue 36). The Inbox is the absence of one.
 */

export interface FilingRow {
  tenantId: string;
  panelId: string;
  itemId: string;
  position: number;
  createdAt: string;
}

/**
 * The rows one panel's order becomes: the list's own order written down as
 * `position`, because nothing else carries it.
 *
 * The index is used as written rather than renumbered from what was there
 * before, so an order is always a whole answer and never a patch on one — which
 * is what makes sending the same move twice land on the same rows.
 * `placementRows` is the same function for the same reason.
 *
 * `createdAt` is the client's own timestamp, like every other command, so a
 * filing made offline records when it was made rather than when it arrived.
 */
export function filingRows(
  tenantId: string,
  cmd: MoveItemToPanelCommand,
): FilingRow[] {
  if (cmd.panelId === null) return [];
  const panelId = cmd.panelId;
  return cmd.order.map((itemId, position) => ({
    tenantId,
    panelId,
    itemId,
    position,
    createdAt: cmd.issuedAt,
  }));
}

/**
 * Why the order sent is not an order of this panel, or null when it is.
 *
 * **An order must name exactly the panel's items plus the one arriving.** It is
 * the panel's whole arrangement afterwards, so an item left out has no place in
 * it and its row would not survive — and a stranger in the list would file
 * something nobody moved. Both are the staleness the whole-order shape exists to
 * make visible (see `moveItemToPanelSchema`): a client working from a snapshot
 * that has moved on sends a list that no longer describes the panel, and is
 * told so rather than quietly overwriting it.
 *
 * The item arriving may already be on the panel, which is what a reorder is, so
 * it is added to the expected set rather than required to be absent from the
 * held one.
 *
 * Returned rather than thrown so the caller decides what it means, the way
 * `panelsNotOn` does.
 */
export function orderIsNotOfThePanel(
  held: readonly Filing[],
  cmd: MoveItemToPanelCommand,
): string | null {
  if (cmd.panelId === null) return null;
  const expected = new Set(held.map((filing) => filing.itemId));
  expected.add(cmd.itemId);

  const stranger = cmd.order.find((itemId) => !expected.has(itemId));
  if (stranger) return `the order names ${stranger}, which is not on this panel`;

  const sent = new Set(cmd.order);
  const missing = [...expected].find((itemId) => !sent.has(itemId));
  if (missing) return `the order leaves out ${missing}, which is on this panel`;

  return null;
}
