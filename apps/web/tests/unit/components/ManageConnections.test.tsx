import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourceAccount } from '@cockpit/shared';
import ManageConnections from '../../../src/components/ManageConnections';
import { useCommand, useConnectClaudeCode, useTestClaudeCodeConnection } from '../../../src/api/queries';

/**
 * F1: what this window draws and what it sends, and nothing about what the
 * server stores. Whether a credential is really sealed, deleted or scoped to
 * one Workspace is proved against a real store in
 * apps/api/tests/integration/http/connections.test.ts and
 * apps/api/tests/integration/http/claude-code-connections.test.ts; that a
 * person can connect one and see the row is the browser walk in
 * tests/e2e/connections.test.ts.
 */

/** What the list read answers with, per case. */
const held = vi.hoisted(() => ({ sourceAccounts: [] as SourceAccount[] }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  useConnectClaudeCode: vi.fn(),
  useTestClaudeCodeConnection: vi.fn(),
  refusalFrom: (command: { error: unknown }) =>
    command.error ? 'That did not reach the server. Try again.' : null,
}));

// `ManageConnections` reads its own list straight off `api.v1.workspaces…` -
// this window's sole reason to be its own chunk (`WorkspaceTabs.tsx`,
// `bundle:budget`) - so the boundary this test mocks moved with it.
vi.mock('../../../src/api/client', () => ({
  api: {
    v1: {
      workspaces: {
        ':workspaceId': {
          connections: {
            $get: () =>
              Promise.resolve(new Response(JSON.stringify({ sourceAccounts: held.sourceAccounts }))),
          },
        },
      },
    },
  },
  refusal: (what: string, status: number) => new Error(`${what} failed: ${status}`),
}));

const ADA: SourceAccount = {
  id: 'account-ada',
  connectorId: 'teams',
  displayName: 'Ada Lovelace',
  connectedAt: '2026-09-18T09:00:00.000Z',
  lastTestedAt: null,
};

const MICHAEL: SourceAccount = {
  id: 'account-michael',
  connectorId: 'teams',
  displayName: 'Michael',
  connectedAt: '2026-09-18T09:05:00.000Z',
  lastTestedAt: null,
};

const CLAUDE: SourceAccount = {
  id: 'account-claude-code',
  connectorId: 'claude-code',
  displayName: 'Claude Code',
  connectedAt: '2026-09-18T09:10:00.000Z',
  lastTestedAt: '2026-09-18T09:10:00.000Z',
};

let sent: ReturnType<typeof vi.fn>;
let testedClaudeCode: ReturnType<typeof vi.fn>;

/**
 * What `useTestClaudeCodeConnection`'s `mutate` does when "Test again" is
 * pressed, for the one case that needs its callbacks to actually fire:
 * `'network-failure'` invokes `onError`, anything else invokes `onSuccess`
 * with itself as the result.
 */
type TestOutcome = { accepted: true } | { accepted: false; message: string } | 'network-failure';

function showWindow(outcome?: 'connected' | 'refused', testOutcome: TestOutcome = { accepted: true }) {
  sent = vi.fn();
  testedClaudeCode = vi.fn(
    (_sourceAccountId: string, opts: { onSuccess?: (r: unknown) => void; onError?: () => void }) => {
      if (testOutcome === 'network-failure') opts.onError?.();
      else opts.onSuccess?.(testOutcome);
    },
  );
  // Cast through `unknown`: the window reads a few of a mutation's fields and
  // a whole `UseMutationResult` would be thirty lines of stand-in for the
  // ones it never touches.
  vi.mocked(useCommand).mockReturnValue({
    mutate: sent,
    reset: vi.fn(),
    isPending: false,
    error: null,
    variables: undefined,
  } as unknown as ReturnType<typeof useCommand>);
  vi.mocked(useConnectClaudeCode).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useConnectClaudeCode>);
  vi.mocked(useTestClaudeCodeConnection).mockReturnValue({
    mutate: testedClaudeCode,
    isPending: false,
  } as unknown as ReturnType<typeof useTestClaudeCodeConnection>);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManageConnections
        workspaceId="ws-work"
        workspaceName="Work"
        {...(outcome ? { outcome } : {})}
        open
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  held.sourceAccounts = [];
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe('the window shows what this workspace has connected, and never a credential', () => {
    it('lists each connected account by the name the source gave it', async () => {
      held.sourceAccounts = [ADA, MICHAEL];

      showWindow();

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.getByText('Michael')).toBeInTheDocument();
      expect(screen.getAllByText('Microsoft Teams')).toHaveLength(3);
    });

    /**
     * "Nothing connected yet" is a claim about what this Workspace holds, so
     * it waits for an answer - drawn before one arrives, it would say so about
     * a Workspace with three connections while the read was in flight.
     */
    it('says nothing is connected only once the answer has come back', async () => {
      showWindow();

      expect(screen.queryByText(/Nothing connected yet/)).toBeNull();
      expect(await screen.findByText(/Nothing connected yet/)).toBeInTheDocument();
    });
  });

  describe('connecting leaves for the source, and says how the trip went on the way back', () => {
    /**
     * A whole-page navigation rather than a request, the same shape signing in
     * has - so what this asserts is the address the browser is sent to, which
     * is the whole of the control's behaviour.
     */
    it('sends the browser to this workspace’s own connect address', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({
        assign: leaving,
      } as unknown as Location);
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Microsoft Teams' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/teams/connect');
    });

    it('says so when the trip came back refused', async () => {
      showWindow('refused');

      expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing was stored/);
    });

    it('says nothing about a trip that came back connected', async () => {
      held.sourceAccounts = [ADA];

      showWindow('connected');

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('disconnecting asks first, and sends a disconnect for this workspace', () => {
    it('asks before anything is sent', async () => {
      held.sourceAccounts = [ADA];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));

      expect(await screen.findByText(/Disconnect Ada Lovelace\?/)).toBeInTheDocument();
      expect(sent).not.toHaveBeenCalled();
    });

    it('sends it for this workspace and this account once the question is answered', async () => {
      held.sourceAccounts = [ADA];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
      await userEvent.click(
        await screen.findByRole('button', { name: 'Yes, disconnect Ada Lovelace' }),
      );

      await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
      expect(sent.mock.calls[0]![0]).toMatchObject({
        name: 'disconnect_source_account',
        payload: { workspaceId: 'ws-work', sourceAccountId: 'account-ada' },
      });
    });

    /**
     * Disconnecting Teams forgets a sign-in; disconnecting Claude Code
     * forgets a routine trigger, never a sign-in - a Claude Code connection
     * never signed anybody in (found in review).
     */
    it('says what is forgotten in the connector’s own terms, not always "sign-in"', async () => {
      held.sourceAccounts = [CLAUDE];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));

      expect(await screen.findByText(/the routine trigger it was connected with/)).toBeInTheDocument();
      expect(screen.queryByText(/the sign-in it was connected with/)).toBeNull();
    });
  });

  describe('the window lists what is connected, then what can be added', () => {
    it('offers Teams and Claude Code to add when nothing is connected', async () => {
      showWindow();

      expect(await screen.findByText(/Nothing connected yet/)).toBeInTheDocument();
      // Nothing is connected, so each connector's name appears exactly once -
      // on its own Add-a-connection row.
      expect(screen.getByText('Microsoft Teams')).toBeInTheDocument();
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Claude Code' })).toBeInTheDocument();
    });

    it('shows a connected Claude Code under Connected with when it last worked, and offers no more Connect for it', async () => {
      held.sourceAccounts = [CLAUDE];

      showWindow();

      expect(await screen.findByText(/last worked/)).toBeInTheDocument();
      expect(screen.getByText('Connected - one per workspace')).toBeInTheDocument();
      // Teams is still offered - only Claude Code is capped at one.
      expect(screen.getByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Claude Code' })).toBeNull();
    });
  });

  describe('a connected Claude Code can be tested, edited and disconnected', () => {
    it('offers Test again, Edit… and Disconnect, where a Teams row offers only Disconnect', async () => {
      held.sourceAccounts = [ADA, CLAUDE];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }));
      expect(screen.queryByRole('menuitem', { name: 'Test again' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Edit…' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      expect(screen.getByRole('menuitem', { name: 'Test again' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Edit…' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
    });

    it('tests the row it was chosen from', async () => {
      held.sourceAccounts = [CLAUDE];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Test again' }));

      expect(testedClaudeCode).toHaveBeenCalledWith('account-claude-code', expect.anything());
    });

    it('shows why, when Claude refuses the test', async () => {
      held.sourceAccounts = [CLAUDE];
      showWindow(undefined, { accepted: false, message: 'The token is wrong or was revoked.' });

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Test again' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The token is wrong or was revoked.',
      );
    });

    /**
     * A test that never reached the server is not the same as Claude
     * refusing it, but both leave the connection exactly as it was - so
     * both get a line rather than one of them getting none at all (found
     * in review).
     */
    it('says so, rather than nothing, when the test request fails to reach the server', async () => {
      held.sourceAccounts = [CLAUDE];
      showWindow(undefined, 'network-failure');

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Test again' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'That did not reach the server. Try again.',
      );
    });

    it('opens the connect form to edit, prefilled with nothing', async () => {
      held.sourceAccounts = [CLAUDE];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }));

      expect(await screen.findByRole('dialog', { name: 'Connect Claude Code' })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: 'Routine trigger URL' })).toHaveValue('');
    });
  });
});
