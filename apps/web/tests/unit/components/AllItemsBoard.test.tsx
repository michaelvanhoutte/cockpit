import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import { A_DESK, A_PHONE, onAScreen } from '../onAScreen';
import { allItemsFilterId } from '../../../src/allItemsTab';
import AllItemsBoard from '../../../src/components/AllItemsBoard';
import { readDashboardFilter, useFilterBarOpen, writeDashboardFilter } from '../../../src/dashboardFilter';
import { deviceSpeaks } from '../support/timeZone';
import { resetStanding, stand } from '../../../src/offline';
import { browserStore } from '../../../src/lastVisited';
import { NO_DASHBOARD_FILTER } from '@cockpit/shared';

/**
 * F1/C: what the table draws from a snapshot and what a press on it does
 * ("Put each setting where a person looks for it", issue 688). Which items it
 * lists, how a row reads and how a header orders them is
 * tests/unit/allItems.test.ts; that a finished item's form really reopens it is
 * the browser walk in tests/e2e/all-items.test.ts.
 */
const held = vi.hoisted(() => ({
  items: [] as Item[],
  opened: [] as string[],
  /** What the finished Items' read answers, and what it waits for or fails with. */
  finished: [] as Item[],
  finishedGate: null as Promise<void> | null,
  finishedFails: false,
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchFinishedItems: async () => {
    await held.finishedGate;
    if (held.finishedFails) throw new Error('finished items failed: 500');
    return { items: held.finished, filings: [], attachments: [] };
  },
}));

vi.mock('../../../src/itemForm', () => ({
  useOpenItem: () => (itemId: string) => {
    held.opened.push(itemId);
  },
}));

vi.mock('../../../src/api/queries', () => ({
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        items: held.items,
        dashboards: [{ id: 'd-work', name: 'Work' }],
        panels: [{ id: 'p-calls', dashboardId: 'd-work', name: 'Calls', kind: 'items' }],
        filings: [{ itemId: 'filed', panelId: 'p-calls', position: 0 }],
        attachments: [],
      } as unknown as WorkspaceSnapshot),
  }),
}));

function anItem(id: string, fields: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    priority: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...fields,
  } as Item;
}

/**
 * Opens the filter bar the way the tab's funnel does, which is not part of this
 * table - or shuts it, since whether it is open is kept in memory across cases.
 */
function TheFunnelPressed({ pressed }: { pressed: boolean }) {
  const [, open] = useFilterBarOpen(allItemsFilterId('ws-work'));
  useEffect(() => open(pressed), [open, pressed]);
  return null;
}

function theTable(items: Item[], { barOpen = false } = {}) {
  held.items = items;
  held.opened = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TheFunnelPressed pressed={barOpen} />
      <AllItemsBoard workspaceId="ws-work" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** n items, newest change first in the order given, the listed positions finished. */
function manyItems(n: number, finished: number[] = []): Item[] {
  return Array.from({ length: n }, (_, at) =>
    anItem(`item-${String(at).padStart(3, '0')}`, {
      updatedAt: new Date(Date.UTC(2026, 8, 1) + (n - at) * 60_000).toISOString(),
      completedAt: finished.includes(at) ? '2026-08-01T00:00:00.000Z' : null,
    }),
  );
}

const rowCount = () => screen.queryAllByRole('row').length - (screen.queryByRole('table') ? 1 : 0);
const statusChip = (name: string) =>
  within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name });

/** What the bar would have stored for All items. */
function storedStatuses(...statuses: ('to_do' | 'in_progress' | 'done')[]) {
  writeDashboardFilter(browserStore(), allItemsFilterId('ws-work'), { ...NO_DASHBOARD_FILTER, statuses });
}

const titlesInOrder = () =>
  screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent);

beforeEach(() => {
  onAScreen(A_DESK);
  held.finished = [];
  held.finishedGate = null;
  held.finishedFails = false;
});

afterEach(() => {
  cleanup();
  resetStanding();
  browserStore()?.clear();
  vi.unstubAllGlobals();
});

describe('Inbox', () => {
  describe('a row opens the item', () => {
    it('opens the form of the item whose row is pressed, by the row and by its title', async () => {
      const user = theTable([anItem('first'), anItem('second')]);
      await screen.findByRole('table');

      await user.click(within(screen.getByRole('row', { name: /second/ })).getAllByRole('cell')[5]!);
      await user.click(screen.getByRole('button', { name: 'first' }));

      expect(held.opened).toEqual(['second', 'first']);
    });
  });

  describe('a header sorts, newest changed first by default', () => {
    it('lists the newest change first, and the header pressed orders by it, then reversed', async () => {
      const user = theTable([
        anItem('Bravo', { updatedAt: '2026-09-02T00:00:00.000Z' }),
        anItem('Alpha', { updatedAt: '2026-09-01T00:00:00.000Z' }),
        anItem('Charlie', { updatedAt: '2026-09-03T00:00:00.000Z' }),
      ]);
      await screen.findByRole('table');
      expect(titlesInOrder()).toEqual(['Charlie', 'Bravo', 'Alpha']);

      await user.click(screen.getByRole('button', { name: 'Title' }));
      expect(titlesInOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
      expect(screen.getByRole('columnheader', { name: /Title/ })).toHaveAttribute('aria-sort', 'ascending');

      await user.click(screen.getByRole('button', { name: /Title/ }));
      expect(titlesInOrder()).toEqual(['Charlie', 'Bravo', 'Alpha']);
    });
  });

  describe('each row says what the item is, where it is and when it last changed', () => {
    it('draws the six columns, with the place and a finished item greyed', async () => {
      deviceSpeaks('en-US');
      theTable([
        anItem('filed', { priority: 'high', dueDate: '2026-09-20' }),
        anItem('finished', { completedAt: '2026-09-11T09:00:00.000Z' }),
      ]);
      await screen.findByRole('table');

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Title',
        'Status',
        'Priority',
        'Due',
        'Where it is',
        'Last changed ▾',
      ]);
      const filed = within(screen.getByRole('row', { name: /filed/ }));
      expect(filed.getByText('Work ▸ Calls')).toBeVisible();
      expect(filed.getByText('High')).toBeVisible();
      expect(filed.getByText('Sep 20, 2026')).toBeVisible();
      const finished = screen.getByRole('row', { name: /finished/ });
      expect(within(finished).getByText('Done')).toBeVisible();
      expect(within(finished).getByText('Inbox')).toBeVisible();
      expect(finished).toHaveClass('text-ink-faint');
    });
  });

  describe('the filter narrows All items over every row, not only the page drawn', () => {
    it('offers To do, In progress, Waiting for reply and Done, and lists only the finished items once Done is chosen', async () => {
      const user = theTable(
        [anItem('open'), anItem('finished', { completedAt: '2026-09-11T09:00:00.000Z' })],
        { barOpen: true },
      );
      await screen.findByRole('table');

      expect(
        within(screen.getByRole('group', { name: 'Status' }))
          .getAllByRole('button')
          .map((chip) => chip.textContent),
      ).toEqual(['To do', 'In progress', 'Waiting for reply', 'Done']);
      await user.click(statusChip('Done'));

      expect(titlesInOrder()).toEqual(['finished']);
      expect(screen.getByRole('heading', { name: /All items\s*1 of 2/ })).toBeVisible();
    });

    it('lists a waiting item only under Waiting for reply, never under To do or In progress', async () => {
      const items = [
        anItem('plain'),
        anItem('started', { startedAt: '2026-09-10T09:00:00.000Z' }),
        anItem('waiting', { waitingSince: '2026-09-10T09:00:00.000Z' }),
      ];
      const user = theTable(items, { barOpen: true });
      await screen.findByRole('table');

      await user.click(statusChip('To do'));
      await user.click(statusChip('In progress'));
      expect(titlesInOrder()).toEqual(['plain', 'started']);

      await user.click(statusChip('To do'));
      await user.click(statusChip('In progress'));
      await user.click(statusChip('Waiting for reply'));
      expect(titlesInOrder()).toEqual(['waiting']);
    });

    it('gives a phone the same summary and sheet, the sheet offering Done under Status', async () => {
      onAScreen(A_PHONE);
      storedStatuses('done');
      const user = theTable([anItem('open'), anItem('finished', { completedAt: '2026-09-11T09:00:00.000Z' })]);
      await screen.findByRole('table');

      const line = await screen.findByRole('group', { name: 'Dashboard filter summary' });
      expect(within(line).getByText('Done')).toBeVisible();
      expect(screen.queryByRole('search', { name: 'Dashboard filter' })).toBeNull();

      await user.click(within(line).getByText('Edit'));

      expect(statusChip('Done')).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows a match beyond the first 50 on the first page', async () => {
      storedStatuses('done');
      theTable(manyItems(120, [110]));

      await screen.findByRole('table');

      expect(titlesInOrder()).toEqual(['item-110']);
    });

    it.each([
      { situation: 'a filter that matches none', items: [anItem('open')], said: 'No item matches the filter.' },
      { situation: 'no items at all', items: [], said: 'There are no items yet.' },
    ])('says "$said" for $situation', async ({ items, said }) => {
      storedStatuses('done');
      theTable(items);

      expect(await screen.findByText(said)).toBeVisible();
    });

    it('changes no dashboard’s filter', async () => {
      const user = theTable([anItem('open')], { barOpen: true });
      await screen.findByRole('table');

      await user.click(statusChip('Done'));

      expect(readDashboardFilter(browserStore(), allItemsFilterId('ws-work')).statuses).toEqual(['done']);
      expect(readDashboardFilter(browserStore(), 'd-work')).toEqual(NO_DASHBOARD_FILTER);
    });
  });

  describe('the table is drawn 50 rows at a time, and says how many there are in all', () => {
    it('draws 50 of 120, then 100, then all 120 with no Show more left', async () => {
      const user = theTable(manyItems(120));
      await screen.findByRole('table');
      expect(screen.getByRole('heading', { name: /All items\s*120/ })).toBeVisible();
      expect(rowCount()).toBe(50);

      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(rowCount()).toBe(100);

      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(rowCount()).toBe(120);
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('draws a filtered list of 30 whole, saying it is 30 of 120', async () => {
      storedStatuses('done');
      theTable(manyItems(120, Array.from({ length: 30 }, (_, at) => at * 4)));

      await screen.findByRole('table');

      expect(rowCount()).toBe(30);
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
      expect(screen.getByRole('heading', { name: /All items\s*30 of 120/ })).toBeVisible();
    });

    it('starts again from the first 50 when a header is pressed', async () => {
      const user = theTable(manyItems(120));
      await screen.findByRole('table');
      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(rowCount()).toBe(100);

      await user.click(screen.getByRole('button', { name: 'Title' }));

      expect(rowCount()).toBe(50);
    });
  });

  describe('the All items filter is kept in this browser', () => {
    it('is still on when the table is drawn again', async () => {
      const finished = anItem('finished', { completedAt: '2026-09-11T09:00:00.000Z' });
      const user = theTable([anItem('open'), finished], { barOpen: true });
      await screen.findByRole('table');
      await user.click(statusChip('Done'));
      cleanup();

      theTable([anItem('open'), finished]);

      await screen.findByRole('table');
      expect(titlesInOrder()).toEqual(['finished']);
    });
  });
});

describe('Dashboards', () => {
  describe('All items draws the finished Items it has fetched with the open ones', () => {
    it('says the finished Items are loading while they arrive, then draws them beside the open ones', async () => {
      let arrive: () => void = () => {};
      held.finishedGate = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      held.finished = [anItem('done-long-ago', { completedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })];
      theTable([anItem('open')]);

      await screen.findByRole('table');
      expect(screen.getByRole('status')).toHaveTextContent('Loading finished items…');
      expect(titlesInOrder()).toEqual(['open']);

      await act(async () => arrive());

      await waitFor(() => expect(titlesInOrder()).toEqual(['open', 'done-long-ago']));
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('does not say there are no items yet while the finished ones are still arriving', async () => {
      held.finishedGate = new Promise<void>(() => {});
      theTable([]);

      expect(await screen.findByRole('status')).toHaveTextContent('Loading finished items…');
      expect(screen.queryByText('There are no items yet.')).toBeNull();
    });

    it('says the finished Items could not be read, and reads them again on Try again', async () => {
      held.finishedFails = true;
      held.finished = [anItem('done', { completedAt: '2026-01-01T00:00:00.000Z' })];
      const user = theTable([anItem('open')]);
      expect(await screen.findByRole('alert')).toHaveTextContent('Finished items could not be read.');
      expect(titlesInOrder()).toEqual(['open']);

      held.finishedFails = false;
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() => expect(titlesInOrder()).toEqual(['open', 'done']));
    });
  });

  describe('All items is not available offline, until the finished Items have been fetched', () => {
    it('says it needs a connection, and draws no table, when opened offline', async () => {
      stand({ connecting: false, found: true });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // What an offline open draws the Workspace from: the copy this device saved.
      client.setQueryData(['snapshot', 'ws-work'], {
        items: [anItem('open')],
        dashboards: [],
        panels: [],
        filings: [],
        attachments: [],
      });
      render(
        <QueryClientProvider client={client}>
          <AllItemsBoard workspaceId="ws-work" />
        </QueryClientProvider>,
      );

      expect(await screen.findByText(/All items needs a connection/)).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('draws the table once the connection is back and the finished Items have arrived', async () => {
      stand({ connecting: false, found: true });
      held.finished = [anItem('done', { completedAt: '2026-01-01T00:00:00.000Z' })];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['snapshot', 'ws-work'], { items: [anItem('open')], dashboards: [], panels: [], filings: [], attachments: [] });
      render(
        <QueryClientProvider client={client}>
          <AllItemsBoard workspaceId="ws-work" />
        </QueryClientProvider>,
      );
      await screen.findByText(/All items needs a connection/);

      act(() => stand({ found: false }));

      await waitFor(() => expect(titlesInOrder()).toEqual(['open', 'done']));
    });
  });
});
