import { describe, expect, it } from 'vitest';
import { allItemsFilterId } from '../../src/allItemsTab';
import {
  NO_DASHBOARD_FILTER,
  forgetEveryDashboardFilter,
  isFiltering,
  readDashboardFilter,
  writeDashboardFilter,
  type DashboardFilter,
} from '../../src/dashboardFilter';

/**
 * F1, and pure: what a Dashboard filter's being set means, and what is
 * remembered of it. Which Items it lets through is
 * packages/shared/tests/unit/domain/dashboard-filter.test.ts's, now that the
 * conditions are shared. That the board and the tabs obey the filter is
 * tests/unit/components/PanelBoard.test.tsx and DashboardBar.test.tsx.
 */

function filterOf(fields: Partial<DashboardFilter>): DashboardFilter {
  return { ...NO_DASHBOARD_FILTER, ...fields };
}

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
  describe('a Dashboard filter is filtering once any condition is set', () => {
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

    it('keeps the All items filter apart from every Dashboard’s, and forgets it at sign-out', () => {
      const store = aStore();
      const all = allItemsFilterId('ws-work');
      writeDashboardFilter(store, all, filterOf({ statuses: ['done'] }));
      writeDashboardFilter(store, 'a', filterOf({ text: 'vat' }));
      expect(readDashboardFilter(store, all)).toEqual(filterOf({ statuses: ['done'] }));
      expect(readDashboardFilter(store, 'a')).toEqual(filterOf({ text: 'vat' }));
      expect(readDashboardFilter(store, allItemsFilterId('ws-home'))).toEqual(NO_DASHBOARD_FILTER);
      forgetEveryDashboardFilter(store);
      expect(store.length).toBe(0);
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
