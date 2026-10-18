import {
  matchesDashboardFilter,
  textMatches,
  type DashboardFilter,
  type Day,
  type Item,
  type ItemStatus,
  type Priority,
} from '@cockpit/shared';

/**
 * What a connected app's `find_items` asks of an account, and how the Items it
 * is asked about are cut into pages ("Find items in Cockpit from a connected
 * app, over MCP", issue 1240).
 *
 * Pure, and proved at L1 (tests/unit/accounts/find.test.ts). The rows come from
 * the account's store (`store.ts`), proved at L2 through `/mcp`. The rules for
 * what matches - text, status, priority and due - are the screen's own, in the
 * shared package.
 */

/** How many Items a reply holds. */
export const FIND_PAGE = 25;

/** The place after which the next page starts: the last Item shown, by when it changed and its id. */
export interface FindCursor {
  updatedAt: string;
  id: string;
}

/** What is asked, read and checked by `mcp/find-items.ts` against this account's own names. */
export interface FindQuery {
  /** The one Workspace searched, or null for the whole account. */
  workspaceId: string | null;
  /** The ids of every Panel of the name given, or null where no Panel is named. */
  panelIds: readonly string[] | null;
  /** Case-insensitive, over title, description, next action and sender; empty for any. */
  text: string;
  /** Status, Priority and Due, as the Dashboard filter bar holds them. Its own text and attachment conditions are unused. */
  filter: DashboardFilter;
  /** Whether finished Items are included. A dismissed Item never is. */
  includeDone: boolean;
  /** What the due windows count from. */
  today: Day;
  after: FindCursor | null;
}

/** One Item as a connected app is told of it. */
export interface FoundItem {
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  description: string | null;
  nextAction: string | null;
  status: ItemStatus;
  priority: Priority | null;
  dueDate: string | null;
  sender: string | null;
  /** "Dashboard ▸ Panel" for each Panel it is filed on; none for an Item in the Inbox. */
  places: string[];
  updatedAt: string;
  /** Names only: the sealed link is the Worker's to make. */
  attachments: { id: string; filename: string }[];
}

/** A page of Items, and where the next begins where more follow. */
export interface FoundPage {
  items: FoundItem[];
  next: FindCursor | null;
}

/**
 * The cursor as an app carries it: the place, sealed in nothing - it holds
 * nothing but a time and an id the app could read off a result. Stateless, so
 * any instance answers any page.
 */
export function encodeCursor(cursor: FindCursor): string {
  return btoa(JSON.stringify([cursor.updatedAt, cursor.id]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The place a cursor names, or `null` for anything Cockpit did not give. */
export function readCursor(raw: unknown): FindCursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [updatedAt, id] = parsed as unknown[];
  if (typeof updatedAt !== 'string' || typeof id !== 'string' || id === '' || Number.isNaN(Date.parse(updatedAt))) {
    return null;
  }
  return { updatedAt, id };
}

/**
 * Whether an Item comes after the cursor in the order a result is given in:
 * most recently changed first, the id breaking a tie. **The id is what makes a
 * page edge across two Items changed at the same moment return each once.**
 */
export function isAfterCursor(item: Pick<Item, 'updatedAt' | 'id'>, cursor: FindCursor): boolean {
  if (item.updatedAt !== cursor.updatedAt) return item.updatedAt < cursor.updatedAt;
  return item.id < cursor.id;
}

/** The order a result is given in: most recently changed first, the id breaking a tie. */
export function newestFirst(a: Pick<Item, 'updatedAt' | 'id'>, b: Pick<Item, 'updatedAt' | 'id'>): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Whether one Item meets every criterion given. Criteria combine with AND;
 * none given means every Item the rows were read for.
 *
 * - **Open Items only** unless includeDone.
 * - **Text** is *Find item*'s match (`textMatches`), nothing by meaning.
 * - **Status, Priority and Due** are the Dashboard filter bar's conditions
 *   (`matchesDashboardFilter`), counted from `today`.
 * - **A Panel** is met by an Item `gathered` holds: filed on a Panel of that
 *   name or gathered by a Filter panel of it, as *Find item*'s *Dashboard* mode
 *   counts it. A finished Item is on no Panel.
 */
export function itemMeets(query: FindQuery, item: Item, gathered: ReadonlySet<string> | null): boolean {
  if (!query.includeDone && item.completedAt !== null) return false;
  if (query.text.trim() !== '' && !textMatches(item, query.text)) return false;
  if (!matchesDashboardFilter(query.filter, item, NONE, query.today, NONE)) return false;
  if (query.panelIds !== null && !(gathered?.has(item.id) ?? false)) return false;
  return true;
}

/**
 * The page of these Items: the first `FIND_PAGE` meeting the query after the
 * cursor, and where the next begins where one more matches. **No total is
 * counted**, which would read every row in scope; the next page's start is the
 * last Item shown.
 *
 * Handed the rows in `newestFirst` order. An Item changed between two pages
 * moves ahead of the cursor and is missed, which the tool's description says.
 */
export function pageOf(
  rows: readonly Item[],
  query: FindQuery,
  gathered: ReadonlySet<string> | null,
): { page: Item[]; next: FindCursor | null } {
  const page: Item[] = [];
  let more = false;
  for (const item of rows) {
    if (query.after && !isAfterCursor(item, query.after)) continue;
    if (!itemMeets(query, item, gathered)) continue;
    if (page.length === FIND_PAGE) {
      more = true;
      break;
    }
    page.push(item);
  }
  const last = page[page.length - 1];
  return { page, next: more && last ? { updatedAt: last.updatedAt, id: last.id } : null };
}
