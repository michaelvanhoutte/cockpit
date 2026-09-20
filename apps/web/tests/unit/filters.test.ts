import { describe, expect, it } from 'vitest';
import type {
  DueCondition,
  Filing,
  FilterCondition,
  FilterMatch,
  Item,
  ItemType,
  Panel,
  Priority,
} from '@cockpit/shared';
import { filingsThatFile, itemsInTheInbox } from '../../src/filing';
import {
  alsoShownOn,
  dayOf,
  filtersUsingPanel,
  inFilterOrder,
  itemsMatchingFilter,
  panelAndFilterIdsByItem,
  saysWhatItShows,
} from '../../src/filters';

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
  holding: {
    dueDate?: string | null;
    priority?: Priority | null;
    typeId?: string | null;
    completedAt?: string | null;
    createdAt?: string;
    workspaceId?: string;
  } = {},
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
    typeId: holding.typeId ?? null,
    nextAction: null,
    completedAt: holding.completedAt ?? null,
    priority: holding.priority ?? null,
    dueDate: holding.dueDate ?? null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: holding.createdAt ?? '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

/** A live Type, exactly as `itemTypeSchema` shapes one. */
function aType(id: string, name: string): ItemType {
  return { id, tenantId: 'tenant', name, color: '#000000', position: 0, createdAt: '2026-08-31T08:00:00.000Z' };
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
    filter: kind === 'filter' ? { conditions: [], match: 'all' } : null,
  };
}

const FALCON = aPanel('falcon');
const GATHERS = aPanel('gathers', 'filter');

function filed(panelId: string, itemId: string, position = 0): Filing {
  return { panelId, itemId, position };
}

function due(window: DueCondition['window'], orOverdue = true): DueCondition {
  return { field: 'dueDate', window, orOverdue };
}

/** What a Filter with these conditions draws, out of these items and filings. */
function shown(
  items: readonly Item[],
  filings: readonly Filing[],
  conditions: FilterCondition[],
  {
    panels = [FALCON, GATHERS],
    itemTypes = [] as ItemType[],
    on = TODAY,
    match = 'all',
  }: {
    panels?: readonly Panel[];
    itemTypes?: readonly ItemType[];
    on?: string;
    match?: FilterMatch;
  } = {},
): string[] {
  return itemsMatchingFilter(items, filings, panels, itemTypes, { conditions, match }, on).map(
    (item) => item.id,
  );
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
          { panels: [FALCON, also, GATHERS] },
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

    it('draws only what meets every condition it has, across different fields', () => {
      // A Type condition and a Due date condition together: only an OKR due
      // this quarter, never an OKR due later or a Task due this quarter.
      const okr = aType('type-okr', 'OKR');
      const okrDueThisQuarter = anItem('okr-due', { typeId: okr.id, dueDate: TODAY });
      const okrDueLater = anItem('okr-later', { typeId: okr.id, dueDate: '2027-01-01' });
      const taskDueThisQuarter = anItem('task-due', { dueDate: TODAY });
      const items = [okrDueThisQuarter, okrDueLater, taskDueThisQuarter];

      expect(
        shown(
          items,
          items.map((item) => filed('falcon', item.id)),
          [{ field: 'type', values: [okr.id] }, due('quarter', false)],
          { itemTypes: [okr] },
        ),
      ).toEqual([okrDueThisQuarter.id]);
    });
  });

  describe('a filter set to any shows an item meeting one of its conditions, where all asks for every one', () => {
    const rule = [due('week'), { field: 'priority', values: ['high'] }] as FilterCondition[];
    const dueThisWeekNormal = anItem('due-normal', { dueDate: '2026-09-18', priority: 'normal' });
    const highNoDate = anItem('high-undated', { priority: 'high' });
    const nextMonthLow = anItem('later-low', { dueDate: '2026-10-20', priority: 'low' });
    const items = [dueThisWeekNormal, highNoDate, nextMonthLow];
    const everywhere = items.map((item) => filed('falcon', item.id));

    it.each([
      { situation: 'due this week and only Normal', match: 'any', item: dueThisWeekNormal, drawn: true },
      { situation: 'High with no due date', match: 'any', item: highNoDate, drawn: true },
      { situation: 'due next month and Low', match: 'any', item: nextMonthLow, drawn: false },
      // The contrast: the same rule under all wants both.
      { situation: 'only High', match: 'all', item: highNoDate, drawn: false },
    ] as const)('an item $situation is drawn: $drawn, under $match', ({ match, item, drawn }) => {
      expect(shown(items, everywhere, rule, { match }).includes(item.id)).toBe(drawn);
    });

    it('draws nothing where it has no conditions', () => {
      expect(shown(items, everywhere, [], { match: 'any' })).toEqual([]);
    });

    it('draws nothing still in the inbox, though it meets a condition', () => {
      expect(shown([highNoDate], [], rule, { match: 'any' })).toEqual([]);
    });

    it('draws an item meeting two conditions and filed on two panels once', () => {
      const also = aPanel('anna');
      const both = anItem('both', { dueDate: '2026-09-18', priority: 'high' });
      expect(
        shown([both], [filed('falcon', 'both'), filed('anna', 'both')], rule, {
          match: 'any',
          panels: [FALCON, also, GATHERS],
        }),
      ).toEqual(['both']);
    });

    it('lets a Priority condition with nothing ticked add nothing rather than everything', () => {
      // Under all, this row empties the Filter; under any it is one more way to
      // miss, so the Due date row alone decides.
      expect(
        shown(items, everywhere, [{ field: 'priority', values: [] }, due('week')], { match: 'any' }),
      ).toEqual(['due-normal']);
    });

    it('lets a Type condition whose only Type was deleted add nothing rather than every Type', () => {
      const typed = anItem('typed', { typeId: 'type-gone' });
      expect(
        shown(
          [typed, highNoDate],
          [filed('falcon', 'typed'), filed('falcon', 'high-undated')],
          [{ field: 'type', values: ['type-gone'] }, { field: 'priority', values: ['high'] }],
          { match: 'any' },
        ),
      ).toEqual(['high-undated']);
    });
  });

  describe('a Priority condition matches an item holding any of its chosen levels, and none with no priority at all', () => {
    it.each([
      {
        situation: 'one level chosen, and the item holds it',
        values: ['high'] as Priority[],
        item: anItem('a', { priority: 'high' }),
        drawn: true,
      },
      {
        situation: 'two levels chosen, and the item holds one of them',
        values: ['high', 'normal'] as Priority[],
        item: anItem('a', { priority: 'normal' }),
        drawn: true,
      },
      {
        situation: 'two levels chosen, and the item holds neither',
        values: ['high', 'normal'] as Priority[],
        item: anItem('a', { priority: 'low' }),
        drawn: false,
      },
      {
        situation: 'the item has no priority at all',
        values: ['high', 'normal', 'low'] as Priority[],
        item: anItem('a'),
        drawn: false,
      },
    ])('an item where $situation', ({ values, item, drawn }) => {
      expect(
        shown([item], [filed('falcon', item.id)], [{ field: 'priority', values }]),
      ).toEqual(drawn ? [item.id] : []);
    });
  });

  describe('a Type condition matches an item holding any of its live values, and matches nothing once none are', () => {
    const okr = aType('type-okr', 'OKR');
    const task = aType('type-task', 'Task');

    it.each([
      {
        situation: 'one Type chosen, and the item holds it',
        values: [okr.id],
        types: [okr, task],
        item: anItem('a', { typeId: okr.id }),
        drawn: true,
      },
      {
        situation: 'two Types chosen, and the item holds one of them',
        values: [okr.id, task.id],
        types: [okr, task],
        item: anItem('a', { typeId: task.id }),
        drawn: true,
      },
      {
        situation: "the item's own Type has since been deleted",
        values: [okr.id],
        // Not among the live Types handed in - the same as it reads once
        // deleted, whatever the condition still names.
        types: [] as ItemType[],
        item: anItem('a', { typeId: okr.id }),
        drawn: false,
      },
      {
        situation: 'every Type the condition names has since been deleted',
        values: [okr.id, task.id],
        types: [] as ItemType[],
        item: anItem('a', { typeId: okr.id }),
        drawn: false,
      },
      {
        situation: 'the item has no Type at all',
        values: [okr.id],
        types: [okr],
        item: anItem('a'),
        drawn: false,
      },
    ])('an item where $situation', ({ values, types, item, drawn }) => {
      expect(
        shown([item], [filed('falcon', item.id)], [{ field: 'type', values }], {
          itemTypes: types,
        }),
      ).toEqual(drawn ? [item.id] : []);
    });
  });

  describe('a Panel condition matches an item filed on any of its live Panels, and matches nothing once none are', () => {
    const wiki = aPanel('wiki');
    const notes = aPanel('notes');

    it.each([
      {
        situation: 'one Panel chosen, and the item is filed on it',
        values: ['wiki'],
        panels: [wiki],
        filedOn: 'wiki',
        drawn: true,
      },
      {
        situation: 'two Panels chosen, and the item is filed on one of them',
        values: ['wiki', 'notes'],
        panels: [wiki, notes],
        filedOn: 'notes',
        drawn: true,
      },
      {
        situation: 'one of two chosen Panels has since been deleted, and the item is filed on the live one',
        // Not among the Panels handed in - the same as it reads once deleted,
        // whatever the condition still names.
        values: ['wiki', 'gone'],
        panels: [wiki],
        filedOn: 'wiki',
        drawn: true,
      },
      {
        situation: 'every Panel the condition names has since been deleted',
        values: ['gone-one', 'gone-two'],
        panels: [] as Panel[],
        // Filed somewhere live, so it is not simply absent for being in the
        // inbox - just not on a Panel the condition still names.
        filedOn: 'falcon',
        drawn: false,
      },
      {
        situation: 'the item is filed on a Panel the condition does not name',
        values: ['wiki'],
        panels: [wiki, notes],
        filedOn: 'notes',
        drawn: false,
      },
    ])('an item where $situation', ({ values, panels, filedOn, drawn }) => {
      const item = anItem('a', {});
      expect(
        shown([item], [filed(filedOn, item.id)], [{ field: 'panel', values }], {
          panels: [FALCON, GATHERS, ...panels],
        }),
      ).toEqual(drawn ? [item.id] : []);
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
    const okr = aType('type-okr', 'OKR');
    const task = aType('type-task', 'Task');
    const wiki = aPanel('wiki', 'items');
    const notes = aPanel('notes', 'items');

    const priority = (...values: Priority[]): FilterCondition => ({ field: 'priority', values });
    const type = (...values: string[]): FilterCondition => ({ field: 'type', values });
    const panel = (...values: string[]): FilterCondition => ({ field: 'panel', values });

    it.each([
      { situation: 'nothing chosen', conditions: [] as FilterCondition[], itemTypes: [] as ItemType[], reads: 'Nothing chosen yet' },
      { situation: 'due today or overdue', conditions: [due('today')], itemTypes: [], reads: 'Due today or overdue' },
      { situation: 'due today alone', conditions: [due('today', false)], itemTypes: [], reads: 'Due today' },
      { situation: 'due this week or overdue', conditions: [due('week')], itemTypes: [], reads: 'Due this week or overdue' },
      { situation: 'due this month alone', conditions: [due('month', false)], itemTypes: [], reads: 'Due this month' },
      { situation: 'due this quarter or overdue', conditions: [due('quarter')], itemTypes: [], reads: 'Due this quarter or overdue' },
      // *Or overdue* says nothing beside these two, so it is not read out: one
      // is overdue already, and the other is about an item with no date at all.
      { situation: 'overdue', conditions: [due('overdue')], itemTypes: [], reads: 'Overdue' },
      { situation: 'no due date', conditions: [due('none')], itemTypes: [], reads: 'No due date' },
      {
        situation: 'priority is one level',
        conditions: [priority('high')],
        itemTypes: [],
        reads: 'Priority is High',
      },
      {
        situation: 'priority is several levels',
        conditions: [priority('high', 'normal')],
        itemTypes: [],
        reads: 'Priority is High or Normal',
      },
      {
        situation: 'type is one Type',
        conditions: [type(okr.id)],
        itemTypes: [okr, task],
        reads: 'Type is OKR',
      },
      {
        situation: 'type is several Types',
        conditions: [type(okr.id, task.id)],
        itemTypes: [okr, task],
        reads: 'Type is OKR or Task',
      },
      {
        // Left out rather than named: there is no live Type to read its name
        // off, the same reason matching ignores it (`filters.ts`).
        situation: 'a Type among the values has since been deleted',
        conditions: [type(okr.id, 'type-deleted')],
        itemTypes: [okr],
        reads: 'Type is OKR',
      },
      {
        // *And*, because that is what two conditions mean - a comma would read
        // as a list of alternatives, which is the one thing a Filter cannot be
        // asked for.
        situation: 'two conditions, both of which hold',
        conditions: [due('week', false), due('none')],
        itemTypes: [],
        reads: 'Due this week and No due date',
      },
      {
        situation: 'panel is one Panel',
        conditions: [panel(wiki.id)],
        itemTypes: [],
        panels: [wiki, notes],
        reads: 'Filed on wiki',
      },
      {
        situation: 'panel is several Panels',
        conditions: [panel(wiki.id, notes.id)],
        itemTypes: [],
        panels: [wiki, notes],
        reads: 'Filed on wiki or notes',
      },
      {
        // Left out rather than named: there is no live Panel to read its name
        // off, the same reason matching ignores it (`filters.ts`).
        situation: 'a Panel among the values has since been deleted',
        conditions: [panel(wiki.id, 'panel-deleted')],
        itemTypes: [],
        panels: [wiki],
        reads: 'Filed on wiki',
      },
      {
        // Left out rather than named, the same as a deleted one: nothing is
        // ever filed onto a Panel of text, so a value naming one - stored by
        // a release that never enforced this - matches nothing, and the
        // sentence must not claim otherwise.
        situation: 'a value among the values names a live Panel of text',
        conditions: [panel(wiki.id, 'journal')],
        itemTypes: [],
        panels: [wiki, aPanel('journal', 'text')],
        reads: 'Filed on wiki',
      },
    ])('reads $situation', ({ conditions, itemTypes, panels = [], reads }) => {
      expect(saysWhatItShows(conditions, itemTypes, panels)).toBe(reads);
    });

    it.each([
      {
        situation: 'two conditions, either of which will do',
        conditions: [due('week'), priority('high')],
        itemTypes: [] as ItemType[],
        reads: 'Any of: Due this week or overdue; Priority is High',
      },
      {
        // One condition says the same under either, so it carries no prefix.
        situation: 'a single condition',
        conditions: [priority('high')],
        itemTypes: [] as ItemType[],
        reads: 'Priority is High',
      },
      {
        situation: 'a Type among the values has since been deleted',
        conditions: [type(okr.id, 'type-deleted'), priority('high')],
        itemTypes: [okr],
        reads: 'Any of: Type is OKR; Priority is High',
      },
      {
        situation: 'nothing chosen',
        conditions: [] as FilterCondition[],
        itemTypes: [] as ItemType[],
        reads: 'Nothing chosen yet',
      },
    ])('reads any, with $situation', ({ conditions, itemTypes, reads }) => {
      expect(saysWhatItShows(conditions, itemTypes, [], 'any')).toBe(reads);
    });
  });

  describe('deleting a Panel is asked about wherever a live Filter of its Workspace looks at it', () => {
    /** A Filter, gathering by these Panel ids unless a case says otherwise. */
    function aFilterOnPanels(id: string, ...values: string[]): Panel {
      const condition: FilterCondition = { field: 'panel', values };
      return { ...aPanel(id, 'filter'), filter: { conditions: [condition], match: 'all' as const } };
    }
    const notes = aPanel('notes');

    it('names no Filter where none use it', () => {
      expect(filtersUsingPanel('wiki', [FALCON, GATHERS])).toEqual([]);
    });

    it('names the one live Filter that uses it, still holding another live Panel', () => {
      const gathers = aFilterOnPanels('due', 'wiki', 'notes');
      expect(filtersUsingPanel('wiki', [FALCON, notes, gathers])).toEqual([
        { filter: gathers, leftEmpty: false },
      ]);
    });

    it('says the one live Filter that uses it would be left showing nothing', () => {
      const gathers = aFilterOnPanels('due', 'wiki');
      expect(filtersUsingPanel('wiki', [FALCON, gathers])).toEqual([
        { filter: gathers, leftEmpty: true },
      ]);
    });

    it('names two live Filters, only one of which would be left showing nothing', () => {
      const emptied = aFilterOnPanels('due', 'wiki');
      const keptGoing = aFilterOnPanels('over', 'wiki', 'notes');
      expect(filtersUsingPanel('wiki', [FALCON, notes, emptied, keptGoing])).toEqual([
        { filter: emptied, leftEmpty: true },
        { filter: keptGoing, leftEmpty: false },
      ]);
    });

    it('never names a Filter that does not condition on this Panel at all', () => {
      const other = { ...aPanel('over', 'filter'), filter: { conditions: [due('today')], match: 'all' as const } };
      expect(filtersUsingPanel('wiki', [FALCON, other])).toEqual([]);
    });

    it('says a Filter left holding only a live Panel of text would be left showing nothing', () => {
      // A Panel of text still exists, so a naive "is this id still live"
      // check would call the condition still holding one - but nothing is
      // ever filed onto a Panel of text, so this Filter is about to show
      // nothing exactly as if that id were dead too.
      const journal = aPanel('journal', 'text');
      const gathers = aFilterOnPanels('due', 'wiki', 'journal');
      expect(filtersUsingPanel('wiki', [FALCON, journal, gathers])).toEqual([
        { filter: gathers, leftEmpty: true },
      ]);
    });
  });

  describe('a row names every other live Panel its Item shows on, never the one it is drawn on', () => {
    /** What a row for this item, drawn on `drawnPanelId`, would say after its title. */
    function alsoInFor(
      itemId: string,
      items: readonly Item[],
      filings: readonly Filing[],
      panelsInWorkspace: readonly Panel[],
      drawnPanelId: string | null,
      itemTypes: readonly ItemType[] = [],
    ): string[] {
      return alsoShownOn(
        itemId,
        panelAndFilterIdsByItem(items, filings, panelsInWorkspace, itemTypes, TODAY),
        panelsInWorkspace,
        drawnPanelId,
      );
    }

    it('names the other Panel, for an item filed on two', () => {
      const today = aPanel('today');
      const q3 = aPanel('q3-goals');
      const item = anItem('a');

      expect(
        alsoInFor('a', [item], [filed('today', 'a'), filed('q3-goals', 'a')], [today, q3], 'today'),
      ).toEqual(['q3-goals']);
    });

    it('names a Filter the item matches, alongside a Panel it is filed on', () => {
      const today = aPanel('today');
      const dueSoon = { ...aPanel('due-soon', 'filter'), filter: { conditions: [due('today')], match: 'all' as const } };
      const item = anItem('a', { dueDate: TODAY });

      expect(
        alsoInFor('a', [item], [filed('today', 'a')], [today, dueSoon], 'today'),
      ).toEqual(['due-soon']);
    });

    it('drawn on a Filter itself, names the Panels filed on and every other Filter matched, never itself', () => {
      const today = aPanel('today');
      const dueSoon = { ...aPanel('due-soon', 'filter'), filter: { conditions: [due('today')], match: 'all' as const } };
      const highPriority = {
        ...aPanel('high-priority', 'filter'),
        filter: { conditions: [{ field: 'priority' as const, values: ['high'] as Priority[] }], match: 'all' as const },
      };
      const item = anItem('a', { dueDate: TODAY, priority: 'high' });
      const panels = [today, dueSoon, highPriority];

      expect(alsoInFor('a', [item], [filed('today', 'a')], panels, 'due-soon')).toEqual([
        'today',
        'high-priority',
      ]);
    });

    it('never names a Panel since deleted from the Workspace', () => {
      const today = aPanel('today');
      const item = anItem('a');
      // Filed onto "today" and onto "gone", which the Workspace no longer
      // carries at all - not even to say it was deleted.
      const filings = [filed('today', 'a'), filed('gone', 'a')];

      expect(alsoInFor('a', [item], filings, [today], null)).toEqual(['today']);
    });

    it('has nothing to say for an item filed on the one Panel it is drawn on, matching no Filter', () => {
      const today = aPanel('today');
      const item = anItem('a');

      expect(alsoInFor('a', [item], [filed('today', 'a')], [today], 'today')).toEqual([]);
    });

    it('names them in Panel order, not in the order it found them', () => {
      // The Filter is found after the filed Panel (`panelAndFilterIdsByItem`
      // walks filings before Filters), and still reads before it here,
      // because both are read back in `panelsInWorkspace`'s own order.
      const dueSoon = { ...aPanel('due-soon', 'filter'), filter: { conditions: [due('today')], match: 'all' as const } };
      const today = aPanel('today');
      const item = anItem('a', { dueDate: TODAY });
      const panels = [dueSoon, today];

      expect(alsoInFor('a', [item], [filed('today', 'a')], panels, null)).toEqual([
        'due-soon',
        'today',
      ]);
    });
  });
});
