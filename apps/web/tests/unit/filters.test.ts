import { describe, expect, it } from 'vitest';
import type {
  DueCondition,
  Filing,
  FilterCondition,
  FilterRow,
  Item,
  Panel,
  Priority,
} from '@cockpit/shared';
import {
  alsoShownOn,
  filtersUsingDashboard,
  filtersUsingPanel,
  itemsMatchingFilter,
  panelAndFilterIdsByItem,
  saysWhatItShows,
} from '../../src/filters';

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
    proposedPanelFit: null,
    claudeProposals: null,
    seriesId: null,
    sourceResolvedAt: null,
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
    columns: null,
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
    withRun = [],
  }: {
    panels?: readonly Panel[];
    /** The Workspace's live Dashboards; the ones the Panels sit on unless a case says a Dashboard has gone. */
    dashboards?: readonly { id: string }[];
    on?: string;
    match?: FilterMatch;
    /** The ids of the Items with an open run. */
    withRun?: readonly string[];
  } = {},
): string[] {
  return shownByRows(items, filings, rowsOf(conditions, match), { panels, dashboards, on, withRun });
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
    withRun = [],
  }: {
    panels?: readonly Panel[];
    dashboards?: readonly { id: string }[];
    on?: string;
    withRun?: readonly string[];
  } = {},
): string[] {
  return itemsMatchingFilter(items, filings, panels, dashboards, { rows, groupBy: 'none' }, new Set(withRun), on).map(
    (item) => item.id,
  );
}

describe('Panels', () => {
  describe('a Dashboard condition is asked about when its Dashboard is deleted', () => {
    const live = (...ids: string[]) => ids.map((id) => ({ id }));
    const dashboard = (values: string[], exclude?: boolean): FilterCondition =>
      exclude ? { field: 'dashboard', values, exclude } : { field: 'dashboard', values };
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

  describe('an Agent running condition is read back in words', () => {
    const agent: FilterCondition = { field: 'agent' };
    it('is read back as Agent running, alone and beside another condition', () => {
      expect(saysWhatItShows([[agent]])).toBe('Agent running');
      expect(saysWhatItShows([[due('today', false), agent], [{ field: 'status' }]])).toBe(
        '(Due today or Agent running) and Status is In progress',
      );
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
        panelAndFilterIdsByItem(items, filings, panelsInWorkspace, [{ id: 'today' }], new Set(), TODAY),
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
});
