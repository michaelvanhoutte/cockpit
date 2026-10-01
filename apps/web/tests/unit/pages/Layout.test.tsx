import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../../../src/pages/Layout';

/**
 * F1, and one case only. This is not a test of React's escaping, which is
 * framework mechanics and would be cut - it guards the one way Cockpit can undo
 * that escaping itself. Nothing in the codebase reaches for
 * `dangerouslySetInnerHTML` today, and this is what would go red on the day
 * something does, on the screen where every workspace name in the tenant is
 * rendered ("Workspace names are only case-insensitive in ASCII", issue 91).
 */
const A_NAME_THAT_LOOKS_LIKE_MARKUP = '<img src=x onerror=alert(1)>';

/**
 * What the person the shell is drawn for holds. `vi.mock` is hoisted above
 * everything, so the mock reads this rather than closing over a value fixed
 * before a case can set it.
 */
let signedInRole = 'user';

/** The workspace the router says is open; none, unless a case opens one. */
let openWorkspaceId: string | undefined;

// Put back after every case, so a case added later renders the shell for the
// ordinary user it reads as rather than for whichever role ran last.
afterEach(() => {
  signedInRole = 'user';
  openWorkspaceId = undefined;
});

// The router itself is not under test, and `to`/`params` are its props rather
// than an anchor's, so they stop here instead of being spread onto the DOM.
// **Everything else is passed through**, which the real Link also does and this
// mock once did not: a menu entry renders its Link with `asChild`, so the role
// that makes it a menu entry arrives as a prop and a mock that dropped it made
// the entry invisible to a test looking for one.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    params?: unknown;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...rest}>{children}</a>,
  Outlet: () => null,
  useParams: () => (openWorkspaceId ? { workspaceId: openWorkspaceId } : {}),
  useNavigate: () => () => Promise.resolve(),
  // No item named, so the shell draws no form over itself - these cases are
  // about the chrome.
  useSearch: () => ({}),
  // Read by the shell to know whether Capture is the page you are on. These
  // cases are inside a workspace, which is never that page.
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/w/a-workspace' } }),
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));

vi.mock('../../../src/api/queries', () => ({
  // The users window is drawn for an admin and is shut here, but it is mounted.
  registeredUsersQuery: { queryKey: ['registeredUsers'], queryFn: () => Promise.resolve({ users: [] }) },
  accountHoldingsQuery: (userId: string) => ({ queryKey: ['accountHoldings', userId], queryFn: () => Promise.resolve({ workspaces: 0, empty: true }) }),
  useAddUser: () => ({ mutate: () => undefined, isPending: false, error: null, data: undefined }),
  useChangeUser: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
  useSetAccess: () => ({ mutate: () => undefined, isPending: false, error: null }),
  useDeleteUser: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
  // The types window the shell now draws over the workspace reads them
  // (pages/Layout.tsx). It is shut in these cases, but it is mounted.
  itemTypesQuery: { queryKey: ['itemTypes'], queryFn: () => Promise.resolve({ itemTypes: [] }) },
  // The shell draws the account's management windows over the workspace
  // (pages/Layout.tsx). They are shut here - nothing in these cases opens
  // one - but they are mounted, so the hooks they call have to answer.
  useCommand: () => ({ mutate: () => undefined, isPending: false, error: null, reset: () => undefined }),
  // Read by every control that names a change, to say why the last one did
  // not happen (api/queries.ts).
  refusalFrom: () => null,
  useSendCommand: () => () => Promise.resolve({ ok: true, applied: true }),
  // Signed in, so the shell renders rather than sending itself to the logon
  // page - which is what this case needs on screen to look at. The role is
  // read per case, because what the menu offers depends on it.
  meQuery: {
    queryKey: ['me'],
    queryFn: () => Promise.resolve({ user: { id: 'user-michael', name: 'Michael', role: signedInRole } }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [
          {
            id: 'ws-markup',
            tenantId: 'tenant',
            name: '<img src=x onerror=alert(1)>',
            color: '#6f62b5', ground: '#e3e1f2', header: '#d2cdea',
          },
        ],
      }),
  },
  // Read by the shell so a workspace that cannot be read is said once rather
  // than by each thing reading it; this case is about the tab, so it answers.
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: [], dashboards: [] }),
  }),
}));

describe('Workspace management', () => {
  describe('a workspace name is shown as text, never as markup', () => {
    it('puts the characters in the tab and builds nothing out of them', async () => {
      const { container } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      expect(await screen.findByText(A_NAME_THAT_LOOKS_LIKE_MARKUP)).toBeVisible();
      expect(container.querySelector('img')).toBeNull();
    });
  });

  describe('the account\u2019s list of types opens over the workspace rather than replacing it', () => {
    it.each(['Manage types', 'MCP connections'])('opens %s from the header\u2019s menu', async (entry) => {
      // It was a page, and reaching one took the shell somewhere it has no
      // state for: no workspace to colour the header, fill a tab or offer
      // Capture\u2026 So the header stays exactly as it is and the list is drawn
      // over it.
      //
      // The workspaces are no longer beside it: a workspace is changed on its
      // own tab, which tests/unit/components/WorkspaceTabs.test.tsx holds.
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      const { container } = render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));
      await user.click(await screen.findByRole('menuitem', { name: entry }));

      expect(await screen.findByRole('dialog', { name: entry })).toBeVisible();
      // The workspace is still behind it, tab and all: the point of a window
      // over the shell is that the shell does not change. Queried through the
      // DOM rather than by role, because an open modal hides everything behind
      // it from assistive technology - which is exactly what it should do, and
      // is not the same as the shell having gone.
      const header = container.querySelector('header')!;
      expect(within(header).getByText(A_NAME_THAT_LOOKS_LIKE_MARKUP)).toBeInTheDocument();
    });
  });

  describe('the account is not offered a way to hand-write what Cockpit learns from', () => {
    it('has neither entry in the workspace’s menu', async () => {
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));

      expect(await screen.findByRole('menuitem', { name: 'Manage types' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'What Cockpit is told' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'What Cockpit has learned' })).toBeNull();
    });
  });
});

describe('Across the app', () => {
  describe('the header splits its menu into the account’s settings and who you are', () => {
    // "Give the open workspace and dashboard their own ‘…’, and
    // split the header's menu into settings and you", issue 567: the one menu
    // used to carry the account's settings and the signed-in person together,
    // which is not the same job twice.
    it('ends the open workspace’s menu with the account’s entries under a separator, and has no gear', async () => {
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      expect(screen.queryByRole('button', { name: 'Account settings' })).toBeNull();
      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Manage connections…',
        'Delete',
        'Manage types',
        'MCP connections',
        'Hide the agents’ dock',
      ]);
      expect(screen.getByRole('separator')).toBeInTheDocument();
    });

    it('offers the account’s entries on no tab’s own menu', async () => {
      openWorkspaceId = 'ws-markup';
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      fireEvent.contextMenu(await screen.findByText(A_NAME_THAT_LOOKS_LIKE_MARKUP));

      expect((await screen.findAllByRole('menuitem')).map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Manage connections…',
        'Delete',
      ]);
    });

    it('gives the focus back to the “…” when the types window closes', async () => {
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );
      const dots = () =>
        screen.getByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` });

      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Manage types' }));
      await screen.findByRole('dialog', { name: 'Manage types' });
      await user.keyboard('{Escape}');

      await waitFor(() => expect(dots()).toHaveFocus());
    });

    it('hides and shows the agents’ dock from the entry, keeping the focus on the “…”', async () => {
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );
      const dots = () =>
        screen.getByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` });

      await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` });
      await user.click(dots());
      await user.click(await screen.findByRole('menuitem', { name: 'Hide the agents’ dock' }));
      await waitFor(() => expect(dots()).toHaveFocus());

      await user.click(dots());
      await user.click(await screen.findByRole('menuitem', { name: 'Show the agents’ dock' }));
      await user.click(dots());
      expect(await screen.findByRole('menuitem', { name: 'Hide the agents’ dock' })).toBeVisible();
    });

    // Whether Admin joins these two is a question of role rather than of
    // where the entry lives, and is held once, below, in "User management".
    it('holds who you are behind the profile', async () => {
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(await screen.findByRole('button', { name: 'Profile' }));

      expect(await screen.findByText('Signed in as Michael')).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Manage types' })).toBeNull();
    });

    it('shows the signed-in person’s initial on the profile control', async () => {
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Profile' })).toHaveTextContent('M'),
      );
    });
  });
});

describe('User management', () => {
  describe('the way into it is offered to an admin and to nobody else', () => {
    /**
     * Hiding it is a courtesy rather than the guard - the server refuses an
     * ordinary user who reaches it (`auth/admin.ts`) - but a door that only
     * ever says no is worse than no door, which is what this holds. It sits
     * with the account's other settings, not under the person's own menu.
     */
    it.each([
      { situation: 'an admin', role: 'admin', offered: true },
      { situation: 'an ordinary user', role: 'user', offered: false },
    ])('offers it to $situation: $offered', async ({ role, offered }) => {
      signedInRole = role;
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(
        await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }),
      );
      // Awaited on something that is always there, so the absent case is a
      // menu that has finished opening rather than one that has not started.
      expect(await screen.findByRole('menuitem', { name: 'Manage types' })).toBeVisible();

      expect(screen.queryByRole('menuitem', { name: 'Manage users' }) !== null).toBe(offered);
    });

    it('puts it last, under a separator of its own', async () => {
      signedInRole = 'admin';
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(
        await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }),
      );
      await screen.findByRole('menuitem', { name: 'Manage users' });

      const entries = screen.getAllByRole('menuitem');
      const separators = screen.getAllByRole('separator');
      expect(entries.at(-1)).toHaveTextContent('Manage users');
      expect(separators.at(-1)!.nextElementSibling).toBe(entries.at(-1));
    });

    it('opens it as a window over the workspace', async () => {
      signedInRole = 'admin';
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(
        await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }),
      );
      await user.click(await screen.findByRole('menuitem', { name: 'Manage users' }));

      expect(await screen.findByRole('dialog', { name: 'Manage users' })).toBeVisible();
    });

    it('does not put it under the profile menu', async () => {
      signedInRole = 'admin';
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeVisible();

      expect(screen.queryByRole('menuitem', { name: 'Admin' })).toBeNull();
    });
  });
});