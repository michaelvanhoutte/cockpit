import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, WorkspaceSnapshot } from '@cockpit/shared';
import { DashboardSettingsPage } from '../../../src/pages/DashboardSettingsPage';
import { CommandRefused } from '../../../src/api/client';
import { useCommand } from '../../../src/api/queries';

/**
 * F1: what is under test is the page's own behaviour - what it says before
 * anything is sent, what it asks for, and what it does with an answer it does
 * not like. Whether a name is refused, and whether the last dashboard may go,
 * are the server's rules and are proved against a real store in
 * apps/api/tests/integration/http/dashboards.test.ts.
 */
const held = vi.hoisted(() => ({ dashboards: [] as Dashboard[] }));
const wentTo = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
  },
}));

vi.mock('../../../src/router', () => ({
  dashboardSettingsRoute: { useParams: () => ({ workspaceId: 'ws-work' }) },
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: {
          id: workspaceId,
          tenantId: 'tenant',
          name: 'Work',
          color: '#6f62b5',
          ground: '#e3e1f2',
          header: '#d2cdea',
        },
        items: [],
        dashboards: held.dashboards,
        associations: [],
        generatedAt: '2026-09-01T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

const mockUseCommand = vi.mocked(useCommand);

function aDashboard(name: string): Dashboard {
  return {
    id: `ws-work-${name.toLowerCase().replace(/\s+/g, '-')}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    name,
  };
}

/** The page, listing these dashboards, with a `useCommand` that answers. */
function showPage(names: string[], answer: { error?: Error } = {}) {
  held.dashboards = names.map(aDashboard);
  wentTo.calls = [];
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (!answer.error) options?.onSuccess?.();
  });
  mockUseCommand.mockReturnValue({
    mutate,
    reset: vi.fn(),
    isPending: false,
    error: answer.error ?? null,
    variables: answer.error
      ? { name: 'delete_dashboard', payload: { dashboardId: 'ws-work-research' } }
      : undefined,
  } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DashboardSettingsPage />
    </QueryClientProvider>,
  );
  return { mutate, user: userEvent.setup() };
}

describe('Dashboards', () => {
  describe('the dashboards you can change are the workspace’s, and the Inbox is not one of them', () => {
    it('lists each dashboard by name, and nothing else', async () => {
      showPage(['Dashboard 1', 'Research']);

      expect(await screen.findByText('Research')).toBeVisible();
      expect(screen.getByText('Dashboard 1')).toBeVisible();
      // The Inbox is in the bar, not in this list: it is not a dashboard, so
      // there is nothing here to rename or delete.
      expect(screen.queryByText('Inbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Delete Inbox' })).toBeNull();
    });
  });

  describe('you are told what deleting a dashboard takes with it before it happens', () => {
    it('names it and says what is on it', async () => {
      const { user } = showPage(['Research']);

      await user.click(await screen.findByRole('button', { name: 'Delete Research' }));

      // Panels are what a dashboard holds, and there are none until issue 33.
      expect(screen.getByText('Delete Research? There is nothing on it.')).toBeVisible();
    });

    it('sends nothing when the question is cancelled', async () => {
      const { user, mutate } = showPage(['Research']);

      await user.click(await screen.findByRole('button', { name: 'Delete Research' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByText('Research')).toBeVisible();
    });

    it('asks to delete it, and leaves the workspace to decide where you land', async () => {
      const { user, mutate } = showPage(['Dashboard 1', 'Research']);

      await user.click(await screen.findByRole('button', { name: 'Delete Research' }));
      await user.click(screen.getByRole('button', { name: 'Yes, delete Research' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('delete_dashboard');
      expect(asked.payload.dashboardId).toBe('ws-work-research');
      // Not to a dashboard of its own choosing: the workspace's own address
      // decides, which is what makes deleting the one you are on land you
      // somewhere that works without this page knowing which.
      expect(wentTo.calls).toEqual([{ to: '/w/$workspaceId', params: { workspaceId: 'ws-work' } }]);
    });
  });

  describe('renaming a dashboard asks for the name you typed, starting from the one it has', () => {
    it('offers the current name and asks for the new one without the blanks around it', async () => {
      const { user, mutate } = showPage(['Research']);

      await user.click(await screen.findByRole('button', { name: 'Rename Research' }));
      const box = screen.getByLabelText('New name for Research');
      expect(box).toHaveValue('Research');
      await user.clear(box);
      await user.type(box, '  Recherche  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('rename_dashboard');
      expect(asked.payload.name).toBe('Recherche');
      expect(asked.payload.dashboardId).toBe('ws-work-research');
    });
  });

  describe('a change that could not happen puts the screen back', () => {
    it.each([
      {
        situation: 'the last dashboard may not be deleted',
        error: new CommandRefused(409, 'a workspace keeps at least one dashboard'),
        says: 'a workspace keeps at least one dashboard',
      },
      {
        situation: 'the request never reached the server',
        error: new Error('Failed to fetch'),
        says: 'That did not reach the server. Try again.',
      },
    ])('$situation', async ({ error, says }) => {
      const { user } = showPage(['Research'], { error });

      await user.click(await screen.findByRole('button', { name: 'Delete Research' }));
      await user.click(screen.getByRole('button', { name: 'Yes, delete Research' }));

      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Still there: nothing was deleted, so the row is still the row.
      expect(screen.getByText(/Delete Research\?/)).toBeVisible();
    });
  });
});
