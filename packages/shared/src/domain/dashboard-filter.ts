import type { AgentRun } from './agent-run.js';
import type { Attachment } from './attachment.js';
import { dueHolds, type Day } from './filter-rules.js';
import { itemStatus, type Item, type ItemStatus, type Priority } from './item.js';
import type { DueWindow } from './panel.js';

/**
 * A Dashboard filter's conditions: six, all of which must hold, narrowing what
 * the Panels of items and Filter panels already on one Dashboard show
 * ("Filter a dashboard by priority, due date, text and attachments", issue 633).
 *
 * Shared with the Worker so a connected app's `find_items` ("Find items in
 * Cockpit from a connected app, over MCP", issue 1240) reads a status, a
 * priority and a due window exactly as the filter bar does. Where a filter is
 * remembered, and the bar that sets it, stay in the browser.
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
