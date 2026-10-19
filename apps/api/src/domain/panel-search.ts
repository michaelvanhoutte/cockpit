import {
  panelAndFilterIdsByItem,
  stillOpen,
  type Dashboard,
  type Day,
  type Filing,
  type Item,
  type Panel,
} from '@cockpit/shared';
import { foldName } from './names.js';

/**
 * Which Items a connected app's `find_items` gets when it names a Panel ("Find
 * items on a panel, over MCP", issue 1243): the Items filed on a Panel of that
 * name, or gathered by a Filter panel of that name, counted the way *Find
 * item*'s *Dashboard* mode counts them. A decision over rows already read, so
 * it is proved at L1 (tests/unit/domain/panel-search.test.ts) and the read that
 * feeds it at L2.
 *
 * **The rules are the screen's own**: `panelAndFilterIdsByItem` is what the
 * board and Find draw from, so what a Filter panel gathers, its due conditions
 * counted from the `today` the caller hands in, cannot be answered here a
 * second way.
 */

/** One Workspace as its snapshot carries it: the open Items, and what says which Panel holds which. */
export interface WorkspaceBoard {
  items: readonly Item[];
  filings: readonly Filing[];
  panels: readonly Panel[];
  dashboards: readonly Dashboard[];
  /** The ids of the Items with an open run, which an Agent running condition is read against. */
  withRun: ReadonlySet<string>;
}

/** The Panels of these going by this name, named the way the account compares names (case folded, trimmed). */
export function panelsNamed(panels: readonly Panel[], name: string): Panel[] {
  const folded = foldName(name);
  return panels.filter((panel) => foldName(panel.name) === folded);
}

/**
 * The open Items of one Workspace that sit on a Panel going by `name`: filed on
 * a Panel of items of that name, or gathered by a Filter panel of that name, on
 * any Dashboard. None where no Panel of the Workspace has the name.
 *
 * **Open Items only**, as the Dashboard draws them: a finished Item is on no
 * Dashboard (`indexForFind`), so no Panel finds it.
 */
export function itemsOnPanelsNamed(board: WorkspaceBoard, name: string, today: Day): Item[] {
  const named = new Set(panelsNamed(board.panels, name).map((panel) => panel.id));
  if (named.size === 0) return [];
  const heldBy = panelAndFilterIdsByItem(board.items, board.filings, board.panels, board.dashboards, board.withRun, today);
  return board.items.filter((item) => {
    if (!stillOpen(item)) return false;
    const held = heldBy.get(item.id);
    return held !== undefined && [...held].some((panelId) => named.has(panelId));
  });
}

/** Each name once, in the order the Panels come, ignoring case; the first spelling stands. */
export function distinctPanelNames(panels: readonly Panel[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const panel of panels) {
    const folded = foldName(panel.name);
    if (seen.has(folded)) continue;
    seen.add(folded);
    names.push(panel.name);
  }
  return names;
}
