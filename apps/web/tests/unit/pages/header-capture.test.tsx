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
  Outlet: () => null,
  useParams: () => params,
  useNavigate: () => () => Promise.resolve(),
  useSearch: () => ({}),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));
vi.mock('../../../src/components/DashboardBar', () => ({ DashboardBar: () => null }));
vi.mock('../../../src/components/InboxPanel', () => ({
  InboxPanel: () => null,
  InboxHeading: () => null,
}));

vi.mock('../../../src/api/queries', () => ({
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
}: { workspaces?: unknown[]; inside?: string | null } = {}) {
  held.workspaces = workspaces;
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
  return within(container.querySelector('header')!);
}

describe('Capture', () => {
  describe('capture is the first tab in the header wherever there is a workspace to capture from', () => {
    it('opens the capture page, ahead of the workspaces and outside their strip', async () => {
      const header = await theShell();

      const capture = header.getByRole('link', { name: 'Capture' });
      expect(capture).toHaveAttribute('href', '/capture');
      // Not one of the workspaces: what it captures belongs to none of them.
      expect(
        within(header.getByRole('navigation', { name: 'Workspaces' })).queryByText('Capture'),
      ).toBeNull();
    });

    it('is still there on a screen outside every workspace, which is where you go back from', async () => {
      const header = await theShell({ inside: null });

      expect(header.getByRole('link', { name: 'Capture' })).toBeInTheDocument();
    });

    it('is gone for an account with no workspaces, which has nowhere to capture from', async () => {
      const header = await theShell({ workspaces: [] });

      expect(header.queryByRole('link', { name: 'Capture' })).toBeNull();
    });
  });
});
