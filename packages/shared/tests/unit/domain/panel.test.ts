import { describe, expect, it } from 'vitest';
import {
  NO_CONDITIONS,
  panelFilterAsStored,
  panelFilterFrom,
  panelGathers,
  panelHoldsText,
  panelPlace,
  panelTakesItems,
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
const TYPE_OKR: FilterCondition = { field: 'type', values: ['type-okr'] };
const PANEL_Q3: FilterCondition = { field: 'panel', values: ['panel-q3'] };

describe('Panels', () => {
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

  describe('a panel that gathers what it shows says so however its conditions were stored', () => {
    it('reads back exactly what was written', () => {
      expect(panelFilterFrom(panelFilterAsStored([DUE_TODAY]))).toEqual({
        conditions: [DUE_TODAY],
        match: 'all',
        groupBy: 'none',
      });
    });

    it('reads back a Priority, a Type and a Panel condition beside a Due date one', () => {
      // The four fields together, each carrying its own value shape - a
      // discriminated union rather than a reshaping of every stored Filter
      // ("Filter a Filter panel by priority and type", issue 464; "Filter a
      // Filter panel by panel, and name the Filters a panel's deletion
      // affects", issue 465).
      expect(
        panelFilterFrom(panelFilterAsStored([DUE_TODAY, PRIORITY_HIGH, TYPE_OKR, PANEL_Q3])),
      ).toEqual({ conditions: [DUE_TODAY, PRIORITY_HIGH, TYPE_OKR, PANEL_Q3], match: 'all', groupBy: 'none' });
    });

    it('is not a filter at all where nothing was stored', () => {
      expect(panelFilterFrom(null)).toBeNull();
    });

    it('drops a field stored twice, keeping the first, where it was saved before a Filter refused that', () => {
      // *+ Add a condition* offered a Due date with nothing stopping a second
      // one before "a field appears once on a Filter" was refused server-side
      // ("Filter a Filter panel by priority and type", issue 464) - a Panel
      // saved that way before the refusal shipped is real data, not a
      // hypothetical one, so reading it back keeps the rows this release can
      // ever draw one of per field, and lets an unrelated later save of the
      // same Panel go through rather than be refused for a duplicate nobody
      // just chose.
      const week = { field: 'dueDate', window: 'week', orOverdue: false } as const;
      expect(
        panelFilterFrom(panelFilterAsStored([DUE_TODAY, PRIORITY_HIGH, week])),
      ).toEqual({ conditions: [DUE_TODAY, PRIORITY_HIGH], match: 'all', groupBy: 'none' });
    });

    it.each([
      { situation: 'text that is not what was stored at all', stored: '{oops' },
      { situation: 'a shape from some other release', stored: '{"rules":[]}' },
      { situation: 'a window this release has never heard of', stored: '{"conditions":[{"field":"dueDate","window":"fortnight"}]}' },
      { situation: 'a priority level this release has never heard of', stored: '{"conditions":[{"field":"priority","values":["urgent"]}]}' },
      { situation: 'a field this release has never heard of', stored: '{"conditions":[{"field":"assignee","values":[]}]}' },
      { situation: 'a list of something that is not a condition', stored: '{"conditions":["today"]}' },
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
      expect(panelFilterFrom('{"conditions":[{"field":"dueDate","window":"week"}]}')).toEqual({
        conditions: [{ field: 'dueDate', window: 'week', orOverdue: true }],
        match: 'all',
        groupBy: 'none',
      });
    });
  });

  describe('a filter with no setting for how its conditions combine means all of them', () => {
    it.each([
      {
        situation: 'stored before there was a setting',
        stored: JSON.stringify({ conditions: [DUE_TODAY, PRIORITY_HIGH] }),
        reads: 'all',
      },
      {
        situation: 'stored as any',
        stored: panelFilterAsStored([DUE_TODAY, PRIORITY_HIGH], 'any'),
        reads: 'any',
      },
      {
        situation: 'stored as all',
        stored: panelFilterAsStored([DUE_TODAY, PRIORITY_HIGH], 'all'),
        reads: 'all',
      },
      {
        situation: 'holding a value nobody wrote',
        stored: JSON.stringify({ conditions: [DUE_TODAY, PRIORITY_HIGH], match: 'either' }),
        reads: 'all',
      },
    ])('reads $situation as $reads, conditions intact', ({ stored, reads }) => {
      // The conditions surviving is the point of the last row: a setting this
      // release cannot read costs the setting alone, never an empty Filter.
      expect(panelFilterFrom(stored)).toEqual({
        conditions: [DUE_TODAY, PRIORITY_HIGH],
        match: reads,
        groupBy: 'none',
      });
    });

    it('is written as all where no setting is given', () => {
      expect(panelFilterFrom(panelFilterAsStored([DUE_TODAY]))?.match).toBe('all');
    });
  });

  describe('the grouping a filter was saved with reads back as it was, and anything it cannot read is none', () => {
    it.each([
      {
        situation: 'saved grouped by Panel',
        stored: panelFilterAsStored([DUE_TODAY, PRIORITY_HIGH], 'any', 'panel'),
        reads: { match: 'any', groupBy: 'panel' },
      },
      {
        situation: 'saved grouped by Dashboard',
        stored: panelFilterAsStored([DUE_TODAY, PRIORITY_HIGH], 'all', 'dashboard'),
        reads: { match: 'all', groupBy: 'dashboard' },
      },
      {
        situation: 'stored before grouping existed',
        stored: JSON.stringify({ conditions: [DUE_TODAY, PRIORITY_HIGH], match: 'any' }),
        reads: { match: 'any', groupBy: 'none' },
      },
      {
        situation: 'holding a grouping this release does not know',
        stored: JSON.stringify({ conditions: [DUE_TODAY, PRIORITY_HIGH], match: 'any', groupBy: 'type' }),
        reads: { match: 'any', groupBy: 'none' },
      },
    ])('reads $situation, conditions and how they combine intact', ({ stored, reads }) => {
      // The conditions surviving is the point of the last row: a grouping a
      // later release wrote costs the grouping alone, never an empty Filter.
      expect(panelFilterFrom(stored)).toEqual({ conditions: [DUE_TODAY, PRIORITY_HIGH], ...reads });
    });

    it('is written as none where no grouping is given', () => {
      expect(panelFilterFrom(panelFilterAsStored([DUE_TODAY]))?.groupBy).toBe('none');
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
