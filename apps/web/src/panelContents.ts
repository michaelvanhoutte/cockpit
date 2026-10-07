import { NO_CONDITIONS, panelGathers } from '@cockpit/shared';
import type { Filing, Item, ItemType, Panel } from '@cockpit/shared';
import { isFiltering, matchesDashboardFilter } from './dashboardFilter';
import type { DashboardFilter } from './dashboardFilter';
import { itemsOnPanel } from './filing';
import type { Day } from './filters';
import { itemsMatchingFilter } from './filters';
import { DEFAULT_FILTER_SORT, inSortOrder, sortOf } from './sorting';

/** Everything a Panel's contents are worked out from, for the Dashboard it is on. */
export type PanelContents = {
  items: readonly Item[];
  filings: readonly Filing[];
  /** Every Panel of the Workspace, since whether a filing files is a fact about the Panel it names. */
  panelsInWorkspace: readonly Panel[];
  itemTypes: readonly ItemType[];
  filter: DashboardFilter;
  withAttachments: ReadonlySet<string>;
  withRun: ReadonlySet<string>;
  today: Day;
};

/**
 * What a Panel shows: its own Items, or what its Filter gathers, narrowed by its
 * Dashboard's filter. The board draws this and Go to panel counts it, so a
 * count in the list is the one the header shows.
 */
export function itemsShownOn(panel: Panel, c: PanelContents): Item[] {
  const list = panelGathers(panel)
    ? itemsMatchingFilter(
        c.items,
        c.filings,
        c.panelsInWorkspace,
        c.itemTypes,
        panel.filter ?? NO_CONDITIONS,
        c.today,
        sortOf(panel) ?? DEFAULT_FILTER_SORT,
      )
    : inSortOrder(itemsOnPanel(c.items, c.filings, panel.id), sortOf(panel), c.itemTypes);
  return isFiltering(c.filter)
    ? list.filter((item) => matchesDashboardFilter(c.filter, item, c.withAttachments, c.today, c.withRun))
    : list;
}
