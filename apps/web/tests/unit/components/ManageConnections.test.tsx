import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourceAccount } from '@cockpit/shared';
import ManageConnections from '../../../src/components/ManageConnections';
import type { ConnectOutcome } from '../../../src/connections';
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
const held = vi.hoisted(() => ({
  sourceAccounts: [] as SourceAccount[],
  /** What the registry's list answers with: Teams, as in an environment that has its bot. */
  registry: [] as { id: string; displayName: string; cardText: string; asksFirst: boolean }[],
  /** What the Claude Code connection's hooks read answers with (issue 572). */
  hooks: { url: '', secret: '', domain: '', lastArrivedAt: null as string | null },
  /** The connection each hooks read was for. */
  hooksAskedFor: [] as string[],
}));

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
      connectors: {
        $get: () => Promise.resolve(new Response(JSON.stringify({ connectors: held.registry }))),
      },
      workspaces: {
        ':workspaceId': {
          connections: {
            $get: () =>
              Promise.resolve(new Response(JSON.stringify({ sourceAccounts: held.sourceAccounts }))),
            'claude-code': {
              ':sourceAccountId': {
                hooks: {
                  $post: ({ param }: { param: { sourceAccountId: string } }) => {
                    held.hooksAskedFor.push(param.sourceAccountId);
                    return Promise.resolve(new Response(JSON.stringify(held.hooks)));
                  },
                },
              },
            },
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
  failingBecause: null,
};

const MICHAEL: SourceAccount = {
  id: 'account-michael',
  connectorId: 'teams',
  displayName: 'Michael',
  connectedAt: '2026-09-18T09:05:00.000Z',
  lastTestedAt: null,
  failingBecause: null,
};

const CLAUDE: SourceAccount = {
  id: 'account-claude-code',
  connectorId: 'claude-code',
  displayName: 'Claude Code',
  connectedAt: '2026-09-18T09:10:00.000Z',
  lastTestedAt: '2026-09-18T09:10:00.000Z',
  failingBecause: null,
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

function showWindow(outcome?: ConnectOutcome, testOutcome: TestOutcome = { accepted: true }, guest = false) {
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
        guest={guest}
        open
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

const TEAMS_CARD = {
  id: 'teams',
  displayName: 'Microsoft Teams',
  cardText: 'Sign in with Microsoft. Cockpit reads who you are and nothing else.',
  asksFirst: false,
};

beforeEach(() => {
  held.sourceAccounts = [];
  held.registry = [TEAMS_CARD];
  held.hooksAskedFor = [];
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

    it('sends the browser to the connect address of whichever registered source’s Connect was pressed', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({
        assign: leaving,
      } as unknown as Location);
      held.registry = [TEAMS_CARD, { ...TEAMS_CARD, id: 'notion', displayName: 'Notion', cardText: 'Pages.' }];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/notion/connect');
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

  /** "Connect a Gmail account to a workspace, and disconnect it", issue 724. */
  describe('Gmail is connected through three steps before Google, and the window says how it went', () => {
    it('Connect on the Gmail card shows the three steps, and says the label and the task stay in step', async () => {
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));

      const steps = await screen.findByRole('dialog', { name: 'Connect Gmail to Work' });
      expect(steps).toHaveTextContent(/1\. Create a label called Cockpit in Gmail/);
      expect(steps).toHaveTextContent(/2\. Sign in with Google\..*Advanced, then Go to Cockpit/);
      expect(steps).toHaveTextContent(/3\. Label any conversation Cockpit/);
      expect(steps).toHaveTextContent(/The label and the task stay in step/);
      // The card says it too, before anybody presses anything.
      expect(screen.getByText(/Finishing the task takes the label off/)).toBeInTheDocument();
    });

    it('Sign in with Google leaves for this workspace’s own Gmail connect address', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/gmail/connect');
    });

    it('Cancel stays, back on the connections list', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Gmail to Work' })).toBeNull());
      expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
      expect(leaving).not.toHaveBeenCalled();
    });

    it.each([
      {
        situation: 'connected',
        outcome: 'gmail-connected' as const,
        says: 'Connected. Conversations labelled Cockpit arrive in this workspace’s Inbox within a minute.',
      },
      {
        situation: 'connected by star',
        outcome: 'gmail-star-connected' as const,
        says: 'Connected. Conversations you star or flag from now on arrive in this workspace’s Inbox within a few minutes.',
      },
      { situation: 'refused', outcome: 'refused' as const, says: /^That did not connect\. Nothing was stored\./ },
      { situation: 'cancelled', outcome: 'cancelled' as const, says: 'Connecting was cancelled. Nothing was stored.' },
      {
        situation: 'without the permission to change mail',
        outcome: 'gmail-permission-missing' as const,
        says: /tick the Gmail box on Google’s last screen\.$/,
      },
      {
        situation: 'without a refresh token',
        outcome: 'gmail-no-refresh-token' as const,
        says: /Remove Cockpit under third-party access in your Google account, then connect again\.$/,
      },
    ])('back from Google, $situation, it says so', async ({ outcome, says }) => {
      showWindow(outcome);

      expect(await screen.findByText(says)).toBeInTheDocument();
    });

    it('a connected Gmail account is a row named by its address, reading the label it follows', async () => {
      held.sourceAccounts = [
        { ...ADA, id: 'account-anna', connectorId: 'gmail', displayName: 'anna@example.com', lastTestedAt: null },
      ];

      showWindow('gmail-connected');

      expect(await screen.findByText('anna@example.com')).toBeInTheDocument();
      expect(screen.getByText('Gmail · label Cockpit')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Actions for anna@example.com' }));
      expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
    });
  });

  /** "Connect Gmail by star, and bring in conversations starred from then on", issue 822. */
  describe('the Gmail Connect window offers one mark to follow, the label to start, and its steps follow the choice', () => {
    it('opens with the label chosen, and the steps include creating the label', async () => {
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));

      const steps = await screen.findByRole('dialog', { name: 'Connect Gmail to Work' });
      expect(within(steps).getByRole('radio', { name: 'Labelled Cockpit' })).toBeChecked();
      expect(within(steps).getByRole('radio', { name: 'Starred (flagged in Outlook)' })).not.toBeChecked();
      expect(steps).toHaveTextContent(/Create a label called Cockpit in Gmail/);
    });

    it('choosing the star drops creating the label, says only stars from now on count, and connects by star', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();
      await userEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }));
      const steps = await screen.findByRole('dialog', { name: 'Connect Gmail to Work' });

      await userEvent.click(within(steps).getByRole('radio', { name: 'Starred (flagged in Outlook)' }));

      expect(steps).not.toHaveTextContent(/Create a label called Cockpit/);
      expect(steps).toHaveTextContent(/1\. Sign in with Google\./);
      expect(steps).toHaveTextContent(
        /2\. Star any conversation in Gmail, or flag it in Outlook,.*Only conversations starred or flagged from now on become tasks/,
      );
      await userEvent.click(within(steps).getByRole('button', { name: 'Sign in with Google' }));
      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/gmail/connect?follows=star');
    });
  });

  /** "Change what a Gmail connection follows, without reconnecting", issue 824. */
  describe('a Gmail row’s menu changes the mark it follows, starting at the one followed now', () => {
    const ANNA: SourceAccount = {
      ...ADA,
      id: 'account-anna',
      connectorId: 'gmail',
      displayName: 'anna@example.com',
      follows: 'star',
    };

    async function changeWhatIsFollowed(): Promise<HTMLElement> {
      await userEvent.click(await screen.findByRole('button', { name: 'Actions for anna@example.com' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Change what’s followed…' }));
      return screen.findByRole('dialog', { name: 'What anna@example.com follows' });
    }

    it.each([
      { situation: 'choosing the label sends the switch for this workspace and this row', choose: 'Labelled Cockpit', sends: 'label' },
      { situation: 'Save with the star still chosen sends nothing', choose: null, sends: null },
    ])('$situation', async ({ choose, sends }) => {
      held.sourceAccounts = [ANNA, ADA];
      showWindow();

      const choice = await changeWhatIsFollowed();
      expect(within(choice).getByRole('radio', { name: 'Starred (flagged in Outlook)' })).toBeChecked();
      if (choose) await userEvent.click(within(choice).getByRole('radio', { name: choose }));
      await userEvent.click(within(choice).getByRole('button', { name: 'Save' }));

      if (sends) {
        expect(sent).toHaveBeenCalledTimes(1);
        expect(sent.mock.calls[0]![0]).toMatchObject({
          name: 'set_gmail_follows',
          payload: { workspaceId: 'ws-work', sourceAccountId: 'account-anna', follows: sends },
        });
      } else {
        expect(sent).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'What anna@example.com follows' })).toBeNull());
      }
    });

    it('is offered on a Gmail row only', async () => {
      held.sourceAccounts = [ADA];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }));

      expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Change what’s followed…' })).toBeNull();
    });
  });

  /** "Bring in the conversations already labelled Cockpit as tasks", issue 725. */
  describe('a Gmail row shows when its mailbox was last checked, and why it is failing', () => {
    const checkedAt = '2026-10-04T09:00:00.000Z';
    it.each([
      { situation: 'never checked yet', lastTestedAt: null, failingBecause: null, reads: 'Gmail · label Cockpit', failing: null },
      {
        situation: 'following the star, never checked yet',
        follows: 'star' as const,
        lastTestedAt: null,
        failingBecause: null,
        reads: 'Gmail · starred',
        failing: null,
      },
      {
        situation: 'following the star, after a check',
        follows: 'star' as const,
        lastTestedAt: checkedAt,
        failingBecause: null,
        reads: `Gmail · starred · last checked ${new Date(checkedAt).toLocaleString()}`,
        failing: null,
      },
      {
        situation: 'after a check',
        lastTestedAt: checkedAt,
        failingBecause: null,
        reads: `Gmail · label Cockpit · last checked ${new Date(checkedAt).toLocaleString()}`,
        failing: null,
      },
      {
        situation: 'failing',
        lastTestedAt: checkedAt,
        failingBecause: 'there is no label called Cockpit in this account.',
        reads: `Gmail · label Cockpit · last checked ${new Date(checkedAt).toLocaleString()}`,
        failing: 'Failing: there is no label called Cockpit in this account.',
      },
    ])('$situation', async ({ lastTestedAt, failingBecause, reads, failing, ...rest }) => {
      const follows = 'follows' in rest ? rest.follows : 'label';
      held.sourceAccounts = [
        { ...ADA, id: 'account-anna', connectorId: 'gmail', displayName: 'anna@example.com', lastTestedAt, failingBecause, follows },
      ];

      showWindow();

      expect(await screen.findByText(reads)).toBeInTheDocument();
      expect(screen.queryByText(/^Failing:/)?.textContent ?? null).toBe(failing);
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

  describe('the guest is offered no way to connect, disconnect or test, only how to connect their own', () => {
    it('says to sign in with Google in place of every Connect, on Connections and Agent settings alike', async () => {
      showWindow(undefined, undefined, true);

      await screen.findByText(/Nothing connected yet/);
      expect(screen.getAllByText('Sign in with Google to connect your own')).toHaveLength(3);
      expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
    });

    it('offers nothing to do to a connection the guest is shown', async () => {
      held.sourceAccounts = [ADA, CLAUDE];

      showWindow(undefined, undefined, true);

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Actions for / })).toBeNull();
    });

    it('still offers a named person Connect', async () => {
      showWindow();

      expect(await screen.findByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
      expect(screen.queryByText('Sign in with Google to connect your own')).toBeNull();
    });
  });

  describe('the window lists what is connected, then what can be added', () => {
    it('offers Teams and Claude Code to add when nothing is connected', async () => {
      showWindow();

      expect(await screen.findByText(/Nothing connected yet/)).toBeInTheDocument();
      // Nothing is connected, so each connector's name appears exactly once -
      // on its own Add-a-connection row.
      expect(await screen.findByText('Microsoft Teams')).toBeInTheDocument();
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Claude Code' })).toBeInTheDocument();
    });

    it('draws one card per registered connector, named and described as its manifest gives, and none for one the registry lacks', async () => {
      held.registry = [{ id: 'notion', displayName: 'Notion', cardText: 'Pages become tasks.', asksFirst: false }];

      showWindow();

      expect(await screen.findByRole('button', { name: 'Connect Notion' })).toBeInTheDocument();
      expect(screen.getByText('Pages become tasks.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Microsoft Teams' })).toBeNull();
      // The two named cards stay, as before.
      expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Claude Code' })).toBeInTheDocument();
    });

    it('shows Teams’ card with its manifest’s text', async () => {
      showWindow();

      expect(await screen.findByText(TEAMS_CARD.cardText)).toBeInTheDocument();
    });

    it('shows a connected Claude Code under Connected with when it last worked, and offers no more Connect for it', async () => {
      held.sourceAccounts = [CLAUDE];

      showWindow();

      expect(await screen.findByText(/last worked/)).toBeInTheDocument();
      expect(screen.getByText('Connected - one per workspace')).toBeInTheDocument();
      // Teams is still offered - only Claude Code is capped at one.
      expect(await screen.findByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
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

describe('Agents', () => {
  describe('a connection Claude refused says so on its row until a start works', () => {
    it.each([
      { situation: 'failing', failingBecause: 'The token is wrong or was revoked.', says: 'Failing: The token is wrong or was revoked.' },
      { situation: 'working', failingBecause: null, says: null },
    ])('a Claude Code connection $situation', async ({ failingBecause, says }) => {
      held.sourceAccounts = [{ ...CLAUDE, failingBecause }];

      showWindow();

      await screen.findByText(/last worked/);
      expect(screen.queryByText(/^Failing:/)?.textContent ?? null).toBe(says);
    });
  });
});

describe('Agents', () => {
  describe('the connection’s form gives what the repository needs to say Claude is waiting', () => {
    it.each([
      { situation: 'a hook has arrived', lastArrivedAt: '2026-09-29T08:00:00.000Z', says: /^A hook last arrived / },
      { situation: 'no hook has arrived', lastArrivedAt: null, says: /^No hook has arrived yet\.$/ },
    ])('when $situation', async ({ lastArrivedAt, says }) => {
      held.sourceAccounts = [CLAUDE];
      held.hooks = {
        url: 'https://cockpit.example/ingress/claude-code/hooks/account-claude-code',
        secret: 'the-connections-secret',
        domain: 'cockpit.example',
        lastArrivedAt,
      };
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Claude Code' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }));

      const snippet = JSON.parse((await screen.findByLabelText('Hooks for .claude/settings.json')).textContent!);
      const hook = snippet.hooks.Stop[0].hooks[0];
      expect(hook).toMatchObject({
        type: 'http',
        url: 'https://cockpit.example/ingress/claude-code/hooks/account-claude-code',
        headers: { Authorization: 'Bearer the-connections-secret' },
      });
      expect(snippet.hooks.UserPromptSubmit[0].hooks[0]).toEqual(hook);
      // The domain to allow is the form's step 2, shown before any connection
      // exists (ConnectClaudeCode.test.tsx), so it is not repeated here.
      expect(screen.getByText(says)).toBeInTheDocument();
      expect(held.hooksAskedFor).toEqual(['account-claude-code']);
    });
  });
});