import { isFiltering, matchesDashboardFilter } from './dashboard-filter.js';
import type { DashboardFilter } from './dashboard-filter.js';
import { itemsMatchingFilter } from './filters.js';
import type { Day } from './filters.js';
import { itemsOnPanel } from './filing.js';
import type { Dashboard, Item } from './item.js';
import { NO_CONDITIONS, panelGathers } from './panel.js';
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
  /** What titles sort by where a sort names Title: the browser's own where none is given, and the one the Worker pins (`PANEL_READ_LOCALE`). */
  locale?: string | undefined;
};

/**
 * What a Panel shows: its own Items, or what its Filter gathers, narrowed by its
 * Dashboard's filter. The board draws this and Go to panel counts it, so a
 * count in the list is the one the header shows - and the Worker answers a
 * Panel read with it, against the day the phone sends.
 */
export function itemsShownOn(panel: Panel, c: PanelContents): Item[] {
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
  return isFiltering(c.filter)
    ? list.filter((item) => matchesDashboardFilter(c.filter, item, c.withAttachments, c.today, c.withRun))
    : list;
}
