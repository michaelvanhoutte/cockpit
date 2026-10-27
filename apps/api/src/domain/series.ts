import {
  RECURRING_REFUSALS,
  daysOnFrom,
  firstDayAfter,
  type Item,
  type Priority,
  type Series,
  type WriteRecurringItemCommand,
} from '@cockpit/shared';
import { captureDay } from './capture-day.js';

/** A recurring item's rule that is refused, in the words the person is told beside the field. */
export const UNKNOWN_TIME_ZONE = 'Cockpit does not know the time zone this device is in, so it cannot say when a day starts.';
export const NEXT_ON_PASSED = RECURRING_REFUSALS.nextOnPassed;

/**
 * A series as its row holds it: the rule, the day it is counted from
 * (`anchorOn`, null for its `nextOn`) and the day it last came round (`lastOn`).
 */
export type SeriesRow = Omit<Series, 'title' | 'workspaceId'> & { anchorOn: string | null; lastOn: string | null; createdAt: string; updatedAt: string };

/**
 * What each copy of a recurring item is made from ("Make each copy of a
 * recurring item from its own series", issue 1448), beside the Panels it files
 * on. `title` is null on a series that holds nothing yet.
 */
export interface MasterContent {
  workspaceId: string | null;
  title: string | null;
  description: string | null;
  priority: Priority | null;
}

/** A series as its row holds it, with what each copy is made from. */
export type MasterRow = SeriesRow & MasterContent;

/** What writing a recurring item's rule comes to, for it and its series. */
export type RepeatDecision =
  | { kind: 'refused'; why: string }
  /** Made against an older version of the rule: logged, nothing changed. */
  | { kind: 'stale' }
  | { kind: 'write'; row: SeriesRow; isNew: boolean };

/**
 * Decides one write of a recurring item's rule ("Make, change and delete
 * recurring items from the Recurring items modal", issue 1449).
 *
 * **Today is the day the change was issued on, on the zone it carries** - not the
 * moment it arrived - so the refusal of a *Next on* in the past does not depend
 * on how long the change took to get here. **The zone sent is the one kept**: the
 * rule is the person's as they last set it, on the calendar they set it on.
 *
 * **Only a *Next on* the person moves is held to today, and is what the series
 * is counted from after.** The form sends the stored one back with every other
 * choice; a tab whose copy is from before the series last came round sends that
 * day back, which is read as the stored one too - except on that day itself,
 * when it is the person moving *Next on* back to today. **A frequency changed
 * counts from the day kept**, the one the rule is read back from. A day kept that
 * has since passed stays while the series runs, so the account's alarm still
 * brings back the one it owes ("Bring a repeating Item back on its day", issue
 * 1407).
 */
export function decideRepeat(
  own: SeriesRow | null,
  cmd: Pick<WriteRecurringItemCommand, 'issuedAt' | 'repeat' | 'seriesId'>,
  tenantId: string,
): RepeatDecision {
  if (own && cmd.issuedAt < own.updatedAt) return { kind: 'stale' };
  const { timeZone, ...rule } = cmd.repeat;
  const today = captureDay(cmd.issuedAt, timeZone);
  if (today === null) return { kind: 'refused', why: UNKNOWN_TIME_ZONE };
  const keepsItsDay =
    own !== null && (rule.nextOn === own.nextOn || (rule.nextOn === own.lastOn && rule.nextOn !== today.date));
  if (rule.nextOn < today.date && !keepsItsDay) return { kind: 'refused', why: NEXT_ON_PASSED };
  const kept = keepsItsDay ? own.nextOn : rule.nextOn;
  const anchorOn = !keepsItsDay ? rule.nextOn : rule.frequency === own.frequency ? countedFrom(own) : kept;
  return {
    kind: 'write',
    isNew: own === null,
    row: {
      id: own?.id ?? cmd.seriesId,
      tenantId,
      ...rule,
      nextOn: kept,
      timeZone,
      stoppedAt: null,
      anchorOn,
      lastOn: own?.lastOn ?? null,
      createdAt: own?.createdAt ?? cmd.issuedAt,
      updatedAt: cmd.issuedAt,
    },
  };
}

/** What deleting a recurring item comes to: its series stopped, or - made against an older version than the one stored - nothing. */
export function decideStop(own: SeriesRow, issuedAt: string): RepeatDecision {
  if (issuedAt < own.updatedAt) return { kind: 'stale' };
  return { kind: 'write', row: { ...own, stoppedAt: own.stoppedAt ?? issuedAt, updatedAt: issuedAt }, isNew: false };
}

/**
 * The day a series' later days are counted from: its anchor where its *Next on*
 * is one of the days counted from it, and its *Next on* otherwise - a series
 * from before `anchor_on` existed, or a *Next on* or frequency an older release
 * changed without it ("Bring a repeating
 * Item back on its day, as a fresh copy", issue 1407). So the series always
 * comes round after the day it shows, on the rule it shows.
 */
export function countedFrom(own: Pick<SeriesRow, 'anchorOn' | 'nextOn' | 'frequency'>): string {
  if (own.anchorOn === null) return own.nextOn;
  const onItsRun = firstDayAfter(own.anchorOn, own.frequency, daysOnFrom(own.nextOn, -1)) === own.nextOn;
  return onItsRun ? own.anchorOn : own.nextOn;
}

/**
 * The instant `day` starts on the calendar of `timeZone` - its first moment there,
 * which is midnight on every day but one whose clocks jump over it - or null for
 * a zone this runtime cannot read ("Bring a repeating Item back on its day",
 * issue 1407). Searched for rather than worked out from an offset, so a day a
 * clock change shortens or lengthens is right without a rule for each.
 */
export function dayStartsAt(day: string, timeZone: string): number | null {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const utcMidnight = new Date(0);
  utcMidnight.setUTCFullYear(year, month - 1, date);
  // In whole minutes, as every zone's offset is today. Every zone is within
  // fourteen hours of UTC, so the day starts inside this window.
  const MINUTE = 60_000;
  let before = utcMidnight.getTime() / MINUTE - 15 * 60;
  let from = utcMidnight.getTime() / MINUTE + 15 * 60;
  const dayAt = (minute: number) => captureDay(new Date(minute * MINUTE).toISOString(), timeZone)?.date ?? null;
  if (dayAt(before) === null) return null;
  while (from - before > 1) {
    const middle = Math.floor((before + from) / 2);
    if (dayAt(middle)! < day) before = middle;
    else from = middle;
  }
  return from * MINUTE;
}

/** When a series' next occurrence is due: the start of its *Next on*, on UTC where its own zone cannot be read. */
export function occurrenceDueAt(series: Pick<Series, 'nextOn' | 'timeZone'>): number {
  return dayStartsAt(series.nextOn, series.timeZone) ?? dayStartsAt(series.nextOn, 'UTC')!;
}

/** What one occurrence is asked to be: its id, the moment it is written and the day it appears on. */
export interface OccurrenceAsked {
  itemId: string;
  at: string;
  today: string;
}

/**
 * The next occurrence of a recurring item, made from its series ("Make each
 * copy of a recurring item from its own series", issue 1448): the series'
 * title, description, priority and Workspace - **never an earlier copy's**, so
 * an edit to a copy stays on that copy - To do, due `dueAfterDays` after the
 * day it appears, and naming the series. **A fresh Item**: nothing captured,
 * no source, nothing proposed, no files, and its texts and priority the
 * person's own, so no reading replaces them. **Made after the previous one**,
 * even one stamped by a device whose clock runs ahead, since the latest made is
 * what must be finished before one more comes.
 */
export function occurrenceOf(
  master: Pick<SeriesRow, 'id' | 'tenantId' | 'dueAfterDays'> & { workspaceId: string; title: string } & Pick<MasterContent, 'description' | 'priority'>,
  previous: Pick<Item, 'createdAt'> | null,
  asked: OccurrenceAsked,
): Item {
  const dueDate = master.dueAfterDays === null ? null : daysOnFrom(asked.today, master.dueAfterDays);
  // A second on where it is not already later: whole seconds sort after it as
  // text however finely it was stamped, and text is how the latest is found.
  const createdAt =
    previous === null || asked.at > previous.createdAt
      ? asked.at
      : new Date(Date.parse(previous.createdAt) + 1000).toISOString();
  return {
    id: asked.itemId,
    tenantId: master.tenantId,
    workspaceId: master.workspaceId,
    workspaceDecided: true,
    capturedMessage: null,
    capturedTimeZone: null,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    sourceResolvedAt: null,
    title: master.title,
    description: master.description,
    textsSettledAt: asked.at,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    waitingSince: null,
    priority: master.priority,
    prioritySetAt: asked.at,
    dueDate,
    dueDateSetAt: dueDate === null ? null : asked.at,
    dueDateChosenAt: dueDate === null ? null : asked.at,
    seriesId: master.id,
    unseen: false,
    deletedAt: null,
    createdAt,
    updatedAt: asked.at,
  };
}

