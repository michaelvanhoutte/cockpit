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

/** The dashboard the router says is open; the dock is drawn only on one. */
let openDashboardId: string | undefined;

/** What the address carries after the path; the Teams sign-in return sets it. */
let searchParams: Record<string, string> = {};

/** Every move the shell asked the router for. */
const navigations: unknown[] = [];

// Put back after every case, so a case added later renders the shell for the
// ordinary user it reads as rather than for whichever role ran last.
afterEach(() => {
  signedInRole = 'user';
  openWorkspaceId = undefined;
  openDashboardId = undefined;
  searchParams = {};
  navigations.length = 0;
  localStorage.clear();
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
  useParams: () =>
    openWorkspaceId
      ? { workspaceId: openWorkspaceId, ...(openDashboardId ? { dashboardId: openDashboardId } : {}) }
      : {},
  useNavigate: () => (options: unknown) => {
    navigations.push(options);
    return Promise.resolve();
  },
  // No item named, so the shell draws no form over itself - these cases are
  // about the chrome.
  useSearch: () => searchParams,
  // Read by the shell to know whether Capture is the page you are on. These
  // cases are inside a workspace, which is never that page.
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/w/a-workspace' } }),
}));

// Drawn once a dashboard is open, and about the Inbox rather than the chrome
// these cases look at, so they stop here rather than being fed what they read.
vi.mock('../../../src/components/InboxPanel', () => ({
  InboxChip: () => null,
  InboxHeading: () => null,
  InboxPanel: () => null,
}));

vi.mock('../../../src/api/useServerEvents', () => ({ useServerEvents: () => undefined }));

vi.mock('../../../src/api/queries', () => ({
  // What Platform settings reads, in the cases that open it as an admin.
  registeredUsersQuery: { queryKey: ['registeredUsers'], queryFn: () => Promise.resolve({ users: [] }) },
  usageQuery: (days: number) => ({ queryKey: ['usage', days], queryFn: () => Promise.resolve({ days, analyticsUrl: null, named: [], guests: { perDay: [], byCountry: [], byReferrer: [] } }) }),
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
  // Read by the sections of Settings (components/SettingsWindow.tsx).
  useConnectClaudeCode: () => ({ mutate: () => undefined, isPending: false, error: null, data: undefined, reset: () => undefined }),
  useTestClaudeCodeConnection: () => ({ mutate: () => undefined, isPending: false }),
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

      expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'What Cockpit is told' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'What Cockpit has learned' })).toBeNull();
    });
  });
});

describe('Across the app', () => {
  /** A desk-sized screen, which is where Settings is offered at all. */
  const onADesk = (matches: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  const shell = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Layout />
      </QueryClientProvider>,
    );

  describe('Settings holds the account’s types, Teams connection, agent connection and MCP apps, and none stays on the workspace’s menu', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      { situation: 'a desk-sized screen', desk: true, offered: true },
      { situation: 'a phone-width screen', desk: false, offered: false },
    ])('offers Settings… on the profile menu on $situation: $offered', async ({ desk, offered }) => {
      onADesk(desk);
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      // Awaited on something that is always there, so the absent case is a
      // menu that has finished opening rather than one that has not started.
      expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeVisible();

      expect(screen.queryByRole('menuitem', { name: 'Settings…' }) !== null).toBe(offered);
    });

    it('puts Settings… between who you are and Sign out', async () => {
      onADesk(true);
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      await screen.findByRole('menuitem', { name: 'Settings…' });

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Settings…',
        'Sign out',
        '© 2026 Conselit · conselit.be',
      ]);
    });

    it.each(['Manage types', 'MCP connections', 'Manage connections…'])(
      'leaves %s off the open workspace’s “…”',
      async (entry) => {
        onADesk(true);
        openWorkspaceId = 'ws-markup';
        const user = userEvent.setup();
        shell();

        await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));
        expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();

        expect(screen.queryByRole('menuitem', { name: entry })).toBeNull();
      },
    );

    it('opens over the workspace rather than replacing it, and gives the focus back to the profile control', async () => {
      onADesk(true);
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      const { container } = shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Settings…' }));

      const settings = await screen.findByRole('dialog', { name: 'Settings' });
      expect(within(settings).getByRole('button', { name: 'Types' })).toHaveFocus();
      // Behind it, tab and all: queried through the DOM, because an open modal
      // hides everything behind it from assistive technology.
      expect(
        within(container.querySelector('header')!).getByText(A_NAME_THAT_LOOKS_LIKE_MARKUP),
      ).toBeInTheDocument();

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.getByRole('button', { name: 'Profile' })).toHaveFocus());
    });
  });

  describe('the dock’s menus offer Agent settings', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('opens Settings on Agent settings from the dock’s “…”', async () => {
      onADesk(true);
      openWorkspaceId = 'ws-markup';
      openDashboardId = 'dash-1';
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'What is hidden here' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Agent settings…' }));

      const settings = await screen.findByRole('dialog', { name: 'Settings' });
      await waitFor(() => expect(within(settings).getByRole('button', { name: 'Agent settings' })).toHaveFocus());
      expect(settings.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    });

    it('offers it on a right-click on the dock too', async () => {
      onADesk(true);
      openWorkspaceId = 'ws-markup';
      openDashboardId = 'dash-1';
      shell();

      fireEvent.contextMenu(await screen.findByRole('toolbar', { name: 'Agents' }));

      expect(await screen.findByRole('menuitem', { name: 'Agent settings…' })).toBeVisible();
    });
  });

  describe('coming back from Microsoft reopens Settings on Connections', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      { situation: 'it connected', outcome: 'connected', said: 'Connected.' },
      { situation: 'it was refused', outcome: 'refused', said: /Nothing was stored/ },
    ])('$situation: says so, and clears the address so Back does not reopen it', async ({ outcome, said }) => {
      onADesk(true);
      openWorkspaceId = 'ws-markup';
      searchParams = { connections: outcome };
      shell();

      const settings = await screen.findByRole('dialog', { name: 'Settings' });
      expect(await within(settings).findByText(said)).toBeVisible();
      expect(within(settings).getByRole('button', { name: 'Connections' })).toHaveFocus();
      expect(navigations).toHaveLength(1);
      const [left] = navigations as { replace: boolean; search: (was: object) => object }[];
      expect(left!.replace).toBe(true);
      expect(left!.search({ connections: outcome, item: 'i-1' })).toEqual({ item: 'i-1' });
    });

    it('opens nothing for a workspace this person cannot see, and still clears the address', async () => {
      onADesk(true);
      openWorkspaceId = 'ws-somebody-elses';
      searchParams = { connections: 'connected' };
      shell();

      await waitFor(() => expect(navigations).toHaveLength(1));
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    });
  });

  describe('the header splits its menu into the account’s settings and who you are', () => {
    // "Give the open workspace and dashboard their own ‘…’, and
    // split the header's menu into settings and you", issue 567: the one menu
    // used to carry the account's settings and the signed-in person together,
    // which is not the same job twice.
    it('ends the open workspace’s menu with its own actions, and has no gear', async () => {
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      shell();

      expect(screen.queryByRole('button', { name: 'Account settings' })).toBeNull();
      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Delete',
      ]);
    });

    it('offers the same on the open workspace’s own tab, and the account’s entries on no tab’s menu', async () => {
      openWorkspaceId = 'ws-markup';
      shell();

      fireEvent.contextMenu(await screen.findByText(A_NAME_THAT_LOOKS_LIKE_MARKUP));

      expect((await screen.findAllByRole('menuitem')).map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Delete',
      ]);
    });

    // Whether Admin joins these two is a question of role rather than of
    // where the entry lives, and is held once, below, in "User management".
    it('holds who you are behind the profile', async () => {
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));

      expect(await screen.findByText('Signed in as Michael')).toBeVisible();
      expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
      expect(screen.queryByRole('menuitem', { name: 'Manage types' })).toBeNull();
    });

    it('shows the signed-in person’s initial on the profile control', async () => {
      shell();

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Profile' })).toHaveTextContent('M'),
      );
    });
  });
});

describe('User management', () => {
  /** A desk-sized screen, which is where Platform settings is offered at all. */
  const onADesk = (matches: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  const shell = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Layout />
      </QueryClientProvider>,
    );
  afterEach(() => vi.unstubAllGlobals());

  describe('Platform settings is offered to an admin on a desk and to nobody else', () => {
    /**
     * Hiding it is a courtesy rather than the guard - the server refuses an
     * ordinary user who reaches it (`auth/admin.ts`) - but a door that only
     * ever says no is worse than no door, which is what this holds.
     */
    it.each([
      { situation: 'an admin on a desk-sized screen', role: 'admin', desk: true, offered: true },
      { situation: 'an ordinary user on a desk-sized screen', role: 'user', desk: true, offered: false },
      { situation: 'an admin on a phone-width screen', role: 'admin', desk: false, offered: false },
    ])('offers it to $situation: $offered', async ({ role, desk, offered }) => {
      signedInRole = role;
      onADesk(desk);
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      // Awaited on something that is always there, so the absent case is a
      // menu that has finished opening rather than one that has not started.
      expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeVisible();

      expect(screen.queryByRole('menuitem', { name: 'Platform settings…' }) !== null).toBe(offered);
    });

    it('puts it after Settings and before Sign out', async () => {
      signedInRole = 'admin';
      onADesk(true);
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      await screen.findByRole('menuitem', { name: 'Platform settings…' });

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Settings…',
        'Platform settings…',
        'Sign out',
        '© 2026 Conselit · conselit.be',
      ]);
    });
  });

  describe('Platform settings holds the users and the usage, and neither stays on the workspace’s menu', () => {
    it.each(['Manage users', 'Usage'])('leaves %s off the open workspace’s “…” for an admin', async (entry) => {
      signedInRole = 'admin';
      onADesk(true);
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));
      expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();

      expect(screen.queryByRole('menuitem', { name: entry })).toBeNull();
    });

    it('opens on Users with the focus on it, headed by its entry, and gives the focus back to the profile control', async () => {
      signedInRole = 'admin';
      onADesk(true);
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      shell();

      await user.click(await screen.findByRole('button', { name: 'Profile' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Platform settings…' }));

      const platform = await screen.findByRole('dialog', { name: 'Platform settings' });
      await waitFor(() => expect(within(platform).getByRole('button', { name: 'Users' })).toHaveFocus());
      expect(platform.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
      expect(await within(platform).findByRole('heading', { name: 'Users' })).toBeVisible();

      await user.click(within(platform).getByRole('button', { name: 'Usage' }));
      expect(await within(platform).findByRole('heading', { name: 'Usage' })).toBeVisible();

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.getByRole('button', { name: 'Profile' })).toHaveFocus());
    });
  });
});

describe('Agents', () => {
  describe('the dock hides and shows from the dock itself', () => {
    /** A desk-sized screen: the dock is drawn only where the Inbox has room beside the dashboards. */
    const onADesk = (matches: boolean) =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    const shell = () =>
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Layout />
        </QueryClientProvider>,
      );
    const dock = () => screen.queryByRole('toolbar', { name: 'Agents' });
    const strip = () => screen.queryByRole('button', { name: 'Show the agents’ dock' });
    const openADashboard = () => {
      openWorkspaceId = 'ws-markup';
      openDashboardId = 'dash-1';
    };

    afterEach(() => vi.unstubAllGlobals());

    it('puts the dock away from its own control, and brings it back from the strip', async () => {
      onADesk(true);
      openADashboard();
      const user = userEvent.setup();
      shell();

      await screen.findByRole('toolbar', { name: 'Agents' });
      expect(strip()).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Hide the agents’ dock' }));
      expect(dock()).toBeNull();
      // The control that was pressed is gone; the focus lands on its stand-in.
      await waitFor(() => expect(strip()).toHaveFocus());
      await user.click(strip()!);

      expect(await screen.findByRole('toolbar', { name: 'Agents' })).toBeInTheDocument();
      expect(strip()).toBeNull();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Hide the agents’ dock' })).toHaveFocus(),
      );
    });

    it('toggles on A, either way', async () => {
      onADesk(true);
      openADashboard();
      const user = userEvent.setup();
      shell();
      await screen.findByRole('toolbar', { name: 'Agents' });

      await user.keyboard('a');
      expect(dock()).toBeNull();
      expect(strip()).not.toBeNull();

      await user.keyboard('a');
      expect(await screen.findByRole('toolbar', { name: 'Agents' })).toBeInTheDocument();
    });

    it('is still hidden when the page is loaded again', async () => {
      onADesk(true);
      openADashboard();
      const user = userEvent.setup();
      const first = shell();
      await screen.findByRole('toolbar', { name: 'Agents' });
      await user.click(screen.getByRole('button', { name: 'Hide the agents’ dock' }));
      first.unmount();

      shell();

      expect(await screen.findByRole('button', { name: 'Show the agents’ dock' })).toBeInTheDocument();
      expect(dock()).toBeNull();
    });

    it('draws neither the dock nor the strip on a phone', async () => {
      onADesk(false);
      openADashboard();
      localStorage.setItem('cockpit.agent-dock-hidden', '1');
      shell();
      await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` });

      expect(dock()).toBeNull();
      expect(strip()).toBeNull();
    });
  });

  describe('no menu hides or shows the dock', () => {
    it('offers no such entry on the open workspace’s “…”', async () => {
      openWorkspaceId = 'ws-markup';
      const user = userEvent.setup();
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Layout />
        </QueryClientProvider>,
      );

      await user.click(await screen.findByRole('button', { name: `Actions for ${A_NAME_THAT_LOOKS_LIKE_MARKUP}` }));

      expect(screen.queryByRole('menuitem', { name: /agents’ dock/ })).toBeNull();
    });
  });
});
