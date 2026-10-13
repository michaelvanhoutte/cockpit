import { describe, expect, it } from 'vitest';
import {
  NO_CONDITIONS,
  panelFilterAsStored,
  panelFilterFrom,
  panelGathers,
  panelSortAsStored,
  panelSortFrom,
  panelHoldsText,
  panelPlace,
  panelSchema,
  panelTakesItems,
  rowInputSchema,
  statusValuesOf,
  type FilterCondition,
} from '../../../src/domain/panel.js';

/**
 * L1: what a stored filter says, and which panels take a filing, are decisions
 * over a value. That a Filter really reads back as one from a real store is
 * apps/api/tests/integration/http/panels.test.ts, and what it then gathers is
 * apps/web/tests/unit/filters.test.ts.
 */

const DUE_TODAY: FilterCondition = { field: 'dueDate', window: 'today', orOverdue: true };
const PRIORITY_HIGH: FilterCondition = { field: 'priority', values: ['high'] };
const PANEL_Q3: FilterCondition = { field: 'panel', values: ['panel-q3'] };

describe('Layouts', () => {
  /**
   * A Section's title, as a saved arrangement carries it ("Add, rename and
   * delete a titled Section on a Dashboard", issue 896). That a refusal reaches
   * the person through the real route is
   * apps/api/tests/integration/http/panels.test.ts.
   */
  describe('a Section’s title is required, trimmed, one line, at most 60 characters, and need not be unique', () => {
    const section = (title: string) => rowInputSchema.safeParse({ height: null, title, cells: [] });

    it.each([
      { situation: 'a blank title', title: '', kept: null },
      { situation: 'a title of spaces only', title: '   ', kept: null },
      { situation: 'a title with spaces around it', title: '  This week  ', kept: 'This week' },
      { situation: 'a title of 60 characters', title: 'x'.repeat(60), kept: 'x'.repeat(60) },
      { situation: 'a title of 61 characters', title: 'x'.repeat(61), kept: null },
      { situation: 'a title with a line break', title: 'This\nweek', kept: null },
    ])('$situation', ({ title, kept }) => {
      const parsed = section(title);
      expect(parsed.success ? parsed.data.title : null).toBe(kept);
    });

    it('takes the same title twice in one arrangement, and the title a Panel has', () => {
      // Nothing about a Section's title is compared with anything else's: the
      // schema reads one row at a time, and the store asks no question of it.
      const rows = [
        { height: null, title: 'Falcon', cells: [] },
        { height: null, title: 'Falcon', cells: [] },
      ];
      expect(rows.map((row) => rowInputSchema.safeParse(row).success)).toEqual([true, true]);
    });

    it.each([
      { situation: 'a Section holding a Panel', row: { height: null, title: 'Now', cells: [{ panelId: 'p', span: 12 }] } },
      { situation: 'a Section given a height', row: { height: 300, title: 'Now', cells: [] } },
      { situation: 'a row with neither a title nor a Panel', row: { height: null, cells: [] } },
    ])('refuses $situation', ({ row }) => {
      expect(rowInputSchema.safeParse(row).success).toBe(false);
    });
  });
});

describe('Panels', () => {
  describe('a panel kept from before Never propose existed reads as proposed like any other', () => {
    it('reads a panel with no such setting as unflagged', () => {
      const kept = { id: 'p1', tenantId: 't', dashboardId: 'd1', name: 'Next up', kind: 'items' };

      expect(panelSchema.parse(kept).neverPropose).toBe(false);
    });
  });

  describe('a suggested panel is always named "Dashboard ▸ Panel"', () => {
    it.each([
      { situation: 'a panel on a live dashboard', dashboard: 'Day to day', panel: 'Admin & money', reads: 'Day to day ▸ Admin & money' },
      { situation: 'the same name on one dashboard', dashboard: 'Day to day', panel: 'Inbox', reads: 'Day to day ▸ Inbox' },
      { situation: 'the same name on another dashboard', dashboard: 'Work', panel: 'Inbox', reads: 'Work ▸ Inbox' },
      { situation: 'a workspace with one dashboard', dashboard: 'Only', panel: 'Admin & money', reads: 'Only ▸ Admin & money' },
    ])('$situation', ({ dashboard, panel, reads }) => {
      expect(panelPlace(dashboard, panel)).toBe(reads);
    });
  });

  describe('a panel that gathers what it shows says so however its rows were stored', () => {
    it('reads back exactly what was written', () => {
      expect(panelFilterFrom(panelFilterAsStored([[DUE_TODAY, PRIORITY_HIGH], [PANEL_Q3]]))).toEqual({
        rows: [[DUE_TODAY, PRIORITY_HIGH], [PANEL_Q3]],
        groupBy: 'none',
      });
    });

    it('reads back a Priority and a Panel condition beside a Due date one', () => {
      // The fields together, each carrying its own value shape - a
      // discriminated union rather than a reshaping of every stored Filter
      // ("Filter a Filter panel by priority and type", issue 464; "Filter a
      // Filter panel by panel, and name the Filters a panel's deletion
      // affects", issue 465).
      expect(
        panelFilterFrom(panelFilterAsStored([[DUE_TODAY], [PRIORITY_HIGH], [PANEL_Q3]])),
      ).toEqual({ rows: [[DUE_TODAY], [PRIORITY_HIGH], [PANEL_Q3]], groupBy: 'none' });
    });

    it('reads a condition written without exclusion or Status values as including, with Status as In progress', () => {
      // Both additions are optional on the stored shape, so a condition carried
      // into rows from an earlier release is read as what it meant then
      // ("Include or exclude a Filter panel condition's values...", issue 908).
      const read = panelFilterFrom('{"rows":[[{"field":"priority","values":["high"]},{"field":"status"}]]}');

      expect(read?.rows[0]?.[0]).toEqual({ field: 'priority', values: ['high'] });
      expect(read?.rows[0]?.[0]).not.toHaveProperty('exclude');
      expect(read?.rows[0]?.[1]).toEqual({ field: 'status' });
      expect(statusValuesOf({ field: 'status' })).toEqual(['in_progress']);
    });

    it('reads back an exclusion and Status values exactly as written', () => {
      const held: FilterCondition[] = [
        { field: 'priority', values: ['low'], exclude: true },
        { field: 'panel', values: ['panel-q3'], exclude: true },
        { field: 'dashboard', values: ['dashboard-volleyball'], exclude: true },
        { field: 'status', values: ['to_do', 'in_progress'], exclude: true },
      ];
      expect(panelFilterFrom(panelFilterAsStored([held]))?.rows).toEqual([held]);
    });

    it('is not a filter at all where nothing was stored', () => {
      expect(panelFilterFrom(null)).toBeNull();
    });

    it('reads the same field in two rows as two conditions', () => {
      const notLow: FilterCondition = { field: 'priority', values: ['low'], exclude: true };
      expect(panelFilterFrom(panelFilterAsStored([[PRIORITY_HIGH, DUE_TODAY], [notLow]]))?.rows).toEqual([
        [PRIORITY_HIGH, DUE_TODAY],
        [notLow],
      ]);
    });

    it('drops a field repeated within a row, keeping the first, and drops an empty row', () => {
      // A Filter saved with a field twice before "a field appears once" was
      // refused ("Filter a Filter panel by priority and type", issue 464) is
      // carried into rows as it was: read back deduplicated, a later save of
      // the same Panel is not refused for a duplicate nobody just chose.
      const week = { field: 'dueDate', window: 'week', orOverdue: false } as const;
      expect(panelFilterFrom(panelFilterAsStored([[DUE_TODAY, PRIORITY_HIGH, week], [], [PANEL_Q3]]))).toEqual({
        rows: [[DUE_TODAY, PRIORITY_HIGH], [PANEL_Q3]],
        groupBy: 'none',
      });
    });

    it.each([
      { situation: 'text that is not what was stored at all', stored: '{oops' },
      { situation: 'a shape from some other release', stored: '{"rules":[]}' },
      { situation: 'the flat conditions an older release writes', stored: '{"conditions":[{"field":"dueDate","window":"week"}],"match":"all"}' },
      { situation: 'a window this release has never heard of', stored: '{"rows":[[{"field":"dueDate","window":"fortnight"}]]}' },
      { situation: 'a priority level this release has never heard of', stored: '{"rows":[[{"field":"priority","values":["urgent"]}]]}' },
      { situation: 'a field this release has never heard of', stored: '{"rows":[[{"field":"assignee","values":[]}]]}' },
      { situation: 'a Status value of Done', stored: '{"rows":[[{"field":"status","values":["done"]}]]}' },
      { situation: 'a row of something that is not a condition', stored: '{"rows":[["today"]]}' },
      { situation: 'rows that are not lists', stored: '{"rows":[{"field":"status"}]}' },
      { situation: 'nothing but a number', stored: '7' },
    ])('shows nothing chosen where it holds $situation', ({ stored }) => {
      // Never a failure: a workspace that will not open because one panel holds
      // a shape this release cannot read is far worse than a panel saying it has
      // nothing chosen, which is a state the product already explains.
      expect(panelFilterFrom(stored)).toEqual(NO_CONDITIONS);
    });

    it('takes what was left out as the answer it defaults to', () => {
      // *Or overdue* is ticked unless somebody unticked it, so a condition
      // stored before the tick existed widens rather than narrows.
      expect(panelFilterFrom('{"rows":[[{"field":"dueDate","window":"week"}]]}')).toEqual({
        rows: [[{ field: 'dueDate', window: 'week', orOverdue: true }]],
        groupBy: 'none',
      });
    });
  });

  describe('a stored Filter keeps every condition but a Type one', () => {
    const TYPE = { field: 'type', values: ['type-okr'] };
    const stored = (rows: unknown[][]) => JSON.stringify({ rows });

    it.each([
      {
        situation: 'Type in a row of its own beside Priority',
        stored: stored([[TYPE], [PRIORITY_HIGH]]),
        reads: [[PRIORITY_HIGH]],
      },
      { situation: 'Type alone, which is nothing chosen', stored: stored([[TYPE]]), reads: [] },
      {
        situation: 'Type is not beside a Due date in one row',
        stored: stored([[{ ...TYPE, exclude: true }, DUE_TODAY]]),
        reads: [[DUE_TODAY]],
      },
    ])('reads $situation without the Type', ({ stored, reads }) => {
      expect(panelFilterFrom(stored)).toEqual({ rows: reads, groupBy: 'none' });
    });

    it('still shows nothing chosen for a shape it cannot read, Type or not', () => {
      expect(panelFilterFrom(stored([[{ field: 'assignee', values: [] }, TYPE]]))).toEqual(NO_CONDITIONS);
    });
  });

  describe('a stored Sort keeps its other criteria, in order, and is Manual when none is left', () => {
    const TITLE = { field: 'title', direction: 'asc' } as const;
    const PRIORITY = { field: 'priority', direction: 'desc' } as const;
    const TYPE = { field: 'type', direction: 'asc' } as const;
    const stored = (criteria: unknown[]) => JSON.stringify({ criteria });

    it.each([
      { situation: 'Type, then Title', stored: stored([TYPE, TITLE]), reads: [TITLE] },
      { situation: 'Title, then Type, then Priority', stored: stored([TITLE, TYPE, PRIORITY]), reads: [TITLE, PRIORITY] },
      { situation: 'Type alone', stored: stored([TYPE]), reads: null },
      { situation: 'Title, then a field no release knows', stored: stored([TITLE, { field: 'colour', direction: 'asc' }]), reads: null },
      { situation: 'Title and Priority, as saved', stored: panelSortAsStored([TITLE, PRIORITY]), reads: [TITLE, PRIORITY] },
    ])('reads $situation as the criteria it keeps', ({ stored, reads }) => {
      expect(panelSortFrom(stored)).toEqual(reads);
    });
  });

  describe('the grouping a filter was saved with reads back as it was, and anything it cannot read is none', () => {
    it.each([
      {
        situation: 'saved grouped by Panel',
        stored: panelFilterAsStored([[DUE_TODAY, PRIORITY_HIGH]], 'panel'),
        reads: 'panel',
      },
      {
        situation: 'saved grouped by Dashboard',
        stored: panelFilterAsStored([[DUE_TODAY, PRIORITY_HIGH]], 'dashboard'),
        reads: 'dashboard',
      },
      {
        situation: 'stored with no grouping',
        stored: JSON.stringify({ rows: [[DUE_TODAY, PRIORITY_HIGH]] }),
        reads: 'none',
      },
      {
        situation: 'holding a grouping this release does not know',
        stored: JSON.stringify({ rows: [[DUE_TODAY, PRIORITY_HIGH]], groupBy: 'type' }),
        reads: 'none',
      },
    ])('reads $situation, its rows intact', ({ stored, reads }) => {
      // The rows surviving is the point of the last row: a grouping a later
      // release wrote costs the grouping alone, never an empty Filter.
      expect(panelFilterFrom(stored)).toEqual({ rows: [[DUE_TODAY, PRIORITY_HIGH]], groupBy: reads });
    });

    it('is written as none where no grouping is given', () => {
      expect(panelFilterFrom(panelFilterAsStored([[DUE_TODAY]]))?.groupBy).toBe('none');
    });
  });

  describe('nothing is filed onto a panel of text or onto one that gathers what it shows', () => {
    // All three together, because the point of their being functions is that
    // they cannot come to disagree: a kind added later has one row here rather
    // than three chances to be answered two different ways.
    it.each([
      {
        situation: 'holds the items filed into it',
        kind: 'items' as const,
        takes: true,
        text: false,
        gathers: false,
      },
      {
        situation: 'holds the text written in it',
        kind: 'text' as const,
        takes: false,
        text: true,
        gathers: false,
      },
      {
        situation: 'gathers what matches a rule',
        kind: 'filter' as const,
        takes: false,
        text: false,
        gathers: true,
      },
    ])('a panel that $situation', ({ kind, takes, text, gathers }) => {
      expect(panelTakesItems({ kind })).toBe(takes);
      expect(panelHoldsText({ kind })).toBe(text);
      expect(panelGathers({ kind })).toBe(gathers);
    });
  });
});
