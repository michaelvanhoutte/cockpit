import { itemStatus } from './item.js';
import type { Item, ItemStatus, Priority } from './item.js';
import type { AgentRun } from './agent-run.js';
import type { Attachment } from './attachment.js';
import type { DueWindow } from './panel.js';
import { dueHolds } from './filters.js';
import type { Day } from './filters.js';

/**
 * A Dashboard filter: six conditions, all of which must hold, narrowing what
 * the Panels of items and Filter panels already on one Dashboard show
 * ("Filter a dashboard by priority, due date, text and attachments", issue 633).
 * What decides whether an Item meets one is here; where the browser keeps a
 * person's filter is not (`apps/web/src/dashboardFilter.ts`).
 */

/** A Priority, or the absence of one - which a Dashboard filter, unlike a Filter panel, can ask for. */
export type PriorityChoice = Priority | 'none';

export type AttachmentsChoice = 'any' | 'with' | 'without';

export type DashboardFilter = {
  /** Any of these statuses, an empty list meaning every status. */
  statuses: ItemStatus[];
  /** Any of these, an empty list meaning every Priority. */
  priorities: PriorityChoice[];
  /** The window an Item's due date falls in, or null for any time. */
  due: { window: DueWindow; orOverdue: boolean } | null;
  /** Case-insensitive, over the title, the description and the next action. */
  text: string;
  attachments: AttachmentsChoice;
  /** Only Items with an open run, whatever its status - a refused start included, which still shows its chip. */
  agentRunning: boolean;
};

export const NO_DASHBOARD_FILTER: DashboardFilter = {
  statuses: [],
  priorities: [],
  due: null,
  text: '',
  attachments: 'any',
  agentRunning: false,
};

/** Whether any of the six conditions is set - which is all "filtered" means. */
export function isFiltering(filter: DashboardFilter): boolean {
  return (
    filter.statuses.length > 0 ||
    filter.priorities.length > 0 ||
    filter.due !== null ||
    filter.text.trim() !== '' ||
    filter.attachments !== 'any' ||
    filter.agentRunning
  );
}

/**
 * The *Containing* rule: whether the text, trimmed and case-insensitive, is in
 * the title, the description or the next action. Nothing typed matches
 * everything.
 */
export function containsText(
  item: Pick<Item, 'title' | 'description' | 'nextAction'>,
  text: string,
): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [item.title, item.description ?? '', item.nextAction ?? ''].join('\n');
  return haystack.toLowerCase().includes(needle);
}

/**
 * Whether an Item meets every condition that is set, on the day the person is
 * looking.
 *
 * **The Due condition is a Filter panel's** (`dueHolds`), *or overdue*
 * included, so the two never disagree about what "this week" means.
 */
export function matchesDashboardFilter(
  filter: DashboardFilter,
  item: Item,
  withAttachments: ReadonlySet<string>,
  on: Day,
  withRun: ReadonlySet<string>,
): boolean {
  if (filter.statuses.length > 0 && !filter.statuses.includes(itemStatus(item))) return false;
  if (
    filter.priorities.length > 0 &&
    !filter.priorities.includes(item.priority ?? 'none')
  ) {
    return false;
  }
  if (filter.due && !dueHolds(filter.due.window, filter.due.orOverdue, item.dueDate ?? null, on)) {
    return false;
  }
  if (!containsText(item, filter.text)) return false;
  if (filter.attachments === 'with' && !withAttachments.has(item.id)) return false;
  if (filter.attachments === 'without' && withAttachments.has(item.id)) return false;
  if (filter.agentRunning && !withRun.has(item.id)) return false;
  return true;
}

/** The ids of the Items holding at least one attachment, read once for the whole board. */
export function itemIdsWithAttachments(attachments: readonly Attachment[]): Set<string> {
  return new Set(attachments.map((attachment) => attachment.itemId));
}

/** The ids of the Items with an open run, read once for the whole board. */
export function itemIdsWithRun(runs: readonly AgentRun[]): Set<string> {
  return new Set(runs.map((run) => run.itemId));
}
