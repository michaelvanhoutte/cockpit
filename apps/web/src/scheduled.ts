import {
  ruleLabel,
  shortDay,
  UNTITLED,
  type Dashboard,
  type Filing,
  type Item,
  type Panel,
  type Series,
} from '@cockpit/shared';
import { placesFiledOn } from './allItems';

/**
 * The table on *Scheduled* ("See what is scheduled to come back", issue 1431):
 * one row per running repeating Item, soonest *Next on* first.
 *
 * **A view over the snapshot**, like *All items* (`allItems.ts`): the latest
 * copy of a series is the newest Item naming it, finished or not, and the row
 * reads its title and place from that copy and the rest from the series. The
 * table asks the server for nothing.
 */

export interface ScheduledRow {
  series: Series;
  /** The newest copy of the series: the Item a row opens. */
  latest: Item;
  title: string;
  repeats: string;
  nextOn: string;
  /** "Dashboard ▸ Panel" for each Panel, or *Inbox* for a copy not filed. */
  where: string;
}

/** A day as `shortDay` says it, with the year where it is not `thisYear`: "Fri 22 Oct" a year off reads as the Friday just gone. */
export function nextOnLabel(day: string, thisYear: number): string {
  const year = day.slice(0, 4);
  return year === String(thisYear) ? shortDay(day) : `${shortDay(day)} ${year}`;
}

/** The newer of two copies: by when it was made, then by id so equal times never order differently on two devices. */
const newer = (a: Item, b: Item) => (a.createdAt === b.createdAt ? a.id > b.id : a.createdAt > b.createdAt);

/**
 * A row for each series still running that has a copy in the snapshot, soonest
 * *Next on* first and by title within a day. A series stopped with *Never*, or
 * whose copies are all dismissed (none is in the snapshot), has no row.
 */
export function scheduledRows(
  snapshot: {
    items: readonly Item[];
    series: readonly Series[];
    filings: readonly Filing[];
    panels: readonly Panel[];
    dashboards: readonly Dashboard[];
  },
  thisYear: number,
): ScheduledRow[] {
  const latestOf = new Map<string, Item>();
  for (const item of snapshot.items) {
    if (!item.seriesId) continue;
    const held = latestOf.get(item.seriesId);
    if (!held || newer(item, held)) latestOf.set(item.seriesId, item);
  }
  const rows: ScheduledRow[] = [];
  for (const one of snapshot.series) {
    const latest = latestOf.get(one.id);
    if (one.stoppedAt !== null || !latest) continue;
    const places = placesFiledOn(latest, snapshot.filings, snapshot.panels, snapshot.dashboards);
    rows.push({
      series: one,
      latest,
      title: latest.title.trim() || UNTITLED,
      repeats: ruleLabel(one),
      nextOn: nextOnLabel(one.nextOn, thisYear),
      where: places.length > 0 ? places.join(', ') : 'Inbox',
    });
  }
  return rows.sort((a, b) => a.series.nextOn.localeCompare(b.series.nextOn) || a.title.localeCompare(b.title));
}
