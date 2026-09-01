import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { Workspace } from '@cockpit/shared';
import { createAppRouter } from '../../src/router';
import { fetchSnapshot, fetchWorkspaces } from '../../src/api/client';

/**
 * F1: where the app sends you is a decision the router makes from the list of
 * workspaces, and both ends of that are replaced here - the reads at the API
 * client, the history in memory. What it cannot prove is that a real browser's
 * Back button lands on it, which is the one walk in
 * tests/e2e/workspace-management.test.ts.
 *
 * Stated as what is on screen rather than as which route resolved: a redirect
 * to a route whose page does not render leaves someone looking at nothing, and
 * a test of the redirect alone would pass through that.
 */
vi.mock('../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/api/client')>()),
  fetchWorkspaces: vi.fn(),
  fetchSnapshot: vi.fn(),
}));

const readsWorkspaces = vi.mocked(fetchWorkspaces);
const readsSnapshot = vi.mocked(fetchSnapshot);

const work: Workspace = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea' };
const personal: Workspace = { id: 'ws-personal', tenantId: 'tenant', name: 'Personal', color: '#c06a45', ground: '#f2e5d4', header: '#ead2b3' };

/** Opens the app at `at`, with `have` as the workspaces there are. */
async function open(at: string, have: Workspace[]) {
  readsWorkspaces.mockResolvedValue({ workspaces: have });
  // A workspace that is not there has no snapshot, exactly as the server has
  // none for it. Answering anyway would let a page for a deleted workspace
  // render, and every case below would pass whether or not it redirected.
  readsSnapshot.mockImplementation((workspaceId) => {
    const workspace = have.find((w) => w.id === workspaceId);
    return workspace
      ? Promise.resolve({
          workspace,
          items: [],
          associations: [],
          generatedAt: '2026-08-31T10:00:00.000Z',
        })
      : Promise.reject(new Error(`snapshot failed: 404`));
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Through the address bar jsdom already has, rather than by replacing the
  // router's history after it was built: the app's own router is what is under
  // test, and one built differently from the real one proves less.
  window.history.pushState({}, '', at);
  const router = createAppRouter(queryClient);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** jsdom has no EventSource, and the app shell opens one on every route. */
class NoStream {
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', NoStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Workspace management', () => {
  describe('the app opens somewhere you can work, whatever workspaces you have', () => {
    it('opens the first workspace you have', async () => {
      await open('/', [work, personal]);

      expect(await screen.findByLabelText('Capture a note or to-do')).toBeVisible();
    });

    it('opens another workspace when the one asked for is no longer there', async () => {
      await open('/w/ws-deleted', [work, personal]);

      expect(await screen.findByLabelText('Capture a note or to-do')).toBeVisible();
    });

    it.each([
      { situation: 'from the start page', at: '/' },
      { situation: 'from a workspace that has been deleted', at: '/w/ws-deleted' },
    ])('invites you to make one when you have none, $situation', async ({ at }) => {
      await open(at, []);

      // The invitation is the box you type the name into, not a screen whose
      // only content is a link to it.
      expect(await screen.findByLabelText('Name of the new workspace')).toBeVisible();
      expect(screen.getByText('No workspaces yet. Make your first one below.')).toBeVisible();
    });
  });
});
