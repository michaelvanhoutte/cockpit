import { describe, expect, it } from 'vitest';
import type { Filing, FilterCondition, Item, Panel, Priority } from '@cockpit/shared';
import { filingsThatFile, itemsInTheInbox } from '../../src/filing';
import { dayOf, inFilterOrder, itemsMatchingFilter, saysWhatItShows } from '../../src/filters';

/**
 * F1: what a Filter gathers is a view over the snapshot evaluated in the
 * client, exactly as the Inbox is (`filing.ts`) - so this is the client's own
 * logic and there is no query to prove against a database. That a Filter reads
 * back as one at all is apps/api/tests/integration/http/panels.test.ts, and
 * what the Panel draws with what it is given is
 * apps/web/tests/unit/components/PanelBoard.test.tsx.
 *
 * **The day is passed in rather than read off the clock**, which is what makes
 * every window below a fixed question: a unit test may not touch the clock, and
 * `dayOf` is the one function that does.
 */

/** A Thursday, in the middle of its week, its month and its quarter. */
const TODAY = '2026-09-17';

function anItem(
  id: string,
  holding: { dueDate?: string | null; priority?: Priority | null; completedAt?: string | null; createdAt?: string; workspaceId?: string } = {},
): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: holding.workspaceId ?? 'ws-work',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: id,
    capturedMessage: null,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    sourceResolvedAt: null,
    typeId: null,
    nextAction: null,
    completedAt: holding.completedAt ?? null,
    priority: holding.priority ?? null,
    dueDate: holding.dueDate ?? null,
    unseen: false,
    deletedAt: null,
    createdAt: holding.createdAt ?? '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

function aPanel(id: string, kind: Panel['kind'] = 'items'): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    name: id,
    kind,
    format: 'plain',
    body: '',
    readOnly: false,
    filter: kind === 'filter' ? { conditions: [] } : null,
  };
}

const FALCON = aPanel('falcon');
const GATHERS = aPanel('gathers', 'filter');

function filed(panelId: string, itemId: string, position = 0): Filing {
  return { panelId, itemId, position };
}

function due(window: FilterCondition['window'], orOverdue = true): FilterCondition {
  return { field: 'dueDate', window, orOverdue };
}

/** What a Filter with these conditions draws, out of these items and filings. */
function shown(
  items: readonly Item[],
  filings: readonly Filing[],
  conditions: FilterCondition[],
  panels: readonly Panel[] = [FALCON, GATHERS],
  on = TODAY,
): string[] {
  return itemsMatchingFilter(items, filings, panels, { conditions }, on).map((item) => item.id);
}

describe('Panels', () => {
  describe('a filter shows exactly the open items filed on a panel of its workspace that meet its conditions', () => {
    const matching = { dueDate: TODAY };

    it.each([
      {
        situation: 'is still in the inbox',
        item: anItem('a', matching),
        filings: [] as Filing[],
        drawn: [] as string[],
      },
      {
        situation: 'is filed on a panel and matches',
        item: anItem('a', matching),
        filings: [filed('falcon', 'a')],
        drawn: ['a'],
      },
      {
        situation: 'is filed but finished with',
        item: anItem('a', { ...matching, completedAt: '2026-09-17T09:00:00.000Z' }),
        filings: [filed('falcon', 'a')],
        drawn: [],
      },
      {
        situation: 'is filed but due on another day',
        item: anItem('a', { dueDate: '2026-12-01' }),
        filings: [filed('falcon', 'a')],
        drawn: [],
      },
    ])('an item that $situation', ({ item, filings, drawn }) => {
      expect(shown([item], filings, [due('today')])).toEqual(drawn);
    });

    it('draws an item filed on two panels once', () => {
      const also = aPanel('anna');
      expect(
        shown(
          [anItem('a', matching)],
          [filed('falcon', 'a'), filed('anna', 'a')],
          [due('today')],
          [FALCON, also, GATHERS],
        ),
      ).toEqual(['a']);
    });

    it('draws nothing at all while it has no conditions', () => {
      // Which is what lets an untold filter say so, rather than quietly
      // gathering every filed item in the workspace.
      expect(shown([anItem('a', matching)], [filed('falcon', 'a')], [])).toEqual([]);
    });

    it('draws only what meets every condition it has', () => {
      // All of them hold, so two conditions narrow rather than widen: nothing
      // is both due today and undated.
      expect(
        shown([anItem('a', matching)], [filed('falcon', 'a')], [due('today'), due('none')]),
      ).toEqual([]);
    });
  });

  describe('a due window follows the calendar of whoever is looking', () => {
    /**
     * Every case is measured from the same Thursday, so what changes between
     * them is the window and the date - which is the whole of what these decide.
     */
    const dates = {
      lastMonth: '2026-08-20',
      lastWeek: '2026-09-09',
      yesterday: '2026-09-16',
      today: TODAY,
      thisMonday: '2026-09-14',
      thisSunday: '2026-09-20',
      nextMonday: '2026-09-21',
      endOfMonth: '2026-09-30',
      nextMonth: '2026-10-01',
      endOfQuarter: '2026-09-30',
      nextQuarter: '2026-10-01',
    };

    it.each([
      { situation: 'due today, asked for today', window: 'today', orOverdue: true, date: dates.today, drawn: true },
      { situation: 'due yesterday, asked for today or overdue', window: 'today', orOverdue: true, date: dates.yesterday, drawn: true },
      { situation: 'due yesterday, asked for today alone', window: 'today', orOverdue: false, date: dates.yesterday, drawn: false },
      { situation: 'due tomorrow, asked for today or overdue', window: 'today', orOverdue: true, date: '2026-09-18', drawn: false },
      { situation: 'due on this week’s Monday, asked for this week', window: 'week', orOverdue: false, date: dates.thisMonday, drawn: true },
      { situation: 'due on this week’s Sunday, asked for this week', window: 'week', orOverdue: false, date: dates.thisSunday, drawn: true },
      { situation: 'due on next Monday, asked for this week', window: 'week', orOverdue: false, date: dates.nextMonday, drawn: false },
      { situation: 'due last week, asked for this week alone', window: 'week', orOverdue: false, date: dates.lastWeek, drawn: false },
      { situation: 'due last week, asked for this week or overdue', window: 'week', orOverdue: true, date: dates.lastWeek, drawn: true },
      { situation: 'due on the last day of the month, asked for this month', window: 'month', orOverdue: false, date: dates.endOfMonth, drawn: true },
      { situation: 'due on the first of next month, asked for this month', window: 'month', orOverdue: false, date: dates.nextMonth, drawn: false },
      { situation: 'due last month, asked for this month alone', window: 'month', orOverdue: false, date: dates.lastMonth, drawn: false },
      { situation: 'due on the last day of the quarter, asked for this quarter', window: 'quarter', orOverdue: false, date: dates.endOfQuarter, drawn: true },
      { situation: 'due on the first day of the next quarter, asked for this quarter', window: 'quarter', orOverdue: false, date: dates.nextQuarter, drawn: false },
      { situation: 'due on the first day of this quarter, asked for this quarter', window: 'quarter', orOverdue: false, date: '2026-07-01', drawn: true },
      { situation: 'due yesterday, asked for overdue', window: 'overdue', orOverdue: true, date: dates.yesterday, drawn: true },
      { situation: 'due today, asked for overdue', window: 'overdue', orOverdue: true, date: dates.today, drawn: false },
      { situation: 'with no due date, asked for overdue', window: 'overdue', orOverdue: true, date: null, drawn: false },
      { situation: 'with no due date, asked for not set', window: 'none', orOverdue: true, date: null, drawn: true },
      { situation: 'due today, asked for not set', window: 'none', orOverdue: true, date: dates.today, drawn: false },
    ] as const)('an item $situation', ({ window, orOverdue, date, drawn }) => {
      expect(
        shown([anItem('a', { dueDate: date })], [filed('falcon', 'a')], [due(window, orOverdue)]),
      ).toEqual(drawn ? ['a'] : []);
    });

    it.each([
      { situation: 'a minute before midnight', at: new Date(2026, 8, 17, 23, 59), day: '2026-09-17' },
      { situation: 'a minute after it', at: new Date(2026, 8, 18, 0, 0), day: '2026-09-18' },
      { situation: 'on the first day of a month', at: new Date(2026, 9, 1, 8, 30), day: '2026-10-01' },
    ])('reads the day it is $situation off the clock in front of the person', ({ at, day }) => {
      // Local rather than UTC, which is the whole of "the viewer's calendar":
      // the `Date` above is built from local parts, so this is the day showing
      // on the clock wherever the suite is run.
      expect(dayOf(at)).toBe(day);
    });
  });

  describe('a filter’s rows go by due date, then priority, then oldest, with no due date last', () => {
    const items = [
      anItem('undated-but-oldest', { createdAt: '2020-01-01T08:00:00.000Z' }),
      anItem('later', { dueDate: '2026-09-18' }),
      anItem('soonest-low', { dueDate: TODAY, priority: 'low' }),
      anItem('soonest-none', { dueDate: TODAY, priority: null }),
      anItem('soonest-high', { dueDate: TODAY, priority: 'high' }),
      anItem('soonest-high-older', {
        dueDate: TODAY,
        priority: 'high',
        createdAt: '2026-01-01T08:00:00.000Z',
      }),
    ];

    it('breaks each tie with the next thing, in that order', () => {
      // A tie at every step: two dates, two priorities on the nearer one, and
      // two ages on the higher of those - and an undated row last, though it is
      // the oldest thing here by six years.
      expect(inFilterOrder(items).map((item) => item.id)).toEqual([
        'soonest-high-older',
        'soonest-high',
        'soonest-low',
        'soonest-none',
        'later',
        'undated-but-oldest',
      ]);
    });

    it('draws them in that order rather than in the order they were filed', () => {
      // The rows are gathered, so the panel's own filing order says nothing
      // about them: these are filed newest-due first and come back the other
      // way round.
      const filings = items.map((item, at) => filed('falcon', item.id, at));
      expect(shown(items, filings, [due('quarter', true)])).toEqual([
        'soonest-high-older',
        'soonest-high',
        'soonest-low',
        'soonest-none',
        'later',
      ]);
    });
  });

  describe('a filing onto a filter leaves its item in the inbox and is drawn nowhere', () => {
    /**
     * The only way to make one is against a release that predates Filters,
     * which reads a Filter as an empty panel of items and accepts a filing onto
     * it - so what this holds is that rolling that release back and forward
     * again loses nothing.
     */
    const item = anItem('a', { dueDate: TODAY });
    const ontoTheFilter = [filed('gathers', 'a')];

    it('leaves it in the inbox', () => {
      expect(
        itemsInTheInbox([item], filingsThatFile(ontoTheFilter, [FALCON, GATHERS])).map(
          (one) => one.id,
        ),
      ).toEqual(['a']);
    });

    it('takes it out of the inbox all the same when the filing is onto a panel of items', () => {
      // The other side of the rule, so a `filingsThatFile` that dropped every
      // filing would fail here rather than passing both.
      expect(
        itemsInTheInbox([item], filingsThatFile([filed('falcon', 'a')], [FALCON, GATHERS])),
      ).toEqual([]);
    });

    it('does not draw it on the filter, which shows only what is filed elsewhere', () => {
      expect(shown([item], ontoTheFilter, [due('today')])).toEqual([]);
    });
  });

  describe('a filter reads its conditions back as a sentence', () => {
    it.each([
      { situation: 'nothing chosen', conditions: [], reads: 'Nothing chosen yet' },
      { situation: 'due today or overdue', conditions: [due('today')], reads: 'Due today or overdue' },
      { situation: 'due today alone', conditions: [due('today', false)], reads: 'Due today' },
      { situation: 'due this week or overdue', conditions: [due('week')], reads: 'Due this week or overdue' },
      { situation: 'due this month alone', conditions: [due('month', false)], reads: 'Due this month' },
      { situation: 'due this quarter or overdue', conditions: [due('quarter')], reads: 'Due this quarter or overdue' },
      // *Or overdue* says nothing beside these two, so it is not read out: one
      // is overdue already, and the other is about an item with no date at all.
      { situation: 'overdue', conditions: [due('overdue')], reads: 'Overdue' },
      { situation: 'no due date', conditions: [due('none')], reads: 'No due date' },
      {
        // *And*, because that is what two conditions mean - a comma would read
        // as a list of alternatives, which is the one thing a Filter cannot be
        // asked for.
        situation: 'two conditions, both of which hold',
        conditions: [due('week', false), due('none')],
        reads: 'Due this week and No due date',
      },
    ])('reads $situation', ({ conditions, reads }) => {
      expect(saysWhatItShows(conditions)).toBe(reads);
    });
  });
});
