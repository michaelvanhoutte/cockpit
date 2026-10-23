import { itemIdsWithRun, NO_DASHBOARD_FILTER } from './dashboard-filter.js';
import { orderedAsDrawn, groupFilterRows } from './filter-groups.js';
import { placesFiledOn } from './filing.js';
import { itemLabel } from './item.js';
import type { Dashboard, Item, Priority, Workspace } from './item.js';
import { itemsShownOn } from './panel-contents.js';
import { NO_CONDITIONS, panelGathers, panelHoldsText } from './panel.js';
import type { Filing, Layout, Panel } from './panel.js';
import type { AgentRun } from './agent-run.js';
import type { Day } from './filters.js';

/**
 * What an app allowed only to read your Panels is told ("Read a Panel from an
 * app allowed only to read, and open Capture from its address", issue 1445):
 * the Panels there are to choose from, and one Panel's rows as Cockpit draws
 * them. Both are decisions over the Workspace's rows, worked out by the rules
 * the browser draws with, so a row an installed widget shows is the row the
 * Panel shows.
 *
 * **The answers only ever gain fields, and a reader ignores the ones it does
 * not know.** The types below say what an installed app depends on; a field
 * added to an answer still satisfies them, and one taken away or changed in
 * kind does not - which is what the samples in `packages/shared/samples/` hold
 * the real answers to (`apps/api/tests/samples.ts`) - the samples are the
 * contract, since nothing parses these types.
 *
 * **What a read returns is also what the consent page says it returns**
 * (`apps/api/src/mcp/consent.ts`): a field that tells an app more than that
 * page names is added there in the same change.
 */

/**
 * **What titles sort by in a read: English, whatever this Worker's runtime
 * would default to.** The browser sorts by the person's own locale; a Worker has
 * none to ask, and its default is whatever the environment it runs in says -
 * Dutch (Belgium) on a developer's machine, English (US) deployed - so left
 * alone, the same Panel would order its titles differently from one
 * environment to the next. English for the Latin alphabet, accents and case
 * orders as Dutch and French do; a phone that sorts by another locale's
 * alphabet is the case an added field could serve later.
 */
export const PANEL_READ_LOCALE = 'en';

/** The kinds of Panel a read can be made of: Panels of text hold no Items. */
export type ReadablePanelKind = 'items' | 'filter';

/** The Workspace's colour dot, as the widget draws it. */
interface WorkspaceDot {
  id: string;
  name: string;
  color: string;
}

/** Every Workspace with its Dashboards in tab order and their Panels in board order - no Panels of text, and no Items. */
export interface PanelList {
  workspaces: (WorkspaceDot & {
    dashboards: { id: string; name: string; panels: { id: string; name: string; kind: ReadablePanelKind }[] }[];
  })[];
}

/**
 * One row of a Panel as it is drawn: its label, priority and due date, and
 * *Dashboard ▸ Panel* for every other Panel it is filed on, or *Inbox*.
 */
export interface PanelReadRow {
  itemId: string;
  label: string;
  priority: Priority | null;
  /** The day it is due, `2026-10-23`, or null. How near that is is the reader's to say, on its own calendar. */
  dueDate: string | null;
  /** In board order; empty where there is nothing to add, which is an Item filed on this Panel alone. */
  places: string[];
}

/**
 * One Panel's rows under their headings. A Panel of items, and a Filter grouped
 * by nothing, is one group with no heading; a Filter grouped by Dashboard or by
 * Panel is a group per heading, an Item on two Panels under both.
 */
export interface PanelReadGroup {
  heading: { name: string; dashboard: string | null } | null;
  rows: PanelReadRow[];
}

export interface PanelRead {
  panel: { id: string; name: string; kind: ReadablePanelKind; dashboardId: string };
  workspace: WorkspaceDot;
  /** How many Items the Panel shows: the one a heading's rows repeat, counted once. */
  count: number;
  groups: PanelReadGroup[];
}

/** One Workspace's rows as the store hands them over for a read. */
export interface ReadableWorkspace {
  workspace: Workspace;
  dashboards: readonly Dashboard[];
  panels: readonly Panel[];
  layouts: readonly Layout[];
}

/** A Workspace's rows plus everything a Panel's contents are worked out from. */
export interface ReadableSnapshot extends ReadableWorkspace {
  items: readonly Item[];
  filings: readonly Filing[];
  agentRuns: readonly AgentRun[];
}

/** The Panels of a Workspace the way its Dashboards draw them: Dashboards as the tabs run, each one's Panels row by row and left to right. */
export function panelsInBoardOrder(w: Pick<ReadableWorkspace, 'dashboards' | 'panels' | 'layouts'>): Panel[] {
  return w.dashboards.flatMap((dashboard) =>
    orderedAsDrawn(
      w.panels.filter((panel) => panel.dashboardId === dashboard.id),
      w.layouts.find((layout) => layout.dashboardId === dashboard.id) ?? null,
    ),
  );
}

/**
 * Every Workspace with its Dashboards and their Panels, in the order Cockpit
 * shows them, for the picker. **Only Panels a read can be made of**: a Panel of
 * text has no Items to read. A Dashboard holding none is still listed, and
 * left for the reader to leave out.
 */
export function panelList(workspaces: readonly ReadableWorkspace[]): PanelList {
  return {
    workspaces: workspaces.map((w) => {
      const inBoardOrder = panelsInBoardOrder({
        dashboards: w.dashboards,
        panels: w.panels.filter((panel) => !panelHoldsText(panel)),
        layouts: w.layouts,
      });
      return {
        id: w.workspace.id,
        name: w.workspace.name,
        color: w.workspace.color,
        dashboards: w.dashboards.map((dashboard) => ({
          id: dashboard.id,
          name: dashboard.name,
          panels: inBoardOrder
            .filter((panel) => panel.dashboardId === dashboard.id)
            .map((panel) => ({ id: panel.id, name: panel.name, kind: panel.kind as ReadablePanelKind })),
        })),
      };
    }),
  };
}

/**
 * What a Panel shows, as the app draws it, judged by `today` - **the day on the
 * phone, never one this Worker works out**, since *due today* and *this week*
 * are the week of whoever is looking.
 *
 * `null` for a Panel the Workspace does not hold, and for a Panel of text,
 * which nothing is read from: both are a Panel that cannot be read.
 *
 * **The Dashboard's filter is not applied**: it is a person's own narrowing of
 * what their browser draws, kept in that browser, and a widget shows the
 * whole of the Panel.
 */
export function panelRead(snapshot: ReadableSnapshot, panelId: string, today: Day): PanelRead | null {
  const panel = snapshot.panels.find((one) => one.id === panelId);
  if (!panel || panelHoldsText(panel)) return null;

  const withRun = itemIdsWithRun(snapshot.agentRuns);
  const shown = itemsShownOn(panel, {
    items: snapshot.items,
    filings: snapshot.filings,
    panelsInWorkspace: snapshot.panels,
    dashboards: snapshot.dashboards,
    filter: NO_DASHBOARD_FILTER,
    withAttachments: new Set(),
    withRun,
    today,
    locale: PANEL_READ_LOCALE,
  });

  const inBoardOrder = panelsInBoardOrder(snapshot);
  const rowOf = (item: Item, notAgainst: string | null): PanelReadRow => ({
    itemId: item.id,
    label: itemLabel(item),
    priority: item.priority,
    dueDate: item.dueDate,
    places: placesOf(item, snapshot.filings, inBoardOrder, snapshot.dashboards, notAgainst),
  });

  const groupBy = panelGathers(panel) ? (panel.filter ?? NO_CONDITIONS).groupBy : 'none';
  const groups: PanelReadGroup[] =
    groupBy === 'none'
      ? [{ heading: null, rows: shown.map((item) => rowOf(item, panel.id)) }]
      : groupFilterRows(shown, groupBy, snapshot.filings, snapshot.panels, snapshot.dashboards, snapshot.layouts).map(
          (group) => ({
            heading: { name: group.name, dashboard: group.dashboardName },
            rows: group.items.map((item) => rowOf(item, group.panelId)),
          }),
        );

  return {
    panel: { id: panel.id, name: panel.name, kind: panel.kind as ReadablePanelKind, dashboardId: panel.dashboardId },
    workspace: { id: snapshot.workspace.id, name: snapshot.workspace.name, color: snapshot.workspace.color },
    count: shown.length,
    groups,
  };
}

/**
 * *Dashboard ▸ Panel* for each Panel an Item is filed on but the one it is
 * drawn under, in board order; *Inbox* for an Item filed nowhere; and nothing
 * for one filed on that Panel alone, which has nothing to add.
 *
 * `notAgainst` is the Panel the row sits on, or the one a grouped Filter's
 * heading is - which the row has no need to say it is also on, as a row in
 * Cockpit leaves it out. Null where the row sits under a Dashboard heading or
 * under none.
 */
export function placesOf(
  item: Item,
  filings: readonly Filing[],
  panelsInOrder: readonly Panel[],
  dashboards: readonly Dashboard[],
  notAgainst: string | null,
): string[] {
  if (placesFiledOn(item, filings, panelsInOrder, dashboards).length === 0) return ['Inbox'];
  return placesFiledOn(
    item,
    filings.filter((filing) => filing.panelId !== notAgainst),
    panelsInOrder,
    dashboards,
  );
}
