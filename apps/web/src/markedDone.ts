import { UNTITLED, panelTakesItems, type Dashboard, type Filing, type Item, type Panel } from '@cockpit/shared';
import { howLongAgo } from './capture';
import { containsText } from './dashboardFilter';
import { dayOf, daysAfter } from './filters';

/**
 * The window of items marked done ("See the items you have marked done, from
 * the header menu", issue 637): what it lists and how each row reads, worked out
 * from the one snapshot the workspace already holds.
 *
 * **A view over the snapshot, like the Inbox** (`filing.ts`): finished items
 * are in it so that undoing has something to put back, so nothing here asks the
 * server for anything and the list works offline. The snapshot is already one
 * workspace's, plus the items not yet assigned to one, so there is no
 * workspace to filter by.
 */

/** How many rows are drawn before *Show more*. */
export const MARKED_DONE_PAGE = 50;

export const GROUPS = ['Today', 'Previous 7 days', 'Earlier'] as const;
export type MarkedDoneGroup = (typeof GROUPS)[number];

export interface MarkedDoneRow {
  item: Item;
  title: string;
  /** The Type's name, or null for an item with none or whose Type has been deleted. */
  type: string | null;
  /** "Done 2h ago · was on Day to day ▸ Admin & money". */
  line: string;
  group: MarkedDoneGroup;
}

/** Every finished item, newest finished first. */
export function finishedItems(items: readonly Item[]): Item[] {
  return items
    .filter((item) => item.completedAt)
    .sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? ''));
}

/**
 * Which group a finish falls in, by the viewer's calendar day: today, the seven
 * days before it, or earlier. A time ahead of the clock counts as today.
 */
export function groupOf(completedAt: string, now: Date): MarkedDoneGroup {
  const today = dayOf(now);
  const day = dayOf(new Date(completedAt));
  if (day >= today) return 'Today';
  return day >= daysAfter(today, -7) ? 'Previous 7 days' : 'Earlier';
}

/**
 * Where an item was filed, as "Dashboard ▸ Panel" for each Panel that takes
 * items, or null where there is none to name.
 *
 * A filing onto a Filter is no filing (`filingsThatFile`), and one whose Panel
 * the snapshot no longer carries is a deleted Panel's: both leave the item in
 * the Inbox, which is what reopening it will do.
 */
export function placesFiledOn(
  item: Item,
  filings: readonly Filing[],
  panels: readonly Panel[],
  dashboards: readonly Dashboard[],
): string[] {
  const held = new Set(filings.filter((filing) => filing.itemId === item.id).map((f) => f.panelId));
  return panels
    .filter((panel) => held.has(panel.id) && panelTakesItems(panel))
    .map((panel) => {
      const dashboard = dashboards.find((candidate) => candidate.id === panel.dashboardId);
      return dashboard ? `${dashboard.name} ▸ ${panel.name}` : panel.name;
    });
}

/** "Done 2h ago", where the shortest way of saying it is "just now". */
export function doneAgo(completedAt: string, now: Date): string {
  const ago = howLongAgo(now.getTime() - Date.parse(completedAt));
  return ago === 'now' ? 'Done just now' : `Done ${ago} ago`;
}

/**
 * The first `limit` rows of what matches, and how many matched in all. Each
 * row's own line is worked out only for the ones returned, since placing an
 * item scans the filings and a long history would otherwise pay that for rows
 * nobody has scrolled to.
 *
 * The four lists besides the items are optional: a stored copy rehydrated from
 * IndexedDB is not parsed again (`InboxPanel`), so one taken before a field
 * existed lacks it.
 */
export function markedDoneRows(
  snapshot: {
    items: readonly Item[];
    filings?: readonly Filing[] | undefined;
    panels?: readonly Panel[] | undefined;
    dashboards?: readonly Dashboard[] | undefined;
    itemTypes?: readonly { id: string; name: string }[] | undefined;
  },
  search: string,
  now: Date,
  limit: number,
): { rows: MarkedDoneRow[]; total: number } {
  const matching = finishedItems(snapshot.items.filter((item) => containsText(item, search)));
  const rows = matching.slice(0, limit).map((item) => {
    const completedAt = item.completedAt ?? '';
    const places = placesFiledOn(
      item,
      snapshot.filings ?? [],
      snapshot.panels ?? [],
      snapshot.dashboards ?? [],
    );
    return {
      item,
      title: item.title.trim() || UNTITLED,
      type: (snapshot.itemTypes ?? []).find((type) => type.id === item.typeId)?.name ?? null,
      line: `${doneAgo(completedAt, now)} · was ${places.length > 0 ? `on ${places.join(', ')}` : 'in the Inbox'}`,
      group: groupOf(completedAt, now),
    };
  });
  return { rows, total: matching.length };
}
