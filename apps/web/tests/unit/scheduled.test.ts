import { describe, expect, it } from 'vitest';
import type { Dashboard, Filing, Item, Panel, Series } from '@cockpit/shared';
import { nextOnLabel, scheduledRows } from '../../src/scheduled';

/**
 * F1, and pure: which repeating Items the Scheduled tab lists, in what order,
 * and how a row reads are decisions over one snapshot ("See what is scheduled
 * to come back", issue 1431). That the tab draws them and a row opens the form
 * is tests/unit/components/ScheduledBoard.test.tsx.
 */

const THIS_YEAR = 2026;

function aSeries(id: string, fields: Partial<Series> = {}): Series {
  return {
    id,
    tenantId: 'tenant',
    frequency: 'weekly',
    nextOn: '2026-10-28',
    dueAfterDays: null,
    timeZone: 'UTC',
    stoppedAt: null,
    ...fields,
  };
}

let made = 0;
/** A copy of a series, made `minute` minutes into the day, so the later one is the newer. */
function aCopy(seriesId: string | null, minute: number, fields: Partial<Item> = {}): Item {
  made += 1;
  return {
    id: `copy-${made}`,
    title: `Copy ${made}`,
    seriesId,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
    completedAt: null,
    ...fields,
  } as Item;
}

const DASHBOARDS = [{ id: 'd-day', name: 'Day to day' }] as Dashboard[];
const PANELS = [{ id: 'p-admin', dashboardId: 'd-day', name: 'Admin', kind: 'items' }] as Panel[];
const filed = (itemId: string): Filing => ({ itemId, panelId: 'p-admin', position: 0 });

function rowsOf(series: Series[], items: Item[], filings: Filing[] = []) {
  return scheduledRows({ series, items, filings, panels: PANELS, dashboards: DASHBOARDS }, THIS_YEAR);
}

describe('Dashboards', () => {
  describe('Scheduled lists each running series once, soonest first, from its latest copy', () => {
    it('orders by Next on, then by title within a day', () => {
      const rows = rowsOf(
        [
          aSeries('a', { nextOn: '2027-10-22' }),
          aSeries('b', { nextOn: '2026-11-02' }),
          aSeries('c', { nextOn: '2026-10-28' }),
          aSeries('d', { nextOn: '2026-10-28' }),
        ],
        [
          aCopy('a', 0, { title: 'Annual' }),
          aCopy('b', 0, { title: 'Monthly' }),
          aCopy('c', 0, { title: 'Zebra' }),
          aCopy('d', 0, { title: 'Aardvark' }),
        ],
      );

      expect(rows.map((row) => [row.title, row.nextOn])).toEqual([
        ['Aardvark', 'Wed 28 Oct'],
        ['Zebra', 'Wed 28 Oct'],
        ['Monthly', 'Mon 2 Nov'],
        ['Annual', 'Fri 22 Oct 2027'],
      ]);
    });

    it('orders two series alike in day and title by their ids, whatever order the snapshot holds them in', () => {
      const copies = [aCopy('b', 0, { title: 'Weekly review' }), aCopy('a', 0, { title: 'Weekly review' })];

      const forward = rowsOf([aSeries('a'), aSeries('b')], copies);
      const backward = rowsOf([aSeries('b'), aSeries('a')], copies);

      expect(forward.map((row) => row.series.id)).toEqual(['a', 'b']);
      expect(backward.map((row) => row.series.id)).toEqual(['a', 'b']);
    });

    it('is one row for a series with an open and two finished copies, read from the newest', () => {
      const newest = aCopy('a', 30, { title: 'Weekly review', completedAt: null });
      const rows = rowsOf(
        [aSeries('a')],
        [
          aCopy('a', 0, { title: 'Weekly review', completedAt: '2026-10-08T09:00:00.000Z' }),
          newest,
          aCopy('a', 15, { title: 'Weekly review (older)', completedAt: '2026-10-15T09:00:00.000Z' }),
        ],
        [filed(newest.id)],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: 'Weekly review', where: 'Day to day ▸ Admin', latest: { id: newest.id } });
    });

    it.each([
      {
        situation: 'the latest copy is finished, so it is listed where it was filed',
        copy: { completedAt: '2026-10-08T09:00:00.000Z' },
        filings: true,
        where: 'Day to day ▸ Admin',
      },
      { situation: 'the latest copy is in the Inbox', copy: {}, filings: false, where: 'Inbox' },
    ])('says where it is when $situation', ({ copy, filings, where }) => {
      const one = aCopy('a', 0, copy);

      expect(rowsOf([aSeries('a')], [one], filings ? [filed(one.id)] : [])[0]?.where).toBe(where);
    });

    it.each([
      {
        situation: 'a series stopped with Never',
        series: [aSeries('a', { stoppedAt: '2026-10-10T09:00:00.000Z' })],
        items: [aCopy('a', 0)],
      },
      { situation: 'a series whose copies are all dismissed, none being held', series: [aSeries('a')], items: [] },
      {
        situation: 'an Item that belongs to no series',
        series: [],
        items: [aCopy(null, 0)],
      },
    ])('does not list $situation', ({ series, items }) => {
      expect(rowsOf(series, items)).toEqual([]);
    });

    it('reads the rule off the series, and an untitled copy as untitled', () => {
      const rows = rowsOf([aSeries('a', { frequency: 'monthly', nextOn: '2026-11-02' })], [aCopy('a', 0, { title: '  ' })]);

      expect(rows[0]).toMatchObject({ repeats: 'Monthly on the 2nd', title: 'Untitled' });
    });
  });

  describe('Next on names the year only when it is not this year', () => {
    it.each([
      { situation: '2 Nov this year', day: '2026-11-02', said: 'Mon 2 Nov' },
      { situation: '22 Oct next year', day: '2027-10-22', said: 'Fri 22 Oct 2027' },
      { situation: 'a day last year', day: '2025-12-31', said: 'Wed 31 Dec 2025' },
    ])('says $said for $situation', ({ day, said }) => {
      expect(nextOnLabel(day, THIS_YEAR)).toBe(said);
    });
  });
});
