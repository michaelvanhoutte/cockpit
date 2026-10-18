import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { DashboardPage } from '../../../src/pages/DashboardPage';
import { forgetEverySavedRead, restoreSavedReads, saveRead } from '../../../src/persistence';
import { aWorkspace, anItem } from '../support/savedReads';

/**
 * F1: what is under test is the page reading a stored copy kept by an older
 * version. Everything the dashboard then does with those panels is
 * the board's, and is proved in tests/unit/components/PanelBoard.test.tsx.
 */

const held = vi.hoisted(() => ({
  snapshot: {} as unknown as WorkspaceSnapshot,
  /** What the server does when asked: answer the held snapshot, or never answer. */
  answers: true,
}));

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
      queryFn: () => (held.answers ? Promise.resolve(held.snapshot) : new Promise<never>(() => {})),
    }),
  };
});

describe('Offline', () => {
  describe('the board says how many Items a saved Workspace left out, as saved by an older version', () => {
    const older = (n: number) => ({ ...anItem(n), preview: 'old text' });
    const onTheDashboard = { dashboards: [{ id: 'today', tenantId: 'tenant', workspaceId: 'ws-work', name: 'Today' }], panels: [] };

    it.each([
      { situation: 'every Item converts', items: [anItem(1), anItem(2), anItem(3)], answers: false, note: null },
      {
        situation: 'one of three Items fails',
        items: [anItem(1), older(2), anItem(3)],
        answers: false,
        note: "1 Item was saved by an older version and can't be shown offline.",
      },
      {
        situation: 'two of three Items fail',
        items: [older(1), older(2), anItem(3)],
        answers: false,
        note: "2 Items were saved by an older version and can't be shown offline.",
      },
      { situation: 'the server has answered since', items: [anItem(1), older(2)], answers: true, note: null },
    ])('$situation', async ({ items, answers, note }) => {
      await forgetEverySavedRead();
      await saveRead({ queryKey: ['snapshot', 'ws-work'], data: aWorkspace(items, onTheDashboard), savedAt: Date.now() - 60_000 });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await restoreSavedReads(client);
      held.snapshot = aWorkspace([anItem(1)], onTheDashboard);
      held.answers = answers;

      render(
        <QueryClientProvider client={client}>
          <DashboardPage />
        </QueryClientProvider>,
      );

      expect(await screen.findByText(/A dashboard holds the panels you want in view/)).toBeInTheDocument();
      if (note) expect(screen.getByRole('status')).toHaveTextContent(note);
      else await waitFor(() => expect(screen.queryByText(/saved by an older version/)).toBeNull());
    });
  });
});