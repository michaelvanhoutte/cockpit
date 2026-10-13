import { describe, expect, it } from 'vitest';
import type {
  DueCondition,
  Filing,
  FilterCondition,
  FilterGrouping,
  FilterRow,
  Item,
  Panel,
  Priority,
} from '@cockpit/shared';
import { filingsThatFile, itemsInTheInbox } from '../../src/filing';
import {
  alsoShownOn,
  dayOf,
  filtersUsingDashboard,
  filtersUsingPanel,
  inFilterOrder,
  itemsMatchingFilter,
  panelAndFilterIdsByItem,
  saysWhatItShows,
  shownOn,
} from '../../src/filters';
import { DEFAULT_FILTER_SORT } from '../../src/sorting';

/** The two shapes the older tests are written in: *all* is a row per condition, *any* one row holding them all. */
type FilterMatch = 'all' | 'any';
function rowsOf(conditions: readonly FilterCondition[], match: FilterMatch): FilterCondition[][] {
  if (conditions.length === 0) return [];
  return match === 'any' ? [[...conditions]] : conditions.map((condition) => [condition]);
}

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
    startedAt?: string | null;
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
    startedAt: holding.startedAt ?? null,
    priority: holding.priority ?? null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: holding.dueDate ?? null,
    dueDateSetAt: null,
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
    neverPropose: false,
    filter: kind === 'filter' ? { rows: [], groupBy: 'none' } : null,
    sort: null,
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
    dashboards = [...new Set(panels.map((panel) => panel.dashboardId))].map((id) => ({ id })),
    on = TODAY,
    match = 'all',
  }: {
    panels?: readonly Panel[];
    /** The Workspace's live Dashboards; the ones the Panels sit on unless a case says a Dashboard has gone. */
    dashboards?: readonly { id: string }[];
    on?: string;
    match?: FilterMatch;
  } = {},
): string[] {
  return shownByRows(items, filings, rowsOf(conditions, match), { panels, dashboards, on });
}

/** A Filter of these conditions, saved as the question's All / Any choice saves it. */
function asFilter(conditions: FilterCondition[], match: FilterMatch = 'all') {
  return { rows: rowsOf(conditions, match), groupBy: 'none' as const };
}

/** What a Filter of these rows draws, out of these items and filings. */
function shownByRows(
  items: readonly Item[],
  filings: readonly Filing[],
  rows: FilterRow[],
  {
    panels = [FALCON, GATHERS],
    dashboards = [...new Set(panels.map((panel) => panel.dashboardId))].map((id) => ({ id })),
    on = TODAY,
  }: {
    panels?: readonly Panel[];
    dashboards?: readonly { id: string }[];
    on?: string;
  } = {},
): string[] {
  return itemsMatchingFilter(items, filings, panels, dashboards, { rows, groupBy: 'none' }, on).map(
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
      // A Priority condition and a Due date condition together: only a High
      // one due this quarter, never a High one due later or a Low one due this
      // quarter.
      const highDueThisQuarter = anItem('high-due', { priority: 'high', dueDate: TODAY });
      const highDueLater = anItem('high-later', { priority: 'high', dueDate: '2027-01-01' });
      const lowDueThisQuarter = anItem('low-due', { priority: 'low', dueDate: TODAY });
      const items = [highDueThisQuarter, highDueLater, lowDueThisQuarter];

      expect(
        shown(
          items,
          items.map((item) => filed('falcon', item.id)),
          [{ field: 'priority', values: ['high'] }, due('quarter', false)],
        ),
      ).toEqual([highDueThisQuarter.id]);
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

  describe('a Dashboard condition follows the Panels of its Dashboards as they come and go', () => {
    const onBoard = (id: string, dashboardId: string): Panel => ({ ...aPanel(id), dashboardId });
    const dayToDay = onBoard('errands', 'day');
    const dayToDayLater = onBoard('added-later', 'day');
    const work = onBoard('projects', 'work');
    const volleyball = onBoard('matches', 'volleyball');
    const volleyballToo = onBoard('training', 'volleyball');
    const everything = [GATHERS, dayToDay, dayToDayLater, work, volleyball, volleyballToo];
    const live = (...ids: string[]) => ids.map((id) => ({ id }));
    const priority = (value: Priority): FilterCondition => ({ field: 'priority', values: [value] });
    const dashboard = (values: string[], exclude?: boolean): FilterCondition =>
      exclude ? { field: 'dashboard', values, exclude } : { field: 'dashboard', values };

    it.each([
      { situation: 'is Day to day; filed on a Panel of it', condition: dashboard(['day']), on: ['errands'], drawn: true },
      { situation: 'is Day to day; filed only on Volleyball club', condition: dashboard(['day']), on: ['matches'], drawn: false },
      { situation: 'is Day to day, Work; filed on a Panel of Work', condition: dashboard(['day', 'work']), on: ['projects'], drawn: true },
      {
        situation: 'is Day to day; filed on a Panel added to it after the Filter was saved',
        condition: dashboard(['day']),
        on: ['added-later'],
        drawn: true,
      },
      {
        situation: 'is not Volleyball club; filed on Day to day and on Volleyball club',
        condition: dashboard(['volleyball'], true),
        on: ['errands', 'matches'],
        drawn: true,
      },
      {
        situation: 'is not Volleyball club; filed only on Volleyball club, across two of its Panels',
        condition: dashboard(['volleyball'], true),
        on: ['matches', 'training'],
        drawn: false,
      },
      {
        situation: 'is not Volleyball club, Work; filed on one Panel of each',
        condition: dashboard(['volleyball', 'work'], true),
        on: ['matches', 'projects'],
        drawn: false,
      },
    ])('an item where the condition $situation', ({ condition, on, drawn }) => {
      const item = anItem('a');
      expect(
        shown([item], on.map((panelId) => filed(panelId, item.id)), [condition], {
          panels: everything,
          dashboards: live('day', 'work', 'volleyball'),
        }),
      ).toEqual(drawn ? [item.id] : []);
    });

    it.each([
      {
        situation: 'is Day to day and a deleted Dashboard, for an item on Day to day',
        condition: dashboard(['day', 'gone']),
        match: 'all' as const,
        drawn: ['on-day'],
      },
      { situation: 'is only deleted Dashboards, under all', condition: dashboard(['gone']), match: 'all' as const, drawn: [] },
      {
        situation: 'is only deleted Dashboards, beside a condition under any, adds none',
        condition: dashboard(['gone']),
        match: 'any' as const,
        drawn: [],
      },
      { situation: 'is not with only deleted Dashboards, under all', condition: dashboard(['gone'], true), match: 'all' as const, drawn: ['on-day', 'on-work'] },
      { situation: 'is not with nothing chosen, under all', condition: dashboard([], true), match: 'all' as const, drawn: ['on-day', 'on-work'] },
      { situation: 'is not with only deleted Dashboards, under any, adds none', condition: dashboard(['gone'], true), match: 'any' as const, drawn: [] },
    ])('a condition that $situation draws $drawn', ({ condition, match, drawn }) => {
      const items = [anItem('on-day'), anItem('on-work')];
      const filings = [filed('errands', 'on-day'), filed('projects', 'on-work')];
      // Under *any* the condition stands beside one nothing meets, so only it
      // can add anything.
      const conditions = match === 'any' ? [condition, priority('high')] : [condition];
      expect(
        shown(items, filings, conditions, {
          panels: everything,
          dashboards: live('day', 'work'),
          match,
        }),
      ).toEqual(drawn);
    });

    it.each([
      {
        situation: 'Dashboard is Day to day and Panel is not Errands, an item on Errands of Day to day',
        conditions: [dashboard(['day']), { field: 'panel', values: ['errands'], exclude: true }] as FilterCondition[],
        match: 'all' as const,
        item: anItem('a'),
        drawn: false,
      },
      {
        situation: 'Dashboard is Work or Priority is High, a High item on Day to day',
        conditions: [dashboard(['work']), priority('high')],
        match: 'any' as const,
        item: anItem('a', { priority: 'high' }),
        drawn: true,
      },
    ])('joins the other conditions by all or any: $situation', ({ conditions, match, item, drawn }) => {
      expect(
        shown([item], [filed('errands', item.id)], conditions, { panels: everything, match }),
      ).toEqual(drawn ? [item.id] : []);
    });

    describe('deleting a Dashboard is asked about wherever a live Filter looks at it', () => {
      const aFilterOn = (id: string, condition: FilterCondition, ...others: FilterCondition[]): Panel => ({
        ...aPanel(id, 'filter'),
        filter: asFilter([condition, ...others]),
      });

      it.each([
        { situation: 'no Filter names it', filters: [] as Panel[], named: [] as { leftEmpty: boolean }[] },
        {
          situation: 'an is card names it and another live Dashboard',
          filters: [aFilterOn('due', dashboard(['volleyball', 'work']))],
          named: [{ leftEmpty: false }],
        },
        {
          situation: 'an is card whose last live value it is',
          filters: [aFilterOn('due', dashboard(['volleyball']))],
          named: [{ leftEmpty: true }],
        },
        {
          situation: 'an is not card whose last live value it is, which then filters nothing',
          filters: [aFilterOn('due', dashboard(['volleyball'], true))],
          named: [{ leftEmpty: false }],
        },
        {
          situation: 'an is card whose other value is already deleted',
          filters: [aFilterOn('due', dashboard(['volleyball', 'gone']))],
          named: [{ leftEmpty: true }],
        },
      ])('$situation', ({ filters, named }) => {
        const found = filtersUsingDashboard('volleyball', [FALCON, ...filters], live('volleyball', 'work'));
        expect(found.map((one) => ({ leftEmpty: one.leftEmpty }))).toEqual(named);
        expect(found.map((one) => one.filter)).toEqual(filters);
      });

      it('never names a Filter whose conditions are about something else', () => {
        const other = aFilterOn('over', due('today'));
        expect(filtersUsingDashboard('volleyball', [FALCON, other], live('volleyball'))).toEqual([]);
      });

      it('never names a Filter on the Dashboard being deleted, which goes with it', () => {
        const onIt = { ...aFilterOn('own', dashboard(['volleyball'])), dashboardId: 'volleyball' };
        expect(filtersUsingDashboard('volleyball', [FALCON, onIt], live('volleyball', 'work'))).toEqual([]);
      });
    });
  });

  /**
   * "Mark an item In progress, and see since when" (issue 568). Both cases
   * are still-open items - a Filter never sees a Done one at all
   * (`itemsThatAreFiled`, `filing.ts`) - so this is the whole of what a Status
   * condition has to tell apart.
   */
  describe('a Status condition matches an item In progress, and no other', () => {
    it.each([
      { situation: 'started, In progress', startedAt: '2026-09-04T10:00:00.000Z', drawn: true },
      { situation: 'not started, To do', startedAt: null, drawn: false },
    ])('an item that is $situation', ({ startedAt, drawn }) => {
      const item = anItem('a', { startedAt });
      expect(
        shown([item], [filed('falcon', item.id)], [{ field: 'status' }]),
      ).toEqual(drawn ? [item.id] : []);
    });
  });

  describe('a Status condition matches the statuses it holds, and one stored without any reads as In progress', () => {
    const todo = anItem('todo');
    const doing = anItem('doing', { startedAt: '2026-09-04T10:00:00.000Z' });
    const filings = [filed('falcon', 'todo'), filed('falcon', 'doing')];

    it.each([
      { situation: 'Status is To do', condition: { field: 'status', values: ['to_do'] }, drawn: ['todo'] },
      {
        situation: 'Status is To do and In progress',
        condition: { field: 'status', values: ['to_do', 'in_progress'] },
        drawn: ['todo', 'doing'],
      },
      {
        situation: 'Status is not In progress',
        condition: { field: 'status', values: ['in_progress'], exclude: true },
        drawn: ['todo'],
      },
      { situation: 'a Status stored with no values, from before', condition: { field: 'status' }, drawn: ['doing'] },
    ] as { situation: string; condition: FilterCondition; drawn: string[] }[])('$situation draws $drawn', ({ condition, drawn }) => {
      expect(shown([todo, doing], filings, [condition]).sort()).toEqual([...drawn].sort());
    });
  });

  describe('an is not condition matches an item holding none of its live values', () => {
    const archive = aPanel('archive');
    const q3 = aPanel('q3');
    const panels = [FALCON, GATHERS, archive, q3];

    it.each([
      {
        situation: 'Priority is not High: Normal, High, no Priority',
        condition: { field: 'priority', values: ['high'], exclude: true },
        items: [anItem('normal', { priority: 'normal' }), anItem('high', { priority: 'high' }), anItem('none')],
        drawn: ['normal', 'none'],
      },
    ] as { situation: string; condition: FilterCondition; items: Item[]; drawn: string[] }[])(
      '$situation',
      ({ condition, items, drawn }) => {
        const filings = items.map((item) => filed('falcon', item.id));
        expect(shown(items, filings, [condition]).sort()).toEqual([...drawn].sort());
      },
    );

    it('fails an item filed on any excluded Panel, however many others it is on', () => {
      const onQ3 = anItem('q3-only');
      const onBoth = anItem('both');
      const excluded: FilterCondition = { field: 'panel', values: [archive.id], exclude: true };
      expect(
        shown([onQ3, onBoth], [filed('q3', 'q3-only'), filed('archive', 'both'), filed('q3', 'both')], [excluded], {
          panels,
        }),
      ).toEqual(['q3-only']);
    });
  });

  describe('an is not condition with nothing left to exclude filters nothing', () => {
    const thisWeek = anItem('this-week', { dueDate: '2026-09-18' });
    const later = anItem('later', { dueDate: '2026-12-01' });
    const items = [thisWeek, later];
    const filings = [filed('falcon', 'this-week'), filed('falcon', 'later')];
    const nothingChosen: FilterCondition = { field: 'panel', values: [], exclude: true };
    const onlyDeleted: FilterCondition = { field: 'panel', values: ['gone'], exclude: true };

    it.each([
      { situation: 'all: Due this week, plus Panel is not nothing', condition: nothingChosen, match: 'all', drawn: ['this-week'] },
      { situation: 'any: Due this week, plus Panel is not nothing', condition: nothingChosen, match: 'any', drawn: ['this-week'] },
      { situation: 'any: Due this week, plus Panel is not a deleted Panel', condition: onlyDeleted, match: 'any', drawn: ['this-week'] },
      { situation: 'all: Due this week, plus Panel is not a deleted Panel', condition: onlyDeleted, match: 'all', drawn: ['this-week'] },
    ] as { situation: string; condition: FilterCondition; match: FilterMatch; drawn: string[] }[])(
      '$situation draws what Due this week draws alone',
      ({ condition, match, drawn }) => {
        expect(shown(items, filings, [due('week'), condition], { match })).toEqual(drawn);
      },
    );

    it('lets every item through where every condition filters nothing, under all or any', () => {
      // A row of nothing but such conditions filters nothing, as a row of one
      // of them does ("Join a Filter's rows with and, and a row's alternatives
      // with or", issue 1075).
      expect(shown(items, filings, [onlyDeleted], { match: 'all' }).sort()).toEqual(['later', 'this-week']);
      expect(shown(items, filings, [onlyDeleted, nothingChosen], { match: 'any' }).sort()).toEqual(['later', 'this-week']);
    });
  });

  describe('a Filter shows an item that meets every row, and meets a row when it meets any condition in it', () => {
    const a = aPanel('a');
    const b = aPanel('b');
    const c = aPanel('c');
    const panels = [a, b, c, GATHERS];
    const dueWeek = due('week');
    const high: FilterCondition = { field: 'priority', values: ['high'] };
    const notOnAOrB: FilterCondition = { field: 'panel', values: ['a', 'b'], exclude: true };
    const priorityNothing: FilterCondition = { field: 'priority', values: [] };
    const panelNotNothing: FilterCondition = { field: 'panel', values: [], exclude: true };
    const mixed = [[dueWeek, high], [notOnAOrB]];

    it.each([
      { situation: '(due this week or overdue, or High) and not on A or B: due today, on C', rows: mixed, item: { dueDate: TODAY }, on: 'c', drawn: true },
      { situation: '(due this week or overdue, or High) and not on A or B: High, on A', rows: mixed, item: { priority: 'high' }, on: 'a', drawn: false },
      { situation: '(due this week or overdue, or High) and not on A or B: Normal, not due, on C', rows: mixed, item: { priority: 'normal' }, on: 'c', drawn: false },
      { situation: 'one row of Due and Priority: meets Priority only', rows: [[dueWeek, high]], item: { priority: 'high' }, on: 'c', drawn: true },
      { situation: 'two rows, Due then Priority: meets Priority only', rows: [[dueWeek], [high]], item: { priority: 'high' }, on: 'c', drawn: false },
      { situation: 'a row of Priority is nothing beside Due: meets Due', rows: [[priorityNothing, dueWeek]], item: { dueDate: TODAY }, on: 'c', drawn: true },
      { situation: 'a row alone of Priority is nothing: any item', rows: [[priorityNothing]], item: { dueDate: TODAY, priority: 'high' }, on: 'c', drawn: false },
      { situation: 'a row alone of Panel is not nothing: any item', rows: [[panelNotNothing]], item: { priority: 'normal' }, on: 'c', drawn: true },
      { situation: 'a row of Panel is not nothing beside Due: meets neither', rows: [[panelNotNothing, dueWeek]], item: { priority: 'normal' }, on: 'c', drawn: false },
      { situation: 'no rows: any item', rows: [], item: { dueDate: TODAY, priority: 'high' }, on: 'c', drawn: false },
    ] as { situation: string; rows: FilterRow[]; item: { dueDate?: string; priority?: Priority }; on: string; drawn: boolean }[])(
      '$situation',
      ({ rows, item, on, drawn }) => {
        expect(shownByRows([anItem('x', item)], [filed(on, 'x')], rows, { panels })).toEqual(drawn ? ['x'] : []);
      },
    );
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
      expect(inFilterOrder(items, DEFAULT_FILTER_SORT).map((item) => item.id)).toEqual([
        'soonest-high-older',
        'soonest-high',
        'soonest-low',
        'soonest-none',
        'later',
        'undated-but-oldest',
      ]);
    });

    it('goes oldest first wherever a chosen sort leaves two tied', () => {
      const tied = [
        anItem('newer', { priority: 'high', createdAt: '2026-09-02T08:00:00.000Z' }),
        anItem('older', { priority: 'high', createdAt: '2026-09-01T08:00:00.000Z' }),
      ];
      expect(
        inFilterOrder(tied, [{ field: 'priority', direction: 'desc' }]).map((item) => item.id),
      ).toEqual(['older', 'newer']);
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
    const wiki = aPanel('wiki', 'items');
    const notes = aPanel('notes', 'items');

    const priority = (...values: Priority[]): FilterCondition => ({ field: 'priority', values });
    const panel = (...values: string[]): FilterCondition => ({ field: 'panel', values });
    const status = (...values: ('to_do' | 'in_progress')[]): FilterCondition =>
      values.length === 0 ? { field: 'status' } : { field: 'status', values };

    it.each([
      { situation: 'nothing chosen', conditions: [] as FilterCondition[], reads: 'Nothing chosen yet' },
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
        situation: 'priority is one level',
        conditions: [priority('high')],
        reads: 'Priority is High',
      },
      {
        situation: 'priority is several levels',
        conditions: [priority('high', 'normal')],
        reads: 'Priority is High or Normal',
      },
      {
        // *And*, because that is what two conditions mean - a comma would read
        // as a list of alternatives, which is the one thing a Filter cannot be
        // asked for.
        situation: 'two conditions, both of which hold',
        conditions: [due('week', false), due('none')],
        reads: 'Due this week and No due date',
      },
      {
        situation: 'panel is one Panel',
        conditions: [panel(wiki.id)],
        panels: [wiki, notes],
        reads: 'Filed on wiki',
      },
      {
        situation: 'panel is several Panels',
        conditions: [panel(wiki.id, notes.id)],
        panels: [wiki, notes],
        reads: 'Filed on wiki or notes',
      },
      {
        // Left out rather than named: there is no live Panel to read its name
        // off, the same reason matching ignores it (`filters.ts`).
        situation: 'a Panel among the values has since been deleted',
        conditions: [panel(wiki.id, 'panel-deleted')],
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
        panels: [wiki, aPanel('journal', 'text')],
        reads: 'Filed on wiki',
      },
      {
        situation: 'a status stored before Status took values',
        conditions: [status()],
        reads: 'Status is In progress',
      },
      { situation: 'status is To do', conditions: [status('to_do')], reads: 'Status is To do' },
      {
        situation: 'status is not In progress',
        conditions: [{ ...status('in_progress'), exclude: true } as FilterCondition],
        reads: 'Status is not In progress',
      },
      {
        situation: 'priority is not one level',
        conditions: [{ ...priority('low'), exclude: true } as FilterCondition],
        reads: 'Priority is not Low',
      },
      {
        situation: 'a Panel the item is not filed on',
        conditions: [{ ...panel(wiki.id), exclude: true } as FilterCondition],
        panels: [wiki],
        reads: 'Not filed on wiki',
      },
    ])('reads $situation', ({ conditions, panels = [], reads }) => {
      expect(saysWhatItShows(rowsOf(conditions, 'all'), panels)).toBe(reads);
    });

    it.each([
      {
        // An *is not* with nothing to exclude says nothing about what is
        // shown, so the sentence does not claim a narrowing.
        situation: 'a Due condition beside a Panel is not with nothing chosen, under any',
        conditions: [due('week'), { field: 'panel', values: [], exclude: true } as FilterCondition],
        reads: 'Due this week or overdue',
      },
      {
        situation: 'a Panel is not whose only Panel has since been deleted, beside a Due condition',
        conditions: [due('week'), { field: 'panel', values: ['panel-deleted'], exclude: true } as FilterCondition],
        reads: 'Due this week or overdue',
      },
      {
        situation: 'two conditions, either of which will do',
        conditions: [due('week'), priority('high')],
        reads: 'Any of: Due this week or overdue; Priority is High',
      },
      {
        // One condition says the same under either, so it carries no prefix.
        situation: 'a single condition',
        conditions: [priority('high')],
        reads: 'Priority is High',
      },
      {
        situation: 'nothing chosen',
        conditions: [] as FilterCondition[],
        reads: 'Nothing chosen yet',
      },
    ])('reads any, with $situation', ({ conditions, reads }) => {
      expect(saysWhatItShows(rowsOf(conditions, 'any'), [])).toBe(reads);
    });

    it.each([
      { situation: 'by Panel', groupBy: 'panel' as const, conditions: [due('week')], match: 'all' as const, reads: 'Due this week or overdue; grouped by Panel' },
      { situation: 'by Dashboard', groupBy: 'dashboard' as const, conditions: [due('week')], match: 'all' as const, reads: 'Due this week or overdue; grouped by Dashboard' },
      { situation: 'by nothing, which adds nothing', groupBy: 'none' as const, conditions: [due('week')], match: 'all' as const, reads: 'Due this week or overdue' },
      { situation: 'by Panel, set to any', groupBy: 'panel' as const, conditions: [due('week'), priority('high')], match: 'any' as const, reads: 'Any of: Due this week or overdue; Priority is High; grouped by Panel' },
    ])('ends with the grouping where there is one, grouped $situation', ({ conditions, match, groupBy, reads }) => {
      expect(saysWhatItShows(rowsOf(conditions, match), [], groupBy)).toBe(reads);
    });

    it.each([
      { situation: 'each in a row of its own', rows: (one: FilterCondition) => [[one], [one]] },
      { situation: 'together in one row', rows: (one: FilterCondition) => [[one, { ...one, field: 'dashboard' } as FilterCondition]] },
    ])('keeps the grouping when every condition is an is not that filters nothing, $situation', ({ rows }) => {
      // Rows of nothing but conditions that filter nothing let everything
      // through, which is what matching does with them too.
      const nothingToExclude: FilterCondition = { field: 'panel', values: [], exclude: true };
      expect(saysWhatItShows(rows(nothingToExclude), [], 'panel')).toBe('Everything filed; grouped by Panel');
    });

    it.each([
      {
        situation: 'a row of alternatives beside another row is bracketed',
        rows: [[due('week'), priority('high')], [{ field: 'priority', values: ['low'], exclude: true } as FilterCondition]],
        reads: '(Due this week or overdue or Priority is High) and Priority is not Low',
      },
      {
        situation: 'a row whose alternatives all filter nothing is left out',
        rows: [[due('week')], [{ field: 'panel', values: [], exclude: true } as FilterCondition]],
        reads: 'Due this week or overdue',
      },
    ])('reads rows joined by and: $situation', ({ rows, reads }) => {
      expect(saysWhatItShows(rows, [])).toBe(reads);
    });

    it.each([
      { situation: 'is Day to day, Work', condition: { field: 'dashboard', values: ['day', 'work'] }, reads: 'On Day to day or Work' },
      {
        situation: 'is not Volleyball club',
        condition: { field: 'dashboard', values: ['volleyball'], exclude: true },
        reads: 'Not on Volleyball club',
      },
      {
        situation: 'is not, naming only a Dashboard since deleted, which filters nothing',
        condition: { field: 'dashboard', values: ['gone'], exclude: true },
        reads: 'Everything filed',
      },
    ] as { situation: string; condition: FilterCondition; reads: string }[])(
      'reads a Dashboard condition that $situation',
      ({ condition, reads }) => {
        const dashboards = [
          { id: 'day', name: 'Day to day' },
          { id: 'work', name: 'Work' },
          { id: 'volleyball', name: 'Volleyball club' },
        ];
        expect(saysWhatItShows([[condition]], [], 'none', dashboards)).toBe(reads);
      },
    );

    it('adds nothing for a grouping it does not know, rather than naming one', () => {
      const unknown = 'type' as unknown as FilterGrouping;
      expect(saysWhatItShows([[due('week')]], [], unknown)).toBe('Due this week or overdue');
    });
  });

  describe('deleting a Panel is asked about wherever a live Filter of its Workspace looks at it', () => {
    /** A Filter, gathering by these Panel ids unless a case says otherwise. */
    function aFilterOnPanels(id: string, ...values: string[]): Panel {
      const condition: FilterCondition = { field: 'panel', values };
      return { ...aPanel(id, 'filter'), filter: asFilter([condition]) };
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

    it('names a Filter that excludes the Panel but never says it would be left showing nothing', () => {
      const excluding: Panel = {
        ...aPanel('rest', 'filter'),
        filter: asFilter([{ field: 'panel', values: ['wiki'], exclude: true }]),
      };
      expect(filtersUsingPanel('wiki', [FALCON, excluding])).toEqual([{ filter: excluding, leftEmpty: false }]);
    });

    it('names two live Filters, only one of which would be left showing nothing', () => {
      const emptied = aFilterOnPanels('due', 'wiki');
      const keptGoing = aFilterOnPanels('over', 'wiki', 'notes');
      expect(filtersUsingPanel('wiki', [FALCON, notes, emptied, keptGoing])).toEqual([
        { filter: emptied, leftEmpty: true },
        { filter: keptGoing, leftEmpty: false },
      ]);
    });

    it.each([
      {
        situation: 'set to any beside another condition, still shows what that one matches',
        others: [due('today')],
        match: 'any' as const,
        leftEmpty: false,
      },
      {
        situation: 'set to any with no other condition, is left showing nothing',
        others: [] as FilterCondition[],
        match: 'any' as const,
        leftEmpty: true,
      },
      {
        situation: 'set to all beside another condition, is left showing nothing',
        others: [due('today')],
        match: 'all' as const,
        leftEmpty: true,
      },
    ])('names a Filter that, losing its only live Panel and $situation', ({ others, match, leftEmpty }) => {
      const gathers = {
        ...aPanel('due', 'filter'),
        filter: asFilter([{ field: 'panel' as const, values: ['wiki'] }, ...others], match),
      };
      expect(filtersUsingPanel('wiki', [FALCON, gathers])).toEqual([{ filter: gathers, leftEmpty }]);
    });

    it('never names a Filter that does not condition on this Panel at all', () => {
      const other = { ...aPanel('over', 'filter'), filter: asFilter([due('today')]) };
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
    ): string[] {
      return alsoShownOn(
        itemId,
        panelAndFilterIdsByItem(items, filings, panelsInWorkspace, [{ id: 'today' }], TODAY),
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
      const dueSoon = { ...aPanel('due-soon', 'filter'), filter: asFilter([due('today')]) };
      const item = anItem('a', { dueDate: TODAY });

      expect(
        alsoInFor('a', [item], [filed('today', 'a')], [today, dueSoon], 'today'),
      ).toEqual(['due-soon']);
    });

    it('drawn on a Filter itself, names the Panels filed on and every other Filter matched, never itself', () => {
      const today = aPanel('today');
      const dueSoon = { ...aPanel('due-soon', 'filter'), filter: asFilter([due('today')]) };
      const highPriority = {
        ...aPanel('high-priority', 'filter'),
        filter: asFilter([{ field: 'priority' as const, values: ['high'] as Priority[] }]),
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
      const dueSoon = { ...aPanel('due-soon', 'filter'), filter: asFilter([due('today')]) };
      const today = aPanel('today');
      const item = anItem('a', { dueDate: TODAY });
      const panels = [dueSoon, today];

      expect(alsoInFor('a', [item], [filed('today', 'a')], panels, null)).toEqual([
        'due-soon',
        'today',
      ]);
    });
  });

  describe('the form lists where an item is shown, as dashboard and panel, or the inbox where it is filed nowhere', () => {
    const dashboards = [{ id: 'today', name: 'Today' }];
    const where = (item: Item, others: Item[], filings: Filing[], panels: Panel[]) =>
      shownOn(item, [item, ...others], filings, panels, dashboards, TODAY);
    const dueSoon = {
      ...aPanel('due-soon', 'filter'),
      name: 'Due soon',
      filter: asFilter([due('today')]),
    };

    it('names the one panel an item is filed on', () => {
      const item = anItem('a');

      expect(where(item, [], [filed('falcon', 'a')], [{ ...FALCON, name: 'Falcon' }])).toEqual([
        'Today › Falcon',
      ]);
    });

    it('names every panel and every filter, in panel order', () => {
      const q3 = { ...aPanel('q3'), name: 'Q3 goals' };
      const item = anItem('a', { dueDate: TODAY });

      expect(
        where(item, [], [filed('q3', 'a'), filed('falcon', 'a')], [
          dueSoon,
          { ...FALCON, name: 'Falcon' },
          q3,
        ]),
      ).toEqual(['Today › Due soon', 'Today › Falcon', 'Today › Q3 goals']);
    });

    it('says the inbox where it is filed nowhere', () => {
      expect(where(anItem('a'), [], [], [FALCON])).toEqual(['Inbox']);
    });

    it('says nothing is shown for a finished item, wherever it was filed', () => {
      const item = anItem('a', { completedAt: '2026-09-01T08:00:00.000Z' });

      expect(where(item, [], [filed('falcon', 'a')], [FALCON])).toBeNull();
    });
  });
});
