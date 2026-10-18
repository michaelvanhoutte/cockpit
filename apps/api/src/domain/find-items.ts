import {
  NO_DASHBOARD_FILTER,
  itemsOfPanel,
  matchesDashboardFilter,
  searchTextOf,
  type Day,
  type DueWindow,
  type Item,
  type Panel,
  type PanelItemsInput,
  type PriorityChoice,
} from '@cockpit/shared';
import { foldName } from './names.js';

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
  /** A Panel by name, matched without regard to case: only the Items it holds. `null` leaves Panels out of it. */
  panel: string | null;
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

/** What a call that named a Panel asked, and found no Panel of that name in scope: the Panels there are. */
export interface NoSuchPanel {
  noPanel: string[];
}

/** What `find_items` answers: a page, or the names of the Panels there are where the one named is none of them. */
export type FindResult = FoundPage | NoSuchPanel;

/** A file on a found Item: what it is called, never its contents ("Give attachment links with found items, over MCP", issue 1244). */
export interface FoundAttachment {
  id: string;
  filename: string;
  contentType: string;
}

/** One Item found, with the Workspace it is in, the Panels it is filed on as "Dashboard ▸ Panel" (none for the Inbox), and its files. */
export interface FoundRow {
  item: Item;
  workspaceName: string;
  places: string[];
  attachments: FoundAttachment[];
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

/** The Panels of a Workspace going by a name, however many Dashboards they are on. */
export function panelsNamed(panels: readonly Panel[], name: string): Panel[] {
  const folded = foldName(name);
  return panels.filter((panel) => foldName(panel.name) === folded);
}

/**
 * The Items held by the Panels of a Workspace going by a name, each once: what
 * each Panel's header counts (`itemsOfPanel`, the board's own rule), so a Filter
 * panel gathers what it shows and a Panel of text holds none. Two Panels of the
 * name give the Items of both. What a Dashboard's filter hides in the browser is
 * not applied: an app asks of the Panel, not of a screen.
 */
export function itemsOnPanelsNamed(name: string, c: PanelItemsInput): Item[] {
  const found = new Map<string, Item>();
  for (const panel of panelsNamed(c.panelsInWorkspace, name)) {
    for (const item of itemsOfPanel(panel, c)) found.set(item.id, item);
  }
  return [...found.values()];
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
