import { itemStatus, type Dashboard, type Item } from './item.js';
import {
  NO_CONDITIONS,
  panelGathers,
  panelTakesItems,
  statusValuesOf,
  type DueWindow,
  type Filing,
  type FilterCondition,
  type FilterGrouping,
  type Panel,
  type PanelFilter,
  type PanelSort,
} from './panel.js';
import { filingsThatFile, itemsThatAreFiled } from './filing.js';
import { PRIORITY_LABELS } from './priority-labels.js';
import { DEFAULT_FILTER_SORT, inSortOrder } from './sorting.js';

/**
 * What a Filter shows, worked out here rather than asked for ("Add a Filter
 * panel that shows every filed item due in a window", issue 463).
 *
 * **A view over the snapshot, exactly as the Inbox is** (`filing.ts`,
 * "Both are views evaluated in the client"): the wire carries the Workspace's
 * open Items, its filings and each Panel's conditions, and nothing about which
 * Items any Panel gathers. That is what makes a Filter cost no round trip, and
 * it is also the only place the *viewer's* calendar is known - *this week* is
 * the week of whoever is looking, which a server answering for an account
 * cannot say.
 */

/** A calendar day, as an Item's due date is stored: `2026-09-17`. */
export type Day = string;

/** The day it is where the person is looking, which is what every window is measured from. */
export function dayOf(now: Date): Day {
  return asDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function asDay(year: number, month: number, day: number): Day {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function partsOf(day: Day): { year: number; month: number; date: number } {
  const [year, month, date] = day.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 1, date: date ?? 1 };
}

/**
 * Calendar arithmetic through UTC though the day it starts from is local.
 *
 * The local day has already been read off the clock by `dayOf`; from there on
 * "six days later" is a question about a calendar and not about a moment, and
 * doing it in UTC is what keeps the hour a clock change introduces from moving
 * a boundary by a day.
 *
 * Exported for the due date field's own one-click shortcuts
 * (`dueDateShortcuts.ts`), which move a day the same way a Filter's window
 * does.
 */
export function daysAfter(day: Day, days: number): Day {
  const { year, month, date } = partsOf(day);
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return asDay(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/**
 * Which day of the week a calendar day falls on (`0` Sunday to `6`
 * Saturday), read the same way `daysAfter` moves one - through UTC, so the
 * local day already read off the clock is never shifted by the hour a
 * `Date` constructed straight from it would carry.
 *
 * Read by `week` below for the day the current week started on.
 */
export function weekdayOf(day: Day): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

/** The last day of a month, which `Date.UTC` gives as day zero of the next one. */
function lastDayOf(year: number, month: number): Day {
  const end = new Date(Date.UTC(year, month, 0));
  return asDay(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate());
}

/**
 * The first and last day one window covers, or null where the window is not a
 * period at all - *overdue* and *not set* are answers about a date rather than
 * ranges around one.
 *
 * **A week runs Monday to Sunday**, which is the week a working day sits in the
 * middle of; Sunday counting as the start would put Friday's work in next week
 * from Saturday morning.
 */
function spanOf(window: DueWindow, on: Day): { from: Day; to: Day } | null {
  if (!isAPeriod(window)) return null;
  if (window === 'today') return { from: on, to: on };
  const { year, month } = partsOf(on);
  if (window === 'week') {
    const since = weekdayOf(on);
    const from = daysAfter(on, -((since + 6) % 7));
    return { from, to: daysAfter(from, 6) };
  }
  if (window === 'month') return { from: asDay(year, month, 1), to: lastDayOf(year, month) };
  const first = Math.floor((month - 1) / 3) * 3 + 1;
  return { from: asDay(year, first, 1), to: lastDayOf(year, first + 2) };
}

/**
 * Whether a window is a stretch of the calendar rather than an answer about a
 * date. The four periods are; *overdue* and *not set* are not, which is why
 * *or overdue* is offered beside the four alone.
 */
export function isAPeriod(window: DueWindow): boolean {
  return window !== 'overdue' && window !== 'none';
}

/**
 * Whether one condition holds for one Item, on the day the person is looking.
 *
 * **Priority, Panel and Dashboard all match on "any of"**, never on all of them at
 * once - *Priority is High or Normal* is one condition an Item meets by
 * holding either. An Item with no Priority matches neither
 * ("Filter a Filter panel by priority and type", issue 464) - absence is not
 * among the values on offer, the same way *not set* has to be asked for on a
 * Due date. A Panel condition asks a different question of an Item that can
 * hold several answers at once - filed on any of the chosen Panels, rather
 * than holding one of several values - so it reads `filedPanelIds` instead of
 * a single field off the Item.
 *
 * **A Panel condition's values are read against what is still live alone.** A
 * value naming a Panel since deleted is ignored rather than refused
 * (`panelConditionSchema`'s own comment), so it simply cannot be what an Item
 * matches on - and where deleting leaves a condition with no live value left,
 * every Item fails to match and the condition matches nothing, never widening
 * to stand for every Panel.
 *
 * **An Agent running condition keeps an Item with an open run in any state**
 * ("Gather the Items an agent is running on into a Filter panel", issue 1153),
 * read off `withRun` - the ids the snapshot's runs name, as the Dashboard
 * filter reads them (`itemIdsWithRun`).
 *
 * **An *is not* condition matches an Item holding none of its live values**
 * ("Include or exclude a Filter panel condition's values, and filter on To do
 * as well as In progress", issue 908), so an Item with no Priority
 * passes, and an Item filed on any one excluded Panel fails. **With no live
 * value left it filters nothing**, answered as `null` - the opposite of an *is*
 * condition left in the same state, which fails: `meetsRow` says what a row
 * makes of it.
 */
function holdsFor(
  condition: FilterCondition,
  item: Item,
  on: Day,
  livePanelIds: ReadonlySet<string>,
  filedPanelIds: ReadonlySet<string>,
  liveDashboardIds: ReadonlySet<string>,
  filedDashboardIds: ReadonlySet<string>,
  withRun: ReadonlySet<string>,
): boolean | null {
  if (condition.field === 'agent') return withRun.has(item.id);
  if (condition.field !== 'dueDate' && condition.exclude) {
    if (condition.field === 'priority') {
      return excluding(condition.values, (live) => item.priority === null || !live.includes(item.priority));
    }
    if (condition.field === 'panel') {
      return excluding(
        condition.values.filter((id) => livePanelIds.has(id)),
        (live) => !live.some((id) => filedPanelIds.has(id)),
      );
    }
    if (condition.field === 'dashboard') {
      // Hides an Item only when every Panel it is filed on sits on an excluded
      // Dashboard - unlike *Panel is not*, where any one excluded Panel hides it.
      return excluding(
        condition.values.filter((id) => liveDashboardIds.has(id)),
        (live) => ![...filedDashboardIds].every((id) => live.includes(id)),
      );
    }
    return excluding(statusValuesOf(condition), (live) => !(live as readonly string[]).includes(itemStatus(item)));
  }
  if (condition.field === 'priority') {
    return item.priority !== null && condition.values.includes(item.priority);
  }
  if (condition.field === 'panel') {
    return condition.values.some((id) => livePanelIds.has(id) && filedPanelIds.has(id));
  }
  if (condition.field === 'dashboard') {
    return condition.values.some((id) => liveDashboardIds.has(id) && filedDashboardIds.has(id));
  }
  if (condition.field === 'status') {
    return (statusValuesOf(condition) as readonly string[]).includes(itemStatus(item));
  }
  return dueHolds(condition.window, condition.orOverdue, item.dueDate ?? null, on);
}

/** An *is not* condition over its live values: `null`, filtering nothing, where none is left to exclude. */
function excluding<V>(live: readonly V[], passes: (live: readonly V[]) => boolean): boolean | null {
  if (live.length === 0) return null;
  return passes(live);
}

/**
 * Whether an Item meets one row of a Filter: any one of its conditions holds
 * ("Join a Filter's rows with and, and a row's alternatives with or", issue
 * 1075).
 *
 * **A condition that filters nothing adds nothing to its row**, as it added
 * nothing under *Any* - and **a row of nothing else filters nothing**, letting
 * every Item through as such a condition did under *All*, since rows are
 * joined by *and*.
 */
function meetsRow(row: readonly FilterCondition[], holds: (condition: FilterCondition) => boolean | null): boolean {
  let filtersSomething = false;
  for (const condition of row) {
    const answer = holds(condition);
    if (answer === true) return true;
    if (answer === false) filtersSomething = true;
  }
  return !filtersSomething;
}

/**
 * Whether a due date falls in a window on the day the person is looking - a
 * Filter panel's Due condition, and a Dashboard filter's, which ask the same
 * question of an Item.
 */
export function dueHolds(
  window: DueWindow,
  orOverdue: boolean,
  due: Day | null,
  on: Day,
): boolean {
  if (window === 'none') return due === null;
  if (due === null) return false;
  if (window === 'overdue') return due < on;
  const span = spanOf(window, on);
  if (!span) return false;
  // Widened past the window's own start rather than replacing it: *due this
  // week or overdue* is everything up to Sunday, last month's included.
  if (orOverdue && due < on) return true;
  return due >= span.from && due <= span.to;
}

/**
 * A Filter's rows, in the order they are drawn: by its sort, then oldest first
 * wherever that leaves two tied ("Choose how a Filter's rows are sorted", issue
 * 527).
 *
 * Its own function because a Filter's last tie-break is its own rule: a sorted
 * Panel ends on the order you set, and a Filter has none. Adding Created
 * ascending where the sort does not name it is that rule, and changes nothing
 * where it does. An Item with no value for a criterion goes last in either
 * direction, which is what lets a Filter with only a Priority
 * condition mix dated and undated Items freely.
 */
export function inFilterOrder(items: readonly Item[], sort: PanelSort): Item[] {
  const withTheTie = sort.some((criterion) => criterion.field === 'createdAt')
    ? sort
    : [...sort, { field: 'createdAt' as const, direction: 'asc' as const }];
  return inSortOrder(items, withTheTie);
}

/**
 * Every open Item filed on a Panel of this Workspace that meets every one of
 * this Filter's rows, meeting a row by meeting any one condition in it ("Store
 * every Filter as rows, and save the All / Any choice as rows", issue 1081) -
 * in the order the Filter draws them.
 *
 * **Filed, never the Inbox.** An Item nobody has triaged is what the Inbox is
 * for, and a Filter that drew it too would take the point out of triaging at
 * all. An Item filed on two Panels is still one row here, the filings being a
 * question of membership rather than of how many.
 *
 * **No rows gathers nothing**, which is what lets a Filter say it has
 * nothing chosen instead of quietly showing every filed Item in the Workspace.
 *
 * **The Workspace's Panels, never the drawing dashboard's** - the rule
 * `filingsThatFile` states, and the caller's to keep, since this cannot tell a
 * short list from a stale one.
 */
export function itemsMatchingFilter(
  items: readonly Item[],
  filings: readonly Filing[],
  panelsInWorkspace: readonly Panel[],
  /** The Workspace's live Dashboards, which is what a Dashboard condition's values are read against. */
  dashboards: readonly Pick<Dashboard, 'id'>[],
  filter: PanelFilter,
  /** The ids of the Items with an open run (`itemIdsWithRun`), which an Agent running condition is read against. */
  withRun: ReadonlySet<string>,
  on: Day,
  /** How the Filter is sorted, which a Filter nobody has sorted answers with `DEFAULT_FILTER_SORT`. */
  sort: PanelSort = DEFAULT_FILTER_SORT,
): Item[] {
  if (filter.rows.length === 0) return [];
  // What a Panel condition's values are read against - every items Panel of
  // the Workspace still there to be chosen.
  const livePanelIds = new Set(panelsInWorkspace.filter(panelTakesItems).map((panel) => panel.id));
  const filed = filingsThatFile(filings, panelsInWorkspace);
  const filedPanelIdsByItem = panelIdsFiledOnto(filed);
  const liveDashboardIds = new Set(dashboards.map((dashboard) => dashboard.id));
  const dashboardIdOfPanel = new Map(panelsInWorkspace.map((panel) => [panel.id, panel.dashboardId]));
  // Only a Filter holding a Dashboard condition reads it, and this runs once per
  // Filter on every draw.
  const filedDashboardIdsByItem = new Map<string, Set<string>>();
  if (filter.rows.some((row) => row.some((condition) => condition.field === 'dashboard'))) {
    for (const filing of filed) {
      const dashboardId = dashboardIdOfPanel.get(filing.panelId);
      if (dashboardId !== undefined) addToSetMap(filedDashboardIdsByItem, filing.itemId, dashboardId);
    }
  }
  return inFilterOrder(
    itemsThatAreFiled(items, filed).filter((item) => {
      const filedPanelIds = filedPanelIdsByItem.get(item.id) ?? EMPTY_PANEL_IDS;
      const filedDashboardIds = filedDashboardIdsByItem.get(item.id) ?? EMPTY_PANEL_IDS;
      return filter.rows.every((row) =>
        meetsRow(row, (condition) =>
          holdsFor(condition, item, on, livePanelIds, filedPanelIds, liveDashboardIds, filedDashboardIds, withRun),
        ),
      );
    }),
    sort,
  );
}

/** Nothing filed anywhere - handed to `holdsFor` for an Item no filing names, so nothing has to be allocated for it. */
const EMPTY_PANEL_IDS: ReadonlySet<string> = new Set();

/**
 * Puts `value` in the Set kept for `key`, starting one where this is the
 * first - the one allocate-or-add shape `panelIdsFiledOnto` and
 * `panelAndFilterIdsByItem` both build a `Map<string, Set<string>>` with,
 * written once rather than duplicated in each (found in review).
 */
function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const held = map.get(key);
  if (held) held.add(value);
  else map.set(key, new Set([value]));
}

/** Every Item's own filed-onto Panel ids, gathered once for the whole Filter rather than rescanned per condition. */
function panelIdsFiledOnto(filings: readonly Filing[]): Map<string, Set<string>> {
  const byItem = new Map<string, Set<string>>();
  for (const filing of filings) {
    addToSetMap(byItem, filing.itemId, filing.panelId);
  }
  return byItem;
}

/**
 * Every live Panel an Item is filed on, and every live Filter it matches,
 * keyed by Item id - the ids only, in no particular order ("Say which other
 * panels an item is also in, after its title", issue 466).
 *
 * **The inverse of `itemsMatchingFilter`**, and built once for the whole
 * Workspace rather than asking `itemsMatchingFilter` once per Filter per
 * row: a dashboard's own list of rows already pays for `itemsMatchingFilter`
 * once per Filter it draws (`PanelBoard.tsx`), and this is that same one
 * pass, reused, plus the filed-onto pass `itemsMatchingFilter` already runs
 * for its own Panel condition (`panelIdsFiledOnto`).
 *
 * An Item filed nowhere and matching nothing - every Inbox row - is simply
 * absent from the map rather than holding an empty Set, which is what lets a
 * caller read `?? EMPTY_IDS` instead of allocating one for every row that has
 * nothing to say.
 */
export function panelAndFilterIdsByItem(
  items: readonly Item[],
  filings: readonly Filing[],
  panelsInWorkspace: readonly Panel[],
  dashboards: readonly Pick<Dashboard, 'id'>[],
  withRun: ReadonlySet<string>,
  on: Day,
): Map<string, Set<string>> {
  const byItem = new Map<string, Set<string>>();
  for (const [itemId, panelIds] of panelIdsFiledOnto(filingsThatFile(filings, panelsInWorkspace))) {
    for (const panelId of panelIds) addToSetMap(byItem, itemId, panelId);
  }
  for (const filter of panelsInWorkspace.filter(panelGathers)) {
    const matches = itemsMatchingFilter(
      items,
      filings,
      panelsInWorkspace,
      dashboards,
      filter.filter ?? NO_CONDITIONS,
      withRun,
      on,
    );
    for (const item of matches) addToSetMap(byItem, item.id, filter.id);
  }
  return byItem;
}

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
