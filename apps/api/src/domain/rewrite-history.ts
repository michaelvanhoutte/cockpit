import type { Priority, RefinementScope, RewriteAttemptStatus, SuggestedPanel } from '@cockpit/shared';

/**
 * Pure shapes for the rewrite-history table ("See the history of what
 * Cockpit proposed for the Inbox's items", issue 444) - see `schema.ts` for
 * what each column carries and why.
 *
 * Written from `jobs/enrichment.ts`'s own outcome points rather than from
 * `command-service.ts`, unlike `decision_history` beside it: an attempt here
 * is queued and settled outside any user command, so there is no `commandId`
 * to key a row on and no transaction it naturally belongs inside.
 */

/** One row as `queueRewriteAttempt` writes it, the moment an attempt is queued. */
export interface QueuedRewriteAttempt {
  id: string;
  tenantId: string;
  workspaceId: string;
  itemId: string;
  titleBefore: string;
  descriptionBefore: string | null;
  /** Which fields this attempt looks at, fixed by what set it off. */
  looksAt: RefinementScope;
  /** The item's suggested Panel at the moment this was queued. */
  panelBeforeId: string | null;
  attemptedAt: string;
}

/** What `recordRewriteOutcome` writes onto a queued attempt once it settles. */
export interface RewriteOutcome {
  status: Exclude<RewriteAttemptStatus, 'pending'>;
  message: string | null;
  titleAfter?: string | null;
  descriptionAfter?: string | null;
  /** The suggested Panel the item carries once this settled - never one the store refused. */
  proposedPanelId?: string | null;
  proposedPanelReason?: string | null;
  /** The priority this attempt set from what the note said; a later delivery's none never erases it (`recordRewriteOutcome`). */
  prioritySet?: Priority | null;
  /** The due date this attempt set from what the note said, kept the same way. */
  dueDateSet?: string | null;
  /** The name of the Workspace this attempt settled the item in from what the note said, kept the same way ("Settle an Any workspace capture in the workspace you name", issue 1078). */
  workspaceSet?: string | null;
  /** The names of the Panels this attempt filed the note on, kept the same way ("List the panels a capture was filed on in What Cockpit changed", issue 1117). */
  panelsFiledOn?: string[] | null;
}

/** One row as a rewrite-history table reads it back, joined to the Panels it names, if any. */
export interface RewriteHistoryEntryRow {
  id: string;
  itemId: string;
  titleBefore: string;
  titleAfter: string | null;
  descriptionBefore: string | null;
  descriptionAfter: string | null;
  proposedPanelName: string | null;
  status: RewriteAttemptStatus;
  message: string | null;
  attemptedAt: string;
  looksAt: RefinementScope | null;
  suggestedPanelBefore: SuggestedPanel | null;
  suggestedPanelAfter: SuggestedPanel | null;
  prioritySet: Priority | null;
  dueDateSet: string | null;
  workspaceSet: string | null;
  panelsFiledOn: string[];
}
