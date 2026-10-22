import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, Series, WorkspaceSnapshot } from '@cockpit/shared';
import { A_DESK, onAScreen } from '../onAScreen';
import ScheduledBoard from '../../../src/components/ScheduledBoard';

/**
 * F1/C: what the table draws from a snapshot and what a press on it does ("See
 * what is scheduled to come back", issue 1431). Which series it lists, in what
 * order and how a day reads is tests/unit/scheduled.test.ts; that a phone
 * scrolls it sideways and the form really opens is the browser walk in
 * tests/e2e/dashboards.test.ts.
 */
const held = vi.hoisted(() => ({ items: [] as Item[], series: [] as Series[], opened: [] as string[] }));

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
        series: held.series,
        dashboards: [{ id: 'd-work', name: 'Work' }],
        panels: [{ id: 'p-calls', dashboardId: 'd-work', name: 'Calls', kind: 'items' }],
        filings: [{ itemId: 'filed', panelId: 'p-calls', position: 0 }],
      } as unknown as WorkspaceSnapshot),
  }),
}));

function aSeries(id: string, nextOn: string): Series {
  return { id, tenantId: 'tenant', frequency: 'weekly', nextOn, dueAfterDays: null, timeZone: 'UTC', stoppedAt: null };
}

function aCopy(id: string, seriesId: string, createdAt: string, fields: Partial<Item> = {}): Item {
  return { id, title: id, seriesId, createdAt, completedAt: null, ...fields } as Item;
}

function theTable(items: Item[], series: Series[]) {
  held.items = items;
  held.series = series;
  held.opened = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScheduledBoard workspaceId="ws-work" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** The year as the table says it for a day further on than this one, so no case depends on today. */
const NEXT_YEAR = new Date().getFullYear() + 1;

beforeEach(() => {
  onAScreen(A_DESK);
});

afterEach(cleanup);

describe('Dashboards', () => {
  describe('a Scheduled row opens its series’ latest copy', () => {
    it('opens the form of the newest copy, finished or not, by the row and by its title', async () => {
      const user = theTable(
        [
          aCopy('older', 'weekly', '2026-10-01T09:00:00.000Z'),
          aCopy('newest', 'weekly', '2026-10-08T09:00:00.000Z', { completedAt: '2026-10-09T09:00:00.000Z' }),
        ],
        [aSeries('weekly', `${NEXT_YEAR}-10-22`)],
      );
      await screen.findByRole('table');

      await user.click(within(screen.getByRole('row', { name: /newest/ })).getAllByRole('cell')[1]!);
      await user.click(screen.getByRole('button', { name: 'newest' }));

      expect(held.opened).toEqual(['newest', 'newest']);
    });
  });

  describe('each Scheduled row says what repeats, when it is next on and where it is', () => {
    it('draws the four columns, soonest first, with the year only where it is not this year', async () => {
      theTable(
        [
          aCopy('filed', 'a', '2026-10-01T09:00:00.000Z'),
          aCopy('inbox', 'b', '2026-10-01T09:00:00.000Z'),
        ],
        [aSeries('a', `${NEXT_YEAR}-10-22`), aSeries('b', `${new Date().getFullYear()}-12-30`)],
      );
      await screen.findByRole('table');

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Title',
        'Repeats',
        'Next on',
        'Where it is',
      ]);
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual(['inbox', 'filed']);
      expect(within(rows[0]!).getAllByRole('cell')[2]?.textContent).not.toMatch(/\d{4}/);
      expect(within(rows[1]!).getAllByRole('cell')[2]?.textContent).toMatch(new RegExp(`${NEXT_YEAR}$`));
      expect(within(rows[0]!).getByText('Inbox')).toBeVisible();
      expect(within(rows[0]!).getByText(/^Weekly on /)).toBeVisible();
      expect(screen.getByRole('heading', { name: /Scheduled\s*2/ })).toBeVisible();
    });
  });

  describe('with nothing repeating, Scheduled says how to make an Item repeat', () => {
    it.each([
      { situation: 'no series at all', items: [], series: [] },
      { situation: 'a series stopped with Never', items: [aCopy('x', 'a', '2026-10-01T09:00:00.000Z')], series: [{ ...aSeries('a', '2026-12-01'), stoppedAt: '2026-10-02T09:00:00.000Z' }] },
    ])('says it for $situation', async ({ items, series }) => {
      theTable(items, series);

      expect(
        await screen.findByText(
          'Nothing repeats yet. Open an Item and press ↻ Repeats on its form to make it come back every week, month or year.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    });
  });
});
