import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import AllItemsBoard from '../../../src/components/AllItemsBoard';

/**
 * F1/C: what the table draws from a snapshot and what a press on it does
 * ("Put each setting where a person looks for it", issue 688). Which items it
 * lists, how a row reads and how a header orders them is
 * tests/unit/allItems.test.ts; that a finished item's form really reopens it is
 * the browser walk in tests/e2e/all-items.test.ts.
 */
const held = vi.hoisted(() => ({ items: [] as Item[], opened: [] as string[] }));

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
        itemTypes: [{ id: 't-task', name: 'Task' }],
      } as unknown as WorkspaceSnapshot),
  }),
}));

function anItem(id: string, fields: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    typeId: null,
    priority: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...fields,
  } as Item;
}

function theTable(items: Item[]) {
  held.items = items;
  held.opened = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AllItemsBoard workspaceId="ws-work" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const titlesInOrder = () =>
  screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]?.textContent);

afterEach(cleanup);

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
    it('draws the seven columns, with the place and a finished item greyed', async () => {
      theTable([
        anItem('filed', { typeId: 't-task', priority: 'high', dueDate: '2026-09-20' }),
        anItem('finished', { completedAt: '2026-09-11T09:00:00.000Z' }),
      ]);
      await screen.findByRole('table');

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        'Title',
        'Type',
        'Status',
        'Priority',
        'Due',
        'Where it is',
        'Last changed ▾',
      ]);
      const filed = within(screen.getByRole('row', { name: /filed/ }));
      expect(filed.getByText('Work ▸ Calls')).toBeVisible();
      expect(filed.getByText('Task')).toBeVisible();
      expect(filed.getByText('High')).toBeVisible();
      const finished = screen.getByRole('row', { name: /finished/ });
      expect(within(finished).getByText('Done')).toBeVisible();
      expect(within(finished).getByText('Inbox')).toBeVisible();
      expect(finished).toHaveClass('text-ink-faint');
    });
  });
});
