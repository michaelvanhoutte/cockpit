import {
  NO_CONDITIONS,
  panelGathers,
  isFiltering,
  matchesDashboardFilter,
  type DashboardFilter,
  type Day,
  itemsMatchingFilter,
  DEFAULT_FILTER_SORT,
  inSortOrder,
} from '@cockpit/shared';
import type { Dashboard, Filing, Item, Panel } from '@cockpit/shared';
import { itemsOnPanel } from './filing';
import { sortOf } from './sorting';

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
        c.dashboards,
        panel.filter ?? NO_CONDITIONS,
        c.withRun,
        c.today,
        sortOf(panel) ?? DEFAULT_FILTER_SORT,
      )
    : inSortOrder(itemsOnPanel(c.items, c.filings, panel.id), sortOf(panel));
  return isFiltering(c.filter)
    ? list.filter((item) => matchesDashboardFilter(c.filter, item, c.withAttachments, c.today, c.withRun))
    : list;
}
