import {
  NO_DASHBOARD_FILTER,
  itemStatus,
  matchesDashboardFilter,
  needleOf,
  searchTextOf,
  type Day,
  type DueWindow,
  type Item,
  type ItemStatus,
  type PriorityChoice,
} from '@cockpit/shared';

/**
 * Which Items a connected app's `find_items` answers with, and which page of
 * them ("Find items in Cockpit by text and condition, over MCP", issue 1242):
 * a decision over rows already read, so it is proved at L1
 * (tests/unit/domain/item-search.test.ts) and the read that feeds it at L2.
 *
 * **The rules are the screen's own** (`@cockpit/shared`): the text is *Find
 * item*'s (`searchTextOf`), and status, priority and due are the Dashboard
 * filter bar's (`matchesDashboardFilter`), so the Worker and the screen cannot
 * answer one question two ways.
 */

/** How many Items one reply carries. */
export const FIND_PAGE = 25;

/** Where the previous page ended: the last Item's change time and id, which together are unique. */
export interface ChangeCursor {
  changedAt: string;
  id: string;
}

export interface ItemSearch {
  /** The Workspace asked for, or null for the whole account. */
  workspaceId: string | null;
  /**
   * The name of a Panel or Filter panel, for the open Items filed on a Panel of
   * that name or gathered by a Filter panel of that name (`domain/panel-search.ts`);
   * null for any.
   */
  panel: string | null;
  /** Whether finished Items are searched too. A dismissed Item never is. */
  includeDone: boolean;
  /** Case-insensitive, over the title, description, next action and sender; null or blank for any. */
  text: string | null;
  status: ItemStatus | null;
  priority: PriorityChoice | null;
  due: { window: DueWindow; orOverdue: boolean } | null;
  /** The day the due conditions count from. */
  today: Day;
  /** Only Items changed before this one; null for the first page. */
  after: ChangeCursor | null;
}

/** One Item as a reply carries it: what it says, how it stands and the Panels it is filed on. */
export interface FoundItem {
  id: string;
  workspaceId: string;
  /** False for an Item no Workspace has been chosen for, which waits in every Inbox. */
  workspaceDecided: boolean;
  title: string;
  description: string | null;
  nextAction: string | null;
  status: ItemStatus;
  priority: Item['priority'];
  dueDate: string | null;
  sender: string | null;
  changedAt: string;
  /** "Dashboard ▸ Panel" for each Panel it is filed on, none for an Item in the Inbox. */
  places: string[];
}

/** One page of a search: the Items, and the cursor that continues it where more follow. */
export interface FoundPage {
  items: FoundItem[];
  next: string | null;
}

/** What a search for a Panel comes to where no Panel in scope has that name: the names there are instead. */
export interface NoSuchPanel {
  noSuchPanel: true;
  panelNames: string[];
}

/** What the account answers a search with: a page, or that the Panel named is none of its Panels. */
export type FindAnswer = FoundPage | NoSuchPanel;

const NO_IDS: ReadonlySet<string> = new Set();

/** Whether one Item meets every criterion given. */
export function meetsSearch(item: Item, search: ItemSearch): boolean {
  const needle = needleOf(search.text ?? '');
  if (needle !== '' && !searchTextOf(item).includes(needle)) return false;
  return matchesDashboardFilter(
    {
      ...NO_DASHBOARD_FILTER,
      statuses: search.status ? [search.status] : [],
      priorities: search.priority ? [search.priority] : [],
      due: search.due,
    },
    item,
    NO_IDS,
    search.today,
    NO_IDS,
  );
}

/** Most recently changed first, and by id wherever two changed at the same moment, so no two Items tie. */
function newestFirst(one: Item, other: Item): number {
  if (one.updatedAt !== other.updatedAt) return one.updatedAt < other.updatedAt ? 1 : -1;
  if (one.id === other.id) return 0;
  return one.id < other.id ? 1 : -1;
}

/**
 * The page of the matching Items, newest change first, and the cursor that
 * fetches the one after it - null where none follows.
 *
 * **The cursor is a position in the order, not a held result**, so an Item
 * changed between two pages moves ahead of it and is missed, which the tool's
 * description says. An Item at the page's edge is returned once however many
 * share its change time: the id breaks the tie.
 */
export function pageOfMatches(candidates: readonly Item[], search: ItemSearch): { items: Item[]; next: string | null } {
  const after = search.after;
  const matches = candidates
    .filter((item) => meetsSearch(item, search))
    .toSorted(newestFirst)
    .filter((item) => !after || item.updatedAt < after.changedAt || (item.updatedAt === after.changedAt && item.id < after.id));
  const items = matches.slice(0, FIND_PAGE);
  const last = items.at(-1);
  return { items, next: matches.length > items.length && last ? cursorFor(last) : null };
}

/** An Item as a reply carries it, given the Panels it is filed on. */
export function foundItem(item: Item, places: string[]): FoundItem {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    workspaceDecided: item.workspaceDecided,
    title: item.title,
    description: item.description,
    nextAction: item.nextAction,
    status: itemStatus(item),
    priority: item.priority,
    dueDate: item.dueDate,
    sender: item.sender,
    changedAt: item.updatedAt,
    places,
  };
}

/** The cursor that continues after this Item, in a form an app hands back untouched. */
export function cursorFor(item: Pick<Item, 'updatedAt' | 'id'>): string {
  return btoa(`${item.updatedAt}\n${item.id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\n([0-9A-Za-z-]{1,64})$/;

/** What a cursor says, or null for text that is not one Cockpit gave. */
export function readCursor(cursor: string): ChangeCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  let text: string;
  try {
    text = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return null;
  }
  const found = CURSOR.exec(text);
  return found ? { changedAt: found[1]!, id: found[2]! } : null;
}
