import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../../../src/pages/Layout';

/**
 * F1, and composed on purpose: this is a rule about what several components do
 * *together*, so each of them proving its own half would have gone on passing
 * through the whole bug. The Inbox column and the dashboard both read the one
 * snapshot, and each used to say so, which put the same words on screen twice
 * in two different widths for one failed read.
 *
 * The browser is not needed to count notices, so it is not used to
 * ("Pick the level" in the testing skill); the one thing only F3 holds - the
 * real router deciding which screen is under the shell - is the single
 * assertion added to tests/e2e/load-failure.test.ts.
 */

const SNAPSHOT = {
  items: [
    {
      id: 'item-1',
      title: 'Something still to deal with',
      completedAt: null,
      nextAction: null,
      source: 'internal',
      sender: null,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
  ],
  filings: [],
  dashboards: [{ id: 'dash-1', name: 'Today' }],
  panels: [],
  layouts: [],
};

const params: { workspaceId?: string; dashboardId?: string } = {
  workspaceId: 'ws-1',
  dashboardId: 'dash-1',
};

/** Whether this screen is wide enough for the Inbox to have a column. */
let room = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  // Nothing: the shell is what is under test, and neither place this rule is
  // asked about puts a screen of its own inside it.
  Outlet: () => null,
  useParams: () => params,
  useNavigate: () => () => Promise.resolve(),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));
vi.mock('../../../src/components/DashboardBar', () => ({ DashboardBar: () => null }));

// jsdom has no `matchMedia`, so the shell would answer "no room" for every case
// and the Inbox column - the second voice this rule is about - would never be
// on screen to stay quiet.
vi.mock('../../../src/roomForTheInbox', () => ({
  useRoomForTheInbox: () => room,
  roomForTheInbox: () => room,
}));

/**
 * A workspace that was read once and cannot be read again: the copy in hand
 * still paints, and every refresh behind it fails. That is the situation in
 * front of somebody whose connection went, or whose deployment is unwell - and
 * the one the local copy exists for, so nothing may blank the screen over it.
 */
vi.mock('../../../src/api/queries', () => ({
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { id: 'user-michael', name: 'Michael' } }),
  },
  // The header's capture window reads the account's types ('Capture something
  // before you know which workspace it belongs to', issue 165). Empty here:
  // what the window offers is CaptureForm's, proved on CaptureForm.
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () => Promise.resolve({ itemTypes: [] }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [
          {
            id: 'ws-1',
            tenantId: 'tenant',
            name: 'Work',
            color: '#6f62b5',
            bar: '#cdc7e8',
            ground: '#e3e1f2',
            header: '#d2cdea',
          },
        ],
      }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.reject(new Error('snapshot failed: 500')),
    initialData: SNAPSHOT,
    initialDataUpdatedAt: 0,
  }),
  useCommand: () => ({ mutate: () => undefined, isPending: false }),
  useSendCommand: () => () => Promise.resolve(),
}));

function theWorkspace() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Layout />
    </QueryClientProvider>,
  );
}

describe('Offline', () => {
  describe('a workspace that cannot be read says so once, wherever you are in it', () => {
    const places = [
      { situation: 'on a dashboard, with the Inbox in its column beside it', room: true },
      // Managing the dashboards was a third place here, being a screen inside
      // the workspace reading the same snapshot. It is a dialog over one of
      // these two now (components/ManageDashboards.tsx), so it is not a place
      // this rule can be asked about - and the shell's outlet, which that case
      // was the only one to fill, holds nothing in either of the two left.
      {
        // Too narrow for a column, so the Inbox is a screen of its own - which
        // is the same Inbox, reading the same snapshot, one layer down.
        situation: 'on a screen too narrow for the Inbox to have a column',
        room: false,
      },
    ];

    it.each(places)('$situation', async ({ room: wide }) => {
      room = wide;
      theWorkspace();

      await waitFor(() =>
        expect(screen.getAllByRole('heading', { name: 'Cockpit is having trouble' })).toHaveLength(
          1,
        ),
      );
    });

    it('keeps showing the work it already has behind the notice', async () => {
      room = true;
      theWorkspace();

      expect(await screen.findByRole('heading', { name: 'Cockpit is having trouble' })).toBeVisible();
      // Reading what you already have is what the local copy is for
      // (functional definition, "Offline / local-first behavior").
      expect(screen.getByText('Something still to deal with')).toBeVisible();
    });
  });
});
