import type {
  DueWindow,
  Filing,
  FilterCondition,
  Item,
  ItemType,
  PanelFilter,
  Panel,
} from '@cockpit/shared';
import { filingsThatFile, itemsThatAreFiled } from './filing';
import { PRIORITY_LABELS } from './priority';

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
type Day = string;

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
 */
function daysAfter(day: Day, days: number): Day {
  const { year, month, date } = partsOf(day);
  const moved = new Date(Date.UTC(year, month - 1, date + days));
  return asDay(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
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
    const since = new Date(`${on}T00:00:00.000Z`).getUTCDay();
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
 * **Priority and Type both match on "any of"**, never on all of them at once
 * - *Priority is High or Normal* is one condition an Item meets by holding
 * either. An Item with no Priority, or no Type, matches neither ("Filter a
 * Filter panel by priority and type", issue 464) - absence is not among the
 * values on offer, the same way *not set* has to be asked for on a Due date.
 *
 * **A Type condition's values are read against the live Types alone.** A
 * value naming a Type since deleted is ignored rather than refused
 * (`typeConditionSchema`'s own comment), so it simply cannot be what an Item
 * matches on - and where deleting leaves a condition with no live value left,
 * every Item's Type fails to be among them and the condition matches nothing,
 * never widening to stand for every Type.
 */
function holdsFor(
  condition: FilterCondition,
  item: Item,
  on: Day,
  liveTypeIds: ReadonlySet<string>,
): boolean {
  if (condition.field === 'priority') {
    return item.priority !== null && condition.values.includes(item.priority);
  }
  if (condition.field === 'type') {
    if (item.typeId === null) return false;
    return condition.values.some((id) => liveTypeIds.has(id) && id === item.typeId);
  }
  const due = item.dueDate ?? null;
  if (condition.window === 'none') return due === null;
  if (due === null) return false;
  if (condition.window === 'overdue') return due < on;
  const span = spanOf(condition.window, on);
  if (!span) return false;
  // Widened past the window's own start rather than replacing it: *due this
  // week or overdue* is everything up to Sunday, last month's included.
  if (condition.orOverdue && due < on) return true;
  return due >= span.from && due <= span.to;
}

/** The priorities in the order a Filter reads them, highest first. */
const BY_PRIORITY = { high: 0, normal: 1, low: 2 };

/**
 * A Filter's rows, in the order it draws them.
 *
 * Its own function because it is its own rule. A Filter with only a Priority
 * or a Type condition mixes dated and undated Items freely - unlike a Due
 * date condition, neither says anything about whether an Item has one - which
 * is exactly what *no due date last* already handles rather than assumes
 * away.
 */
export function inFilterOrder(items: readonly Item[]): Item[] {
  return items.slice().sort(sortsBefore);
}

/**
 * Where an Item sorts on a Filter: by due date, then by priority, then oldest
 * first - and anything with no due date last, whatever else it has.
 *
 * **No due date goes last rather than first**, though an undated Item may well
 * be old: a Filter is read top-down for what is closest, and a row that cannot
 * say when it is wanted has nothing to be at the top of the list about.
 */
function sortsBefore(one: Item, other: Item): number {
  const dueOne = one.dueDate ?? null;
  const dueOther = other.dueDate ?? null;
  if (dueOne !== dueOther) {
    if (dueOne === null) return 1;
    if (dueOther === null) return -1;
    return dueOne < dueOther ? -1 : 1;
  }
  // An Item with no priority sorts after every Item that has one, for the
  // reason an undated one sorts after every dated one.
  const priorityOne = one.priority ? BY_PRIORITY[one.priority] : 3;
  const priorityOther = other.priority ? BY_PRIORITY[other.priority] : 3;
  if (priorityOne !== priorityOther) return priorityOne - priorityOther;
  return one.createdAt < other.createdAt ? -1 : one.createdAt > other.createdAt ? 1 : 0;
}

/**
 * Every open Item filed on a Panel of this Workspace that meets all of this
 * Filter's conditions, in the order the Filter draws them.
 *
 * **Filed, never the Inbox.** An Item nobody has triaged is what the Inbox is
 * for, and a Filter that drew it too would take the point out of triaging at
 * all. An Item filed on two Panels is still one row here, the filings being a
 * question of membership rather than of how many.
 *
 * **No conditions gathers nothing**, which is what lets a Filter say it has
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
  /** The account's live Types, which is what a Type condition's values are read against. */
  itemTypes: readonly ItemType[],
  filter: PanelFilter,
  on: Day,
): Item[] {
  if (filter.conditions.length === 0) return [];
  const liveTypeIds = new Set(itemTypes.map((type) => type.id));
  return inFilterOrder(
    itemsThatAreFiled(items, filingsThatFile(filings, panelsInWorkspace)).filter((item) =>
      filter.conditions.every((condition) => holdsFor(condition, item, on, liveTypeIds)),
    ),
  );
}

const WINDOW_READS: Record<DueWindow, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  week: 'Due this week',
  month: 'Due this month',
  quarter: 'Due this quarter',
  none: 'No due date',
};

/** Several names, read as a sentence lists them: one alone, two joined by *or*, three or more comma-led into it. */
function orList(names: readonly string[]): string {
  if (names.length === 0) return 'nothing';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * What a Filter shows, as a sentence - the funnel beside its name reads this
 * back on hover, so what a Panel is gathering can be asked of the Panel rather
 * than of the question that set it.
 *
 * **Joined with *and*, not with a comma**, because all of them have to hold: a
 * comma reads as a list of alternatives, which is the one thing a Filter cannot
 * be told to do (`docs/ideas.md`, "A Filter that reaches further than one rule
 * at a time"). *Or overdue* is said only where it widens something: on
 * *overdue* itself and on *not set* it is stored but means nothing.
 *
 * **A Type condition's values are read against `itemTypes`**, the same live
 * list matching itself reads against (`itemsMatchingFilter`), so a value
 * naming a Type since deleted is left out of the sentence exactly as it is
 * left out of what the condition matches.
 */
export function saysWhatItShows(
  conditions: readonly FilterCondition[],
  itemTypes: readonly ItemType[] = [],
): string {
  if (conditions.length === 0) return 'Nothing chosen yet';
  return conditions.map((condition) => sentenceFor(condition, itemTypes)).join(' and ');
}

function sentenceFor(condition: FilterCondition, itemTypes: readonly ItemType[]): string {
  if (condition.field === 'priority') {
    return `Priority is ${orList(condition.values.map((value) => PRIORITY_LABELS[value]))}`;
  }
  if (condition.field === 'type') {
    const names = condition.values
      .map((id) => itemTypes.find((type) => type.id === id)?.name)
      .filter((name): name is string => name !== undefined);
    return `Type is ${orList(names)}`;
  }
  const reads = WINDOW_READS[condition.window];
  const widened = condition.orOverdue && isAPeriod(condition.window);
  return widened ? `${reads} or overdue` : reads;
}
