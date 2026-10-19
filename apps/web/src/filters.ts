import type {
  DueWindow,
  Dashboard,
  FilterCondition,
  FilterGrouping,
  PanelFilter,
  Panel,
} from '@cockpit/shared';
import { NO_CONDITIONS, isAPeriod, panelGathers, panelTakesItems, statusValuesOf } from '@cockpit/shared';
import { PRIORITY_LABELS } from './priority';

/**
 * What a Filter says about itself, drawn in the browser: its sentence, its
 * labels, the Panels it names and the warning before one is deleted. What a
 * Filter gathers, and the calendar its windows are measured on, are
 * `@cockpit/shared`'s (`filters.ts`), which the Worker reads as well.
 */

/** Nothing filed or matched - handed back for an Item `panelAndFilterIdsByItem` holds nothing for. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * "Also in" - every other live Panel or Filter one Item shows on, named and
 * in Panel order ("Say which other panels an item is also in, after its
 * title", issue 466).
 *
 * **Never the Panel or Filter the row itself is drawn on** - `drawnPanelId`
 * is what a row on the Inbox has none of, which is also the one place
 * `byItem` never holds anything for an Item to begin with.
 *
 * **In `panelsInWorkspace`'s own order, not filed-then-matched**: that is the
 * one list a filed Panel and a matched Filter both live in, so reading names
 * off it is what keeps two rows of the same Item agreeing on which name
 * comes first, rather than each ordering by how it happened to find them.
 */
export function alsoShownOn(
  itemId: string,
  byItem: ReadonlyMap<string, ReadonlySet<string>>,
  panelsInWorkspace: readonly Panel[],
  drawnPanelId: string | null,
  /**
   * The Panel a grouped Filter's heading is, left out as well: a row under
   * *Customers* has no need to say it is also in Customers ("Group a Filter
   * panel's items by the Dashboard or Panel they are filed on", issue 805).
   */
  headingPanelId: string | null = null,
): string[] {
  const ids = byItem.get(itemId) ?? EMPTY_IDS;
  if (ids.size === 0) return [];
  return panelsInWorkspace
    .filter((panel) => panel.id !== drawnPanelId && panel.id !== headingPanelId && ids.has(panel.id))
    .map((panel) => panel.name);
}

/**
 * What each window is called on a form, in the order a form offers them. Kept
 * out of the lazy-loaded `FilterQuestion.tsx`, because the Dashboard filter bar
 * draws them on first paint and importing them from there would put the whole
 * question in the initial bundle.
 */
export const WINDOW_LABELS: Record<DueWindow, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  none: 'Not set',
};

const WINDOW_READS: Record<DueWindow, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due this week',
  month: 'Due this month',
  quarter: 'Due this quarter',
  none: 'No due date',
};

/**
 * Several names, read as a sentence lists them with the given conjunction:
 * one alone, two joined by it, three or more comma-led into it.
 *
 * **One function for *and* and *or*, not two.** A Filter's own sentence
 * always joins with *or* (`sentenceFor`, below); a Panel's delete question
 * joins the Filters it would affect with *and* (`PanelBoard.tsx`,
 * `deletePanelQuestion`) - the same shape, differing only in the word, so
 * the one place this is written handles both rather than drifting into two
 * near-identical copies.
 */
export function joinedBy(names: readonly string[], conjunction: 'and' | 'or'): string {
  if (names.length === 0) return 'nothing';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

/**
 * What a Filter shows, as a sentence - the funnel beside its name reads this
 * back on hover, so what a Panel is gathering can be asked of the Panel rather
 * than of the question that set it.
 *
 * **Rows joined with *and*, not with a comma**, because all of them have to
 * hold: a comma reads as a list of alternatives. A Filter of one row of
 * alternatives - what *Any* saves - says so up front instead, *Any of: A; B*,
 * with semicolons, since a condition's own values already use commas and *or*;
 * a row of alternatives beside other rows is bracketed, *(A or B) and C*.
 * *Or overdue* is said only where it widens something: on *overdue* itself and
 * on *not set* it is stored but means nothing.
 *
 * **A Panel condition's values are read against `panels`**, the same live list
 * matching itself reads against (`itemsMatchingFilter`), so a value naming a
 * Panel since deleted is left out of the sentence exactly as it is left out of
 * what the condition matches.
 *
 * **An *is not* condition that filters nothing is left out** ("Include or
 * exclude a Filter panel condition's values, and filter on To do as well as In
 * progress", issue 908): one with no live value to exclude says nothing about
 * what is shown, and a sentence naming it would claim a narrowing that is not
 * happening - and a row of nothing else filters nothing, as `meetsRow` reads it.
 */
export function saysWhatItShows(
  rows: readonly (readonly FilterCondition[])[],
  panels: readonly Panel[] = [],
  groupBy: FilterGrouping = 'none',
  dashboards: readonly Pick<Dashboard, 'id' | 'name'>[] = [],
): string {
  if (rows.length === 0) return 'Nothing chosen yet';
  const said = rows
    .map((row) =>
      row
        .map((condition) => sentenceFor(condition, panels, dashboards))
        .filter((part): part is string => part !== null),
    )
    .filter((parts) => parts.length > 0);
  // One condition reads the same in a row of its own or among alternatives, so
  // it carries no prefix.
  const rule =
    said.length === 0
      ? 'Everything filed'
      : said.length === 1 && said[0]!.length > 1
        ? `Any of: ${said[0]!.join('; ')}`
        : said.map((parts) => (parts.length > 1 ? `(${parts.join(' or ')})` : parts[0]!)).join(' and ');
  return isGrouped(groupBy) ? `${rule}; grouped by ${GROUPING_NAMES[groupBy]}` : rule;
}

/**
 * Whether a Filter's rows are drawn under headings. A stored `groupBy` the
 * schema does not know already reads as `none` (`.catch('none')`).
 */
export function isGrouped(groupBy: FilterGrouping): groupBy is Exclude<FilterGrouping, 'none'> {
  return groupBy !== 'none';
}

/** What a grouping is called, in the funnel's sentence and the Filter question alike ("Group a Filter panel's items by the Dashboard or Panel they are filed on", issue 805). */
export const GROUPING_NAMES: Record<Exclude<FilterGrouping, 'none'>, string> = {
  dashboard: 'Dashboard',
  panel: 'Panel',
};

/**
 * One values condition as a sentence, or `null` where it filters nothing: an
 * *is not* with no live value left to name. An *is* with none still reads, as
 * "nothing", because it does empty the panel.
 */
function valuesSentence(
  asked: string,
  askedNot: string,
  exclude: boolean | undefined,
  names: readonly string[],
): string | null {
  if (exclude) return names.length === 0 ? null : `${askedNot} ${joinedBy(names, 'or')}`;
  return `${asked} ${joinedBy(names, 'or')}`;
}

function sentenceFor(
  condition: FilterCondition,
  panels: readonly Panel[],
  dashboards: readonly Pick<Dashboard, 'id' | 'name'>[],
): string | null {
  if (condition.field === 'dashboard') {
    const names = condition.values
      .map((id) => dashboards.find((dashboard) => dashboard.id === id)?.name)
      .filter((name): name is string => name !== undefined);
    return valuesSentence('On', 'Not on', condition.exclude, names);
  }
  if (condition.field === 'priority') {
    return valuesSentence('Priority is', 'Priority is not', condition.exclude, condition.values.map((value) => PRIORITY_LABELS[value]));
  }
  if (condition.field === 'panel') {
    // Read against the same items-Panels-only set matching itself reads
    // against (`itemsMatchingFilter`'s own `livePanelIds`) - a value naming a
    // Panel that still exists but no longer takes items (kept, say, only as
    // a stale row on some other Filter's own Panel condition) matches
    // nothing, so it is left out of the sentence too rather than named as if
    // it still could.
    const liveItemsPanels = panels.filter(panelTakesItems);
    const names = condition.values
      .map((id) => liveItemsPanels.find((panel) => panel.id === id)?.name)
      .filter((name): name is string => name !== undefined);
    return valuesSentence('Filed on', 'Not filed on', condition.exclude, names);
  }
  if (condition.field === 'agent') return 'Agent running';
  if (condition.field === 'status') {
    const names = statusValuesOf(condition).map((value) => (value === 'to_do' ? 'To do' : 'In progress'));
    return valuesSentence('Status is', 'Status is not', condition.exclude, names);
  }
  const reads = WINDOW_READS[condition.window];
  const widened = condition.orOverdue && isAPeriod(condition.window);
  return widened ? `${reads} or overdue` : reads;
}

/**
 * What deleting one Panel does to the Workspace's own Filters ("Filter a
 * Filter panel by panel, and name the Filters a panel's deletion affects",
 * issue 465) - every live Filter whose Panel condition names it, and whether
 * that condition is left holding another live Panel or none at all.
 *
 * **`panelsInWorkspace` alone, never a separate list of Filters.** A Filter is
 * a Panel (`panelGathers`), and the store never returns a deleted one at all
 * (`docs/architecture.md`, soft deletion) - so scanning the Workspace's live
 * Panels for the ones that gather is the same rule `filtersUsingPanel`'s own
 * caller already leans on to keep a deleted Filter from ever being named.
 *
 * **`leftEmpty` excludes the Panel about to go as well as every id already
 * dead**, so a condition naming two Panels, one already deleted and the other
 * the one now going, reads as left empty rather than as still holding
 * something nobody can see.
 */
export function filtersUsingPanel(
  panelId: string,
  panelsInWorkspace: readonly Panel[],
): { filter: Panel; leftEmpty: boolean }[] {
  // Items Panels alone, the same live set a Panel condition is matched and
  // read back against (`itemsMatchingFilter`'s own `livePanelIds`,
  // `sentenceFor`'s own `liveItemsPanels`) - a value naming a Panel that
  // still exists but no longer takes items matches nothing, so it must not
  // count as "still holding one" here either.
  const liveIds = new Set(panelsInWorkspace.filter(panelTakesItems).map((panel) => panel.id));
  const affected: { filter: Panel; leftEmpty: boolean }[] = [];
  for (const candidate of panelsInWorkspace.filter(panelGathers)) {
    const found = leftEmptyBy(candidate.filter ?? NO_CONDITIONS, 'panel', panelId, liveIds);
    if (found !== null) affected.push({ filter: candidate, leftEmpty: found });
  }
  return affected;
}

/**
 * Whether deleting `id` leaves a Filter showing nothing, or `null` where none of
 * its `field` conditions names `id` - the one answer `filtersUsingPanel` and
 * `filtersUsingDashboard` both give.
 *
 * **Only a row of that one condition is emptied by it.** A row with
 * alternatives still shows what they match, so a condition left with nothing
 * live does not leave it showing nothing. **An *is not* condition left with
 * nothing live excludes nothing**, which lets Items through rather than
 * emptying the Filter ("Include or exclude a Filter panel condition's
 * values...", issue 908), so it is named but never left empty.
 */
function leftEmptyBy(
  filter: PanelFilter,
  field: 'panel' | 'dashboard',
  id: string,
  liveIds: ReadonlySet<string>,
): boolean | null {
  let named = false;
  let emptied = false;
  for (const row of filter.rows) {
    for (const condition of row) {
      if (condition.field !== field || !condition.values.includes(id)) continue;
      named = true;
      const stillHasOne = condition.values.some((one) => one !== id && liveIds.has(one));
      if (!condition.exclude && !stillHasOne && row.length === 1) emptied = true;
    }
  }
  return named ? emptied : null;
}

/**
 * What deleting one Dashboard does to the Workspace's own Filters ("Include or
 * exclude a Dashboard in a Filter panel's conditions", issue 985): every live
 * Filter whose Dashboard condition names it, and whether that condition is
 * left holding another live Dashboard or none at all. The same shape and the
 * same rules as `filtersUsingPanel`, over Dashboards.
 */
export function filtersUsingDashboard(
  dashboardId: string,
  panelsInWorkspace: readonly Panel[],
  dashboards: readonly Pick<Dashboard, 'id'>[],
): { filter: Panel; leftEmpty: boolean }[] {
  const liveIds = new Set(dashboards.map((dashboard) => dashboard.id));
  const affected: { filter: Panel; leftEmpty: boolean }[] = [];
  for (const candidate of panelsInWorkspace.filter(panelGathers)) {
    // A Filter on the Dashboard itself goes with it, so there is nothing to warn about.
    if (candidate.dashboardId === dashboardId) continue;
    const found = leftEmptyBy(candidate.filter ?? NO_CONDITIONS, 'dashboard', dashboardId, liveIds);
    if (found !== null) affected.push({ filter: candidate, leftEmpty: found });
  }
  return affected;
}
