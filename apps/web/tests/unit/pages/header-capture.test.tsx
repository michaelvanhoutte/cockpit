import { describe, expect, it, vi } from 'vitest';
import { render, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../../../src/pages/Layout';

/**
 * F1: where Capture is in the header, and what it opens. That the page it opens
 * captures anything is tests/unit/pages/CapturePage.test.tsx, and the walk from
 * this tab to a note in the Inbox is tests/e2e/workspace-capture.test.ts.
 */
const params: { workspaceId?: string } = {};
const held = { workspaces: [] as unknown[] };

const WORK = {
  id: 'ws-work',
  tenantId: 'tenant',
  name: 'Work',
  color: '#6f62b5',
  bar: '#dbd7ee',
  ground: '#e3e1f2',
  header: '#d2cdea',
};

// The address is what this file is about, so the mock renders `to` as one.
const at = { pathname: '/capture' };

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    style,
    to,
  }: {
    children?: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    to?: string;
  }) => (
    <a href={to} className={className} style={style}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="the-page" />,
  useParams: () => params,
  useNavigate: () => () => Promise.resolve(),
  useSearch: () => ({}),
  // The address, because the shell asks which page this is rather than whether
  // a workspace is named: Capture is in no workspace either.
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: at.pathname } }),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));
vi.mock('../../../src/components/DashboardBar', () => ({ DashboardBar: () => null }));
vi.mock('../../../src/components/InboxPanel', () => ({
  InboxPanel: () => null,
  InboxHeading: () => null,
}));

vi.mock('../../../src/api/queries', () => ({
  // The shell draws the account's two management windows over the workspace
  // (pages/Layout.tsx). They are shut here - nothing in these cases opens
  // one - but they are mounted, so the hooks they call have to answer.
  useCommand: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
  useSendCommand: () => () => Promise.resolve({ ok: true, applied: true }),
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { id: 'user-michael', name: 'Michael' } }),
  },
  itemTypesQuery: { queryKey: ['itemTypes'], queryFn: () => Promise.resolve({ itemTypes: [] }) },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: [], dashboards: [] }),
  }),
}));

async function theShell({
  workspaces = [WORK],
  // Null, not undefined: `inside: undefined` would take the default below and
  // quietly render the case it is meant to be the opposite of.
  inside = 'ws-work' as string | null,
  address = '/capture',
}: { workspaces?: unknown[]; inside?: string | null; address?: string } = {}) {
  held.workspaces = workspaces;
  at.pathname = address;
  if (inside) params.workspaceId = inside;
  else delete params.workspaceId;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <Layout />
    </QueryClientProvider>,
  );
  // Waited for on the list itself rather than on something drawn from it: one
  // case is about the header holding *nothing*, and a list that has not
  // arrived yet looks exactly like that.
  await waitFor(() => expect(client.getQueryData(['workspaces'])).toBeDefined());
  return { header: within(container.querySelector('header')!), container };
}

describe('Capture', () => {
  describe('capture is the first tab in the header wherever there is a workspace to capture from', () => {
    it('opens the capture page, ahead of the workspaces and outside their strip', async () => {
      const { header } = await theShell();

      const capture = header.getByRole('link', { name: 'Capture' });
      expect(capture).toHaveAttribute('href', '/capture');
      // Not one of the workspaces: what it captures belongs to none of them.
      expect(
        within(header.getByRole('navigation', { name: 'Workspaces' })).queryByText('Capture'),
      ).toBeNull();
    });

    it('is still there on a screen outside every workspace, which is where you go back from', async () => {
      const { header } = await theShell({ inside: null });

      expect(header.getByRole('link', { name: 'Capture' })).toBeInTheDocument();
    });

    it('is gone for an account with no workspaces, which has nowhere to capture from', async () => {
      const { header } = await theShell({ workspaces: [] });

      expect(header.queryByRole('link', { name: 'Capture' })).toBeNull();
    });
  });

  /**
   * Capture is in no workspace, which is what it means - and the band under the
   * workspace tabs and the column under that both used to read "no workspace"
   * as "a settings page", so the page came up with Manage workspaces and Manage
   * types over it and its sheet squeezed into a column of prose width. Found in
   * the browser on staging.
   *
   * The settings row is here rather than in a file of its own because it is
   * what makes this falsifiable: the band and the column still do the settings
   * thing, on the addresses that are settings.
   *
   * jsdom lays nothing out, so the column is read off the class that constrains
   * it - which is the whole of what that wrapper is.
   */
  describe('the capture page is a sheet like every other screen under the shell', () => {
    // The case that told it apart from a settings page is gone with the
    // settings pages: the account's lists are windows over the workspace now
    // (components/ManageWindow.tsx), so no address is drawn any differently
    // and there is nothing left for capture to be mistaken for.
    it('keeps the band, so the chrome is the same height as everywhere else', async () => {
      // Empty rather than absent: the band gained its minimum height so that
      // leaving a workspace does not take forty pixels off the chrome, and a
      // page drawn without one would put them straight back.
      const { container } = await theShell({ inside: null, address: '/capture' });

      const band = container.querySelector('header + div');
      expect(band).not.toBeNull();
      expect(band!.className).toContain('min-h-11');
      expect(band!.textContent).toBe('');
    });
  });
});
