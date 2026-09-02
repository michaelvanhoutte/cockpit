import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { DashboardPage } from '../../../src/pages/DashboardPage';

/**
 * F1: what is under test is the page reading a stored copy that is older than
 * the fields it wants. Everything the dashboard then does with those panels is
 * the board's, and is proved in tests/unit/components/PanelBoard.test.tsx.
 */

const held = vi.hoisted(() => ({ snapshot: {} as unknown as WorkspaceSnapshot }));

vi.mock('../../../src/router', () => ({
  dashboardRoute: { useParams: () => ({ workspaceId: 'ws-work', dashboardId: 'today' }) },
}));

vi.mock('../../../src/api/queries', async () => {
  const actual = await vi.importActual<typeof import('../../../src/api/queries')>(
    '../../../src/api/queries',
  );
  return {
    ...actual,
    useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
    snapshotQuery: (workspaceId: string) => ({
      queryKey: ['snapshot', workspaceId],
      queryFn: () => Promise.resolve(held.snapshot),
    }),
  };
});

/** A workspace's read model as it was stored before panels and layouts existed. */
function asItWasStoredBefore(): WorkspaceSnapshot {
  return {
    workspace: {
      id: 'ws-work',
      tenantId: 'tenant',
      name: 'Work',
      color: '#6f62b5',
      ground: '#e3e1f2',
      header: '#d2cdea',
    },
    items: [],
    dashboards: [{ id: 'today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' }],
    associations: [],
    generatedAt: '2026-09-02T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

describe('Panels', () => {
  describe('a dashboard opens from a stored copy made before panels existed', () => {
    it('shows an empty dashboard rather than nothing at all', async () => {
      // The stored copy is rehydrated from IndexedDB without being parsed
      // again (main.tsx), so somebody who had Cockpit open before this landed
      // opens it afterwards holding a snapshot with no `panels` at all. Reading
      // straight through it is a blank screen, and worst of all offline, where
      // no answer is coming to repair it.
      held.snapshot = asItWasStoredBefore();

      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <DashboardPage />
        </QueryClientProvider>,
      );

      expect(
        await screen.findByText(/A dashboard holds the panels you want in view/),
      ).toBeVisible();
    });
  });
});
