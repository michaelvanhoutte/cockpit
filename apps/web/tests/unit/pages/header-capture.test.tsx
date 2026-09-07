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

/** The address the shell is rendered at, which is what says which tab is on. */
const at = { pathname: '/w/ws-work' };

const WORK = {
  id: 'ws-work',
  tenantId: 'tenant',
  name: 'Work',
  color: '#6f62b5',
  bar: '#dbd7ee',
  ground: '#e3e1f2',
  header: '#d2cdea',
};

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
  // The address, because which tab is filled is a question about the page you
  // are on rather than about the workspace you are in: capture is in none.
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
  // Read by every control that names a change, to say why the last one did
  // not happen (api/queries.ts).
  refusalFrom: () => null,
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
  // Derived rather than defaulted on its own, so a case cannot ask for a shell
  // the router could not produce - capture carries no workspace, and a
  // workspace address is never capture. Named only where a case is about it.
  address = inside ? `/w/${inside}` : '/capture',
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

/** The color an element is filled with, as the browser reports it back. */
function filledWith(element: Element | null | undefined): string {
  return (element as HTMLElement | null)?.style.backgroundColor ?? '';
}

describe('Capture', () => {
  /**
   * Which tab reads as the page you are on. The tab wore the selected look at
   * all times, and the app opens inside a workspace, so on startup two tabs
   * claimed to be the screen you were looking at; the reason it no longer does
   * is in pages/Layout.tsx, at the tab itself.
   *
   * jsdom lays nothing out, so "reads as selected" is the fill and the weight
   * it is drawn with, which is the whole of what the shell decides.
   */
  describe('capture wears the selected look only while you are on it', () => {
    it('is quiet while you are in a workspace, which is where the app opens', async () => {
      const { header } = await theShell({ inside: 'ws-work' });

      const capture = header.getByRole('link', { name: 'Capture' });
      expect(filledWith(capture)).toBe('');
      expect(capture.className).toContain('text-chrome-ink-soft');
      expect(capture.className).not.toContain('font-medium');
    });

    it('fills with the band’s own color on the capture page, so it runs into the strip below', async () => {
      const { header, container } = await theShell({ inside: null, address: '/capture' });

      const band = container.querySelector('header + div');
      expect(filledWith(band)).not.toBe('');
      const capture = header.getByRole('link', { name: 'Capture' });
      expect(filledWith(capture)).toBe(filledWith(band));
      expect(capture.className).toContain('font-medium');
    });
  });

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
   * workspace tabs once read "no workspace" as "a settings page", so Manage
   * workspaces and Manage types came up over it and its sheet squeezed into a
   * column of prose width. Found in the browser on staging.
   *
   * The case that told capture apart from a settings page went with the
   * settings pages: the account's lists are windows over the workspace now
   * (components/ManageWindow.tsx), so no address is drawn differently from any
   * other and there is nothing left for capture to be mistaken for. What is
   * left to hold is the height, which is what that bug cost.
   */
  describe('the capture page is a sheet like every other screen under the shell', () => {
    it('keeps the band, so the chrome is the same height as everywhere else', async () => {
      // Empty rather than absent: the band gained its minimum height so that
      // leaving a workspace does not take forty pixels off the chrome, and a
      // page drawn without one would put them straight back.
      const { container } = await theShell({ inside: null });

      const band = container.querySelector('header + div');
      expect(band).not.toBeNull();
      expect(band!.className).toContain('min-h-11');
      expect(band!.textContent).toBe('');
    });
  });
});
