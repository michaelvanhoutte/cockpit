import type { Item } from '@cockpit/shared';

/**
 * Pure handlers for the append-only decision history ("Learn where notes
 * belong from where you actually file them", issue 299; architecture §6.1:
 * domain imports nothing from the other layers).
 *
 * One entry per settled filing: what was proposed and what was chosen, so an
 * override is told apart from an accept by comparing the two rather than by a
 * flag that could drift from them.
 */

/** One row of `decision_history` (schema.ts), as `command-service.ts` writes it. */
export interface DecisionHistoryRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  itemId: string;
  proposedPanelId: string | null;
  proposedPanelReason: string | null;
  chosenPanelId: string;
  decidedAt: string;
}

/**
 * One entry as a routing proposal reads it back - joined to the note it was
 * about and the Panels it named.
 *
 * **Carries both a Panel's id and its name.** The id is what tells an accept
 * apart from an override - two Panels of one Workspace can share a display
 * name, since `panels_dashboard_live_folded_name` is unique only within one
 * dashboard (schema.ts) - and the name is what the prompt actually shows a
 * person's own words back to them as. Comparing names instead of ids would
 * misread an override as an accept the moment two same-named Panels exist.
 */
export interface DecisionHistoryEntry {
  capturedMessage: string | null;
  itemTitle: string;
  proposedPanelId: string | null;
  proposedPanelName: string | null;
  proposedPanelReason: string | null;
  chosenPanelId: string;
  chosenPanelName: string;
  decidedAt: string;
}

/**
 * The entry a filing onto `chosenPanelId` writes, snapshotting the Item's
 * live proposal at the moment it settles.
 *
 * **The command's own id, reused.** `move_item_to_panel` is already
 * idempotent on `commandId` (`command-service.ts`'s `commandAlreadyApplied`
 * guard runs before this is ever called), so reusing it as this row's id
 * costs nothing and keeps every entry traceable to the command that made it.
 *
 * **Reads `item.proposedPanelId`/`proposedPanelReason` as they stand right
 * now, not as they were when first written.** Nothing clears either once an
 * Item leaves the Inbox (`applyProposedPanel`'s own comment: "never read
 * again"), so what is here is frozen at whatever the last live proposal was -
 * exactly the value the accept chip on this filing would have shown, or null
 * where nothing was ever proposed.
 */
export function decisionHistoryEntryFor(
  item: Pick<Item, 'id' | 'tenantId' | 'proposedPanelId' | 'proposedPanelReason'>,
  cmd: { commandId: string; workspaceId: string; issuedAt: string },
  chosenPanelId: string,
): DecisionHistoryRow {
  return {
    id: cmd.commandId,
    tenantId: item.tenantId,
    workspaceId: cmd.workspaceId,
    itemId: item.id,
    proposedPanelId: item.proposedPanelId,
    proposedPanelReason: item.proposedPanelReason,
    chosenPanelId,
    decidedAt: cmd.issuedAt,
  };
}
