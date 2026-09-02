import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Filing, Item, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { ItemList } from '../../../src/components/ItemList';

/**
 * F1: the picker and what choosing in it sends. What a move then does to a
 * panel and to the Inbox is a query, proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts; what is asked here is
 * the wiring - that the right panels are offered, in the right order, and that
 * choosing one sends a move naming that panel and the order it lands in.
 */

const held = vi.hoisted(() => ({
  items: [] as Item[],
  filings: [] as Filing[],
  dashboards: [] as Dashboard[],
  panels: [] as Panel[],
  mutate: vi.fn(),
  error: null as Error | null,
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({
    mutate: held.mutate,
    reset: vi.fn(),
    isPending: false,
    error: held.error,
  }),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: {
          id: workspaceId,
          tenantId: 'tenant',
          name: 'Work',
          color: '#6f62b5',
          bar: '#dbd7ee',
          ground: '#e3e1f2',
          header: '#d2cdea',
        },
        items: held.items,
        dashboards: held.dashboards,
        panels: held.panels,
        layouts: [],
        associations: [],
        filings: held.filings,
        generatedAt: '2026-08-31T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

function anItem(id: string, title: string): Item {
  return {
    id,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title,
    preview: null,
    sourceResolvedAt: null,
    status: 'to_process',
    nextAction: null,
    focusHorizon: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
  };
}

const TODAY: Dashboard = { id: 'd-today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' };
const RESEARCH: Dashboard = {
  id: 'd-research',
  tenantId: 'tenant',
  workspaceId: 'ws-work',
  name: 'Research',
};

function aPanel(id: string, dashboardId: string, name: string): Panel {
  return { id, tenantId: 'tenant', dashboardId, name };
}

const BART = anItem('11111111-1111-7111-8111-000000000001', 'Reply to Bart');

async function showList({
  items = [BART],
  openDashboardId = null as string | null,
}: { items?: Item[]; openDashboardId?: string | null } = {}) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ItemList
        workspaceId="ws-work"
        items={items}
        openDashboardId={openDashboardId}
        emptyMessage="Nothing to deal with."
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

/** Move to… lives in the row's own menu, so reaching the picker is two gestures. */
async function openThePicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Item actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
  return screen.findByRole('dialog');
}

/** What the picker offers, top to bottom. */
function offered(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((label) => label !== 'Cancel');
}

beforeEach(() => {
  held.items = [BART];
  held.filings = [];
  held.dashboards = [TODAY, RESEARCH];
  held.panels = [
    aPanel('p-falcon', TODAY.id, 'Falcon'),
    aPanel('p-anna', TODAY.id, 'Anna'),
    aPanel('p-reading', RESEARCH.id, 'To read'),
  ];
  held.error = null;
  held.mutate = vi.fn();
  localStorage.clear();
});

describe('Panels', () => {
  describe('moving an item offers every panel of the workspace, the dashboard you are on first', () => {
    it('puts the open dashboard’s panels above the other dashboards’', async () => {
      const user = await showList({ openDashboardId: RESEARCH.id });

      const dialog = await openThePicker(user);

      expect(offered(dialog)).toEqual(['Inboxstill to deal with', 'To read', 'Falcon', 'Anna']);
    });

    it('offers the Inbox as somewhere to put it back', async () => {
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      expect(within(dialog).getByRole('button', { name: /^Inbox/ })).toBeVisible();
    });

    it('offers the panels most recently filed into above the dashboards', async () => {
      localStorage.setItem('cockpit.recent-panels.ws-work', JSON.stringify(['p-reading', 'p-anna']));
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      // The recent two first, each saying which dashboard it is on, then every
      // dashboard in turn.
      expect(offered(dialog).slice(0, 3)).toEqual([
        'Inboxstill to deal with',
        'To readResearch',
        'AnnaToday',
      ]);
    });

    it('still opens for a workspace whose only dashboard has no panels', async () => {
      held.dashboards = [TODAY];
      held.panels = [];
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      expect(within(dialog).getByText('No panels yet.')).toBeVisible();
      expect(within(dialog).getByRole('button', { name: /^Inbox/ })).toBeVisible();
    });
  });

  describe('choosing where an item goes files it there, at the top of that panel', () => {
    it('sends the panel and the order it lands in', async () => {
      held.items = [BART, anItem('11111111-1111-7111-8111-000000000002', 'Renew the domain')];
      held.filings = [{ panelId: 'p-falcon', itemId: held.items[1]!.id, position: 0 }];
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'move_item_to_panel',
          payload: expect.objectContaining({
            itemId: BART.id,
            panelId: 'p-falcon',
            order: [BART.id, held.items[1]!.id],
          }),
        }),
        expect.anything(),
      );
    });

    it('sends no order when it is being put back in the Inbox, which has none', async () => {
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: /^Inbox/ }));

      expect(held.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ panelId: null, order: [] }),
        }),
        expect.anything(),
      );
    });

    it('remembers the panel once the move has happened, and not before', async () => {
      held.mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => options?.onSuccess?.());
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Falcon' }));

      expect(JSON.parse(localStorage.getItem('cockpit.recent-panels.ws-work') ?? '[]')).toEqual([
        'p-falcon',
      ]);
    });

    it('sends nothing when the question is cancelled', async () => {
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(held.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('a move that fails says why and leaves the item where it was', () => {
    it('keeps the question open with the server’s own words on it', async () => {
      held.error = new CommandRefused(409, 'The order sent is not the order of that panel any more');
      const user = await showList({ openDashboardId: TODAY.id });

      const dialog = await openThePicker(user);

      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'The order sent is not the order of that panel any more',
      );
      expect(screen.getByText('Reply to Bart')).toBeVisible();
    });
  });

  describe('a list with nothing in it says so', () => {
    it('says what it is empty of rather than showing an empty box', async () => {
      await showList({ items: [] });

      expect(await screen.findByText('Nothing to deal with.')).toBeVisible();
    });
  });
});
