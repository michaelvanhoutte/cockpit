import { describe, expect, it } from 'vitest';
import type { AgentRun, Item } from '@cockpit/shared';
import {
  NO_DASHBOARD_FILTER,
  forgetEveryDashboardFilter,
  isFiltering,
  itemIdsWithRun,
  matchesDashboardFilter,
  readDashboardFilter,
  writeDashboardFilter,
  type DashboardFilter,
} from '../../src/dashboardFilter';

/**
 * F1, and pure: which Items a Dashboard filter lets through, and what is
 * remembered of it, are decisions over values handed in. That the board and the
 * tabs obey them is tests/unit/components/PanelBoard.test.tsx and
 * DashboardBar.test.tsx. The due windows' own boundaries are
 * tests/unit/filters.test.ts's, which the matcher reuses.
 */

// A Wednesday, so "this week" has a Monday before it and a Sunday after.
const ON = '2026-09-09';

function anItem(fields: Partial<Item> = {}): Item {
  return {
    id: 'item',
    title: 'Pay the invoice',
    description: null,
    nextAction: null,
    sender: null,
    priority: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    ...fields,
  } as Item;
}

function filterOf(fields: Partial<DashboardFilter>): DashboardFilter {
  return { ...NO_DASHBOARD_FILTER, ...fields };
}

const NONE = new Set<string>();
const STARTED = '2026-09-08T09:00:00.000Z';
const DONE = '2026-09-08T17:00:00.000Z';

function aStore(): Storage {
  const held = new Map<string, string>();
  return {
    get length() {
      return held.size;
    },
    key: (at: number) => [...held.keys()][at] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
    clear: () => held.clear(),
  };
}

function aStoreThatRefuses(): Storage {
  const refuse = () => {
    throw new Error('refused');
  };
  return {
    length: 0,
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  };
}

describe('Dashboards', () => {
  describe('a Dashboard filter lets through only the Items meeting every condition set', () => {
    it.each([
      {
        situation: 'Status To do takes Items not started and not finished',
        filter: filterOf({ statuses: ['to_do'] }),
        passes: [anItem()],
        stopped: [anItem({ startedAt: STARTED }), anItem({ completedAt: DONE }), anItem({ startedAt: STARTED, completedAt: DONE })],
      },
      {
        situation: 'Status In progress takes Items started and not finished',
        filter: filterOf({ statuses: ['in_progress'] }),
        passes: [anItem({ startedAt: STARTED })],
        stopped: [anItem(), anItem({ startedAt: STARTED, completedAt: DONE })],
      },
      {
        situation: 'Status Done takes Items finished, started or not',
        filter: filterOf({ statuses: ['done'] }),
        passes: [anItem({ completedAt: DONE }), anItem({ startedAt: STARTED, completedAt: DONE })],
        stopped: [anItem(), anItem({ startedAt: STARTED })],
      },
      {
        situation: 'Status To do and In progress takes Items in either',
        filter: filterOf({ statuses: ['to_do', 'in_progress'] }),
        passes: [anItem(), anItem({ startedAt: STARTED })],
        stopped: [anItem({ completedAt: DONE })],
      },
      {
        situation: 'Status In progress and Priority High takes only Items meeting both',
        filter: filterOf({ statuses: ['in_progress'], priorities: ['high'] }),
        passes: [anItem({ startedAt: STARTED, priority: 'high' })],
        stopped: [anItem({ startedAt: STARTED, priority: 'low' }), anItem({ priority: 'high' })],
      },
      {
        situation: 'Priority High and No priority takes High and unprioritised Items',
        filter: filterOf({ priorities: ['high', 'none'] }),
        passes: [anItem({ priority: 'high' }), anItem({ priority: null })],
        stopped: [anItem({ priority: 'normal' }), anItem({ priority: 'low' })],
      },
      {
        situation: 'Due this week, or overdue, takes this week and what is past',
        filter: filterOf({ due: { window: 'week', orOverdue: true } }),
        passes: [anItem({ dueDate: '2026-09-13' }), anItem({ dueDate: '2026-08-01' })],
        stopped: [anItem({ dueDate: '2026-09-14' }), anItem({ dueDate: null })],
      },
      {
        situation: 'Due this week, not overdue, leaves what is past out',
        filter: filterOf({ due: { window: 'week', orOverdue: false } }),
        passes: [anItem({ dueDate: '2026-09-09' })],
        stopped: [anItem({ dueDate: '2026-08-01' })],
      },
      {
        situation: 'Due not set takes only Items with no due date',
        filter: filterOf({ due: { window: 'none', orOverdue: true } }),
        passes: [anItem({ dueDate: null })],
        stopped: [anItem({ dueDate: '2026-09-09' })],
      },
      {
        situation: 'Containing "vat" matches title, description and next action, in any case',
        filter: filterOf({ text: ' vat ' }),
        passes: [
          anItem({ title: 'File the VAT return' }),
          anItem({ description: 'about vat' }),
          anItem({ nextAction: 'Ask for the Vat number' }),
        ],
        stopped: [anItem({ sender: 'vat@example.com' }), anItem({ title: 'Pay the invoice' })],
      },
      {
        situation: 'Priority High and Containing "vat" takes only Items meeting both',
        filter: filterOf({ priorities: ['high'], text: 'vat' }),
        passes: [anItem({ title: 'VAT', priority: 'high' })],
        stopped: [anItem({ title: 'VAT', priority: 'low' }), anItem({ title: 'Rent', priority: 'high' })],
      },
      {
        situation: 'nothing set takes every Item',
        filter: NO_DASHBOARD_FILTER,
        passes: [anItem({ priority: 'low', dueDate: '2020-01-01' }), anItem()],
        stopped: [],
      },
    ])('$situation', ({ filter, passes, stopped }) => {
      for (const item of passes) expect(matchesDashboardFilter(filter, item, NONE, ON, NONE)).toBe(true);
      for (const item of stopped) expect(matchesDashboardFilter(filter, item, NONE, ON, NONE)).toBe(false);
    });

    it.each([
      { situation: 'With takes Items holding an attachment', choice: 'with' as const, holds: true },
      { situation: 'Without takes Items holding none', choice: 'without' as const, holds: false },
    ])('Attachments $situation', ({ choice, holds }) => {
      const filter = filterOf({ attachments: choice });
      const withAttachments = new Set(['item']);
      expect(matchesDashboardFilter(filter, anItem(), withAttachments, ON, NONE)).toBe(holds);
      expect(matchesDashboardFilter(filter, anItem({ id: 'other' }), withAttachments, ON, NONE)).toBe(!holds);
    });

    it.each([
      { situation: 'Agent running takes an Item with an open run', filter: filterOf({ agentRunning: true }), item: anItem(), runs: ['item'], shown: true },
      { situation: 'Agent running leaves out an Item with no run', filter: filterOf({ agentRunning: true }), item: anItem(), runs: ['other'], shown: false },
      { situation: 'Agent running leaves out every Item where nothing has a run', filter: filterOf({ agentRunning: true }), item: anItem(), runs: [], shown: false },
      { situation: 'Agent running off makes no difference to what runs exist', filter: filterOf({ priorities: ['high'] }), item: anItem({ priority: 'high' }), runs: [], shown: true },
      { situation: 'Agent running and Priority High leaves out a Low Item that has a run', filter: filterOf({ agentRunning: true, priorities: ['high'] }), item: anItem({ priority: 'low' }), runs: ['item'], shown: false },
      { situation: 'Agent running and Priority High takes a High Item with a run', filter: filterOf({ agentRunning: true, priorities: ['high'] }), item: anItem({ priority: 'high' }), runs: ['item'], shown: true },
    ])('$situation', ({ filter, item, runs, shown }) => {
      expect(matchesDashboardFilter(filter, item, NONE, ON, new Set(runs))).toBe(shown);
    });

    it('reads one Item id per run, whatever its status, over any number of runs', () => {
      const runs = ['starting', 'working', 'failed', 'unknown'].map((status, at) => ({ itemId: `i${at}`, status }) as AgentRun);
      const many = Array.from({ length: 5000 }, (_, at) => ({ itemId: `m${at % 100}` }) as AgentRun);
      expect([...itemIdsWithRun(runs)]).toEqual(['i0', 'i1', 'i2', 'i3']);
      expect(itemIdsWithRun([]).size).toBe(0);
      expect(itemIdsWithRun(many).size).toBe(100);
    });

    it('a filter with only blank text set is not filtering', () => {
      expect(isFiltering(filterOf({ text: '   ' }))).toBe(false);
      expect(isFiltering(filterOf({ attachments: 'with' }))).toBe(true);
      expect(isFiltering(filterOf({ agentRunning: true }))).toBe(true);
      expect(isFiltering(filterOf({ statuses: ['in_progress'] }))).toBe(true);
    });
  });

  describe('a Dashboard filter belongs to its Dashboard alone, and is kept in this browser', () => {
    it('is read back for the Dashboard it was set on and for no other', () => {
      const store = aStore();
      const set = filterOf({ priorities: ['high'], text: 'vat', due: { window: 'week', orOverdue: false } });
      writeDashboardFilter(store, 'a', set);
      expect(readDashboardFilter(store, 'a')).toEqual(set);
      expect(readDashboardFilter(store, 'b')).toEqual(NO_DASHBOARD_FILTER);
    });

    it('is forgotten when cleared, leaving nothing stored', () => {
      const store = aStore();
      writeDashboardFilter(store, 'a', filterOf({ text: 'vat' }));
      writeDashboardFilter(store, 'a', NO_DASHBOARD_FILTER);
      expect(store.length).toBe(0);
    });

    it('is forgotten with the rest of what the browser holds about the person', () => {
      const store = aStore();
      writeDashboardFilter(store, 'a', filterOf({ text: 'vat' }));
      writeDashboardFilter(store, 'b', filterOf({ attachments: 'with' }));
      store.setItem('cockpit.inbox-width', '300');
      forgetEveryDashboardFilter(store);
      expect(store.length).toBe(1);
    });

    it.each([
      { situation: 'storage that refuses', store: aStoreThatRefuses(), raw: null },
      { situation: 'no storage at all', store: undefined, raw: null },
      { situation: 'text that is not JSON', store: aStore(), raw: '{nope' },
      { situation: 'JSON of another shape', store: aStore(), raw: '[1,2]' },
    ])('draws unfiltered, and throws nothing, on $situation', ({ store, raw }) => {
      if (raw !== null) store?.setItem('cockpit.dashboard-filter.a', raw);
      expect(readDashboardFilter(store, 'a')).toEqual(NO_DASHBOARD_FILTER);
      expect(() => writeDashboardFilter(store, 'a', filterOf({ text: 'vat' }))).not.toThrow();
      expect(() => forgetEveryDashboardFilter(store)).not.toThrow();
    });

    it('keeps what is readable of a stored filter and drops the rest', () => {
      const store = aStore();
      store.setItem(
        'cockpit.dashboard-filter.a',
        JSON.stringify({ priorities: ['high', 'urgent'], due: { window: 'someday' }, text: 7, attachments: 'with' }),
      );
      expect(readDashboardFilter(store, 'a')).toEqual({
        statuses: [],
        priorities: ['high'],
        due: null,
        text: '',
        attachments: 'with',
        agentRunning: false,
      });
    });

    it('reads a filter stored before Status existed as one with no status, its other conditions intact', () => {
      const store = aStore();
      store.setItem('cockpit.dashboard-filter.a', JSON.stringify({ priorities: ['high'], text: 'vat', attachments: 'with' }));
      expect(readDashboardFilter(store, 'a')).toEqual(filterOf({ priorities: ['high'], text: 'vat', attachments: 'with' }));
      expect(store.getItem('cockpit.dashboard-filter.a')).toBe(
        JSON.stringify({ priorities: ['high'], text: 'vat', attachments: 'with' }),
      );
    });

    it('drops a stored status that is not one of the three and keeps the rest', () => {
      const store = aStore();
      store.setItem('cockpit.dashboard-filter.a', JSON.stringify({ statuses: ['in_progress', 'blocked'], text: 'vat' }));
      expect(readDashboardFilter(store, 'a')).toEqual(filterOf({ statuses: ['in_progress'], text: 'vat' }));
    });

    it.each([
      { situation: 'stored before the field existed', stored: { text: 'vat' }, reads: false },
      { situation: 'stored with a non-boolean', stored: { agentRunning: 'yes' }, reads: false },
      { situation: 'stored on', stored: { agentRunning: true }, reads: true },
    ])('Agent running $situation reads as $reads', ({ stored, reads }) => {
      const store = aStore();
      store.setItem('cockpit.dashboard-filter.a', JSON.stringify(stored));
      expect(readDashboardFilter(store, 'a').agentRunning).toBe(reads);
    });

    it('keeps Agent running in this browser for its Dashboard alone, and forgets it at sign-out', () => {
      const store = aStore();
      writeDashboardFilter(store, 'a', filterOf({ agentRunning: true }));
      expect(readDashboardFilter(store, 'a').agentRunning).toBe(true);
      expect(readDashboardFilter(store, 'b').agentRunning).toBe(false);
      forgetEveryDashboardFilter(store);
      expect(readDashboardFilter(store, 'a').agentRunning).toBe(false);
    });
  });
});
