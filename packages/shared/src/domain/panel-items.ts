import { itemsOnPanel } from './filing.js';
import { itemsMatchingFilter, type Day } from './filters.js';
import type { Dashboard, Item } from './item.js';
import { NO_CONDITIONS, panelGathers, type Filing, type Panel } from './panel.js';
import { DEFAULT_FILTER_SORT, inSortOrder, sortOf } from './sorting.js';

/** Everything a Panel's items are worked out from. */
export type PanelItemsInput = {
  items: readonly Item[];
  filings: readonly Filing[];
  /** Every Panel of the Workspace, since whether a filing files is a fact about the Panel it names. */
  panelsInWorkspace: readonly Panel[];
  /** The Workspace's live Dashboards, which a Filter's Dashboard condition is read against. */
  dashboards: readonly Pick<Dashboard, 'id'>[];
  /** The ids of the Items with an open run, which an Agent running condition is read against. */
  withRun: ReadonlySet<string>;
  today: Day;
};

/**
 * What a Panel holds before its Dashboard's filter narrows it: the Items filed
 * on it, or what its Filter gathers. A Panel of text holds none.
 *
 * The one rule the board, Go to panel's counts and `find_items` share, so a
 * panel named to an app finds what its header counts.
 */
export function itemsOfPanel(panel: Panel, c: PanelItemsInput): Item[] {
  return panelGathers(panel)
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
}
