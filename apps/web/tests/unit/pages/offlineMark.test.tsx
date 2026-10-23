import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { changes } from '../../../src/api/changes';
import { sendCommand } from '../../../src/api/client';
import { Layout } from '../../../src/pages/Layout';
import { CHOSEN_KEY, currentStanding, resetStanding, stand } from '../../../src/offline';

/**
 * F1: the header's Offline mark and the account menu's Work offline / Go online.
 * The shell is drawn with the router, the stream and the queries stubbed, since
 * these cases are about what the header shows for each standing.
 */
const params: { workspaceId?: string } = { workspaceId: 'ws-a' };
const SAVED_AT = new Date(2026, 9, 17, 14, 32).getTime();
const savedTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(SAVED_AT));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  Outlet: () => null,
  useParams: () => params,
  useNavigate: () => () => Promise.resolve(),
  useSearch: () => ({}),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/w/ws-a' } }),
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));
vi.mock('../../../src/components/DashboardBar', () => ({ DashboardBar: () => null }));
vi.mock('../../../src/components/InboxPanel', () => ({
  InboxPanel: () => null,
  InboxHeading: ({ id }: { id?: string }) => <h2 id={id}>Inbox</h2>,
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
  refusalFrom: () => null,
  useSendCommand: () => () => Promise.resolve({ ok: true, applied: true }),
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { id: 'user-michael', name: 'Michael', role: 'user' } }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [{ id: 'ws-a', tenantId: 'tenant', name: 'Alpha', color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' }],
      }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: [], dashboards: [] }),
  }),
}));

function theShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['snapshot', 'ws-a'], { items: [], dashboards: [] }, { updatedAt: SAVED_AT });
  render(
    <QueryClientProvider client={client}>
      <Layout />
    </QueryClientProvider>,
  );
  return screen.findByRole('button', { name: 'Profile' });
}

beforeEach(() => {
  resetStanding();
  params.workspaceId = 'ws-a';
});

afterEach(() => {
  resetStanding();
});

describe('Offline', () => {
  describe('the header shows the Offline mark exactly while offline, with when the read on screen was saved', () => {
    it('shows nothing while online', async () => {
      await theShell();

      expect(screen.queryByRole('button', { name: /Offline/ })).toBeNull();
    });

    it.each([
      { situation: 'found', standing: { found: true } },
      { situation: 'chosen', standing: { chosen: true } },
    ])('says Offline and when the Workspace on screen was saved, $situation', async ({ standing }) => {
      stand(standing);

      await theShell();

      const mark = screen.getByRole('button', { name: /Offline/ });
      expect(mark).toHaveTextContent(`Offline · saved ${savedTime}`);
    });

    it('hides the saved time below the sm breakpoint, which is a phone', async () => {
      stand({ chosen: true });

      await theShell();

      const time = screen.getByText(`· saved ${savedTime}`, { exact: false });
      expect(time).toHaveClass('hidden', 'sm:inline');
    });

    it('says only Offline where no Workspace is on screen', async () => {
      delete params.workspaceId;
      stand({ chosen: true });

      await theShell();

      expect(screen.getByRole('button', { name: /Offline/ })).toHaveTextContent(/^Offline$/);
    });

    it('opens the account menu when pressed', async () => {
      stand({ found: true });
      await theShell();

      await userEvent.setup().click(screen.getByRole('button', { name: /Offline/ }));

      expect(await screen.findByRole('menuitem', { name: 'Go online' })).toBeVisible();
    });
  });

  describe('the account menu offers Work offline, or Go online while offline', () => {
    it('offers Work offline online, and choosing it is remembered on this device', async () => {
      const user = userEvent.setup();
      await user.click(await theShell());

      await user.click(await screen.findByRole('menuitem', { name: 'Work offline' }));

      await vi.waitFor(() => expect(currentStanding().chosen).toBe(true));
      expect(localStorage.getItem(CHOSEN_KEY)).toBe('1');
      expect(await screen.findByRole('button', { name: /Offline/ })).toBeVisible();
    });

    it.each([
      { situation: 'chosen', standing: { chosen: true } },
      { situation: 'found', standing: { found: true } },
    ])('offers Go online above Sign out while $situation, and it clears the mark', async ({ standing }) => {
      stand(standing);
      localStorage.setItem(CHOSEN_KEY, '1');
      const user = userEvent.setup();
      await user.click(await theShell());
      const entries = (await screen.findAllByRole('menuitem')).map((entry) => entry.textContent);
      expect(entries.indexOf('Go online')).toBe(entries.indexOf('Sign out') - 1);

      await user.click(screen.getByRole('menuitem', { name: 'Go online' }));

      await vi.waitFor(() => expect(screen.queryByRole('button', { name: /Offline/ })).toBeNull());
      expect(localStorage.getItem(CHOSEN_KEY)).toBeNull();
    });
  });
});

describe('Item editing', () => {
  describe('the header shows the saving sign beside the account menu while a change waits', () => {
    it('draws it left of the account menu once a change has waited half a second, and takes it away when answered', async () => {
      let answer!: () => void;
      vi.mocked(sendCommand).mockImplementation(
        () => new Promise((resolve) => void (answer = () => resolve({ ok: true, applied: true }))),
      );
      const profile = await theShell();
      expect(screen.queryByRole('status', { name: /Saving/ })).toBeNull();

      void changes.enqueue({
        name: 'set_priority',
        payload: { commandId: 'c1', issuedAt: '2026-10-20T09:00:00.000Z', workspaceId: 'ws-a', itemId: 'i-1', priority: 'high' },
      });

      const sign = await screen.findByRole('status', { name: 'Saving 1 change…' }, { timeout: 2000 });
      expect(sign.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      answer();
      await vi.waitFor(() => expect(screen.queryByRole('status', { name: /Saving/ })).toBeNull());
      changes.forgetAnswered();
    });
  });
});
