import type { RewriteAttemptStatus } from '@cockpit/shared';

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
  attemptedAt: string;
}

/** What `recordRewriteOutcome` writes onto a queued attempt once it settles. */
export interface RewriteOutcome {
  status: Exclude<RewriteAttemptStatus, 'pending'>;
  message: string | null;
  titleAfter?: string | null;
  descriptionAfter?: string | null;
  proposedPanelId?: string | null;
  proposedPanelReason?: string | null;
}

/** One row as a rewrite-history table reads it back, joined to the Panel it proposed, if any. */
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
}
