import {
  NO_DASHBOARD_FILTER,
  matchesDashboardFilter,
  searchTextOf,
  type Day,
  type DueWindow,
  type Item,
  type PriorityChoice,
} from '@cockpit/shared';

/**
 * What `find_items` asks of an account's Items ("Find items in Cockpit by text
 * and condition, over MCP", issue 1242): which Items meet it, in what order, and
 * where a page of them ends.
 *
 * **The rules are the screen's own** (`@cockpit/shared`): the text is Find
 * item's (`searchTextOf`, sender included), and status, priority and due are the
 * Dashboard filter's (`matchesDashboardFilter`), so an app and the screen cannot
 * disagree about what "due this week" matches.
 *
 * Pure, and proved at L1 (tests/unit/domain/find-items.test.ts). Reading the
 * rows is the store's.
 */

/** How many Items a page holds. */
export const FIND_PAGE = 25;

/** Where a page ended: the last Item's change time and id, which is all the next page needs to start after it. */
export interface FindCursor {
  updatedAt: string;
  id: string;
}

/** What a call asks for, once its arguments are read. */
export interface FindQuery {
  /** One Workspace, or `null` for every Workspace of the account. */
  workspaceId: string | null;
  /** Matched as Find item matches it; empty matches everything. */
  text: string;
  /** Only the open statuses are on offer: a finished Item is `includeDone`'s. */
  status: 'to_do' | 'in_progress' | null;
  priority: PriorityChoice | null;
  due: DueWindow | null;
  /** Adds the finished Items, which are otherwise left out. A dismissed Item is never found. */
  includeDone: boolean;
  /** What the due conditions count from. */
  today: Day;
  /** The page's start, or `null` for the first. */
  after: FindCursor | null;
}

/** One Item found, with the Workspace it is in and the Panels it is filed on as "Dashboard ▸ Panel" (none for the Inbox). */
export interface FoundRow {
  item: Item;
  workspaceName: string;
  places: string[];
}

/** One page of what was found, and where the next starts where more follow. */
export interface FoundPage {
  rows: FoundRow[];
  next: FindCursor | null;
}

const NO_ITEMS:ReadonlySet<string> = new Set();

/**
 * Whether an Item meets every condition asked for.
 *
 * **A due window takes in what is already overdue**, as the filter bar's *or
 * overdue* does by default: "due this week" that hid last week's work would hide
 * what most needs looking at.
 */
export function meetsFind(item: Item, query: FindQuery): boolean {
  const needle = query.text.trim().toLowerCase();
  if (needle !== '' && !searchTextOf(item).includes(needle)) return false;
  return matchesDashboardFilter(
    {
      ...NO_DASHBOARD_FILTER,
      statuses: query.status ? [query.status] : [],
      priorities: query.priority ? [query.priority] : [],
      due: query.due ? { window: query.due, orOverdue: true } : null,
    },
    item,
    NO_ITEMS,
    query.today,
    NO_ITEMS,
  );
}

/** Most recently changed first; the id breaks a tie so two Items changed at the same moment have one order. */
function newestFirst(a: Item, b: Item): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The page the query asks for out of the Items that met it: the ones after the
 * cursor in the order above, at most `FIND_PAGE`, and the cursor for the next
 * page where more follow.
 *
 * **Stateless**: the cursor says where the last page ended and nothing else, so
 * any instance answers any page. An Item changed between two pages moves ahead
 * of the cursor and is missed, which the tool's description says.
 */
export function pageOfFound(
  found: readonly Item[],
  after: FindCursor | null,
  size = FIND_PAGE,
): { page: Item[]; next: FindCursor | null } {
  const ordered = found.toSorted(newestFirst);
  const rest = after
    ? ordered.filter((item) => item.updatedAt < after.updatedAt || (item.updatedAt === after.updatedAt && item.id < after.id))
    : ordered;
  const page = rest.slice(0, size);
  const last = page.at(-1);
  return { page, next: rest.length > size && last ? { updatedAt: last.updatedAt, id: last.id } : null };
}
