import { isFiltering, matchesDashboardFilter } from './dashboard-filter.js';
import type { DashboardFilter } from './dashboard-filter.js';
import { itemsMatchingFilter } from './filters.js';
import type { Day } from './filters.js';
import { itemsOnPanel } from './filing.js';
import { childrenOf } from './held-places.js';
import type { ChildRow } from './item-children.js';
import type { Dashboard, Item } from './item.js';
import { NO_CONDITIONS, panelGathers, panelTakesItems } from './panel.js';
import type { Filing, Panel } from './panel.js';
import { DEFAULT_FILTER_SORT, inSortOrder, sortOf } from './sorting.js';

/** Everything a Panel's contents are worked out from, for the Dashboard it is on. */
export type PanelContents = {
  items: readonly Item[];
  filings: readonly Filing[];
  /** Every Panel of the Workspace, since whether a filing files is a fact about the Panel it names. */
  panelsInWorkspace: readonly Panel[];
  /** The Workspace's live Dashboards, which a Filter's Dashboard condition is read against. */
  dashboards: readonly Pick<Dashboard, 'id'>[];
  filter: DashboardFilter;
  withAttachments: ReadonlySet<string>;
  withRun: ReadonlySet<string>;
  today: Day;
  /**
   * That a Panel of Items leaves out an Item due more than `LATER_AFTER_DAYS`
   * after `today`, and a child row due that far out. Absent means nothing is left
   * out, which is what a widget's read of a Panel wants.
   */
  hideLater?: boolean | undefined;
  /** The Workspace's parent-to-child rows, which a hidden child is counted from. */
  children?: readonly ChildRow[] | undefined;
  /** What titles sort by where a sort names Title: the browser's own where none is given, and the one the Worker pins (`PANEL_READ_LOCALE`). */
  locale?: string | undefined;
};

/** How many days ahead an Item's due date has to be before a Panel of Items sets it aside as *later*. */
export const LATER_AFTER_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Whether a due date is more than `LATER_AFTER_DAYS` after `today`: a date-only
 * string is UTC midnight, and so is `today`, so the difference is whole days
 * (the convention `deadlineOf` counts by). No date, a past one and one that is
 * not a date are never later.
 */
export function isLater(dueDate: string | null, today: Day): boolean {
  if (dueDate === null) return false;
  return Math.round((Date.parse(dueDate) - Date.parse(today)) / DAY_MS) > LATER_AFTER_DAYS;
}

/**
 * What a Panel shows, and how many of its rows are *later*: Items of a Panel of
 * Items due further out than `LATER_AFTER_DAYS`, and the children under a row
 * that is not. `hideLater` leaves the Items out of `rows`; `later` counts either way. **A hidden row hides its children
 * with it** and counts as one. A Filter and a Panel of text are never narrowed.
 */
export function panelRows(panel: Panel, c: PanelContents): { rows: Item[]; later: number } {
  const list = panelGathers(panel)
    ? itemsMatchingFilter(
        c.items,
        c.filings,
        c.panelsInWorkspace,
        c.dashboards,
        panel.filter ?? NO_CONDITIONS,
        c.withRun,
        c.today,
        sortOf(panel) ?? DEFAULT_FILTER_SORT,
        c.locale,
      )
    : inSortOrder(itemsOnPanel(c.items, c.filings, panel.id), sortOf(panel), c.locale);
  const narrowed = isFiltering(c.filter)
    ? list.filter((item) => matchesDashboardFilter(c.filter, item, c.withAttachments, c.today, c.withRun))
    : list;
  if (!panelTakesItems(panel)) return { rows: narrowed, later: 0 };
  const notLater = narrowed.filter((item) => !isLater(item.dueDate, c.today));
  let later = narrowed.length - notLater.length;
  const seen = new Set<string>();
  const countUnder = (parentId: string) => {
    if (seen.has(parentId)) return;
    seen.add(parentId);
    for (const child of childrenOf(c.children ?? [], c.items, parentId)) {
      if (isLater(child.dueDate, c.today)) later += 1;
      else countUnder(child.id);
    }
  };
  for (const item of notLater) countUnder(item.id);
  return { rows: c.hideLater ? notLater : narrowed, later };
}

/**
 * What a Panel shows: its own Items, or what its Filter gathers, narrowed by its
 * Dashboard's filter. The board draws this and Go to panel counts it, so a
 * count in the list is the one the header shows - and the Worker answers a
 * Panel read with it, against the day the phone sends.
 */
export function itemsShownOn(panel: Panel, c: PanelContents): Item[] {
  return panelRows(panel, c).rows;
}
