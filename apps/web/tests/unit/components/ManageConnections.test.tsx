import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourceAccount } from '@cockpit/shared';
import ManageConnections from '../../../src/components/ManageConnections';
import type { ConnectOutcome, RefusedBecause } from '../../../src/connections';
import { useCheckConnectionNow, useCommand } from '../../../src/api/queries';

/**
 * F1: what this window draws and what it sends, and nothing about what the
 * server stores. Whether a credential is really sealed, deleted or scoped to
 * one Workspace is proved against a real store in
 * apps/api/tests/integration/http/connections.test.ts; that a
 * person can connect one and see the row is the browser walk in
 * tests/e2e/connections.test.ts.
 */

/** What the list read answers with, per case. */
const held = vi.hoisted(() => ({
  sourceAccounts: [] as SourceAccount[],
  /** What the registry's list answers with: Teams, as in an environment that has its bot. */
  registry: [] as {
    id: string;
    displayName: string;
    cardText: string;
    asksFirst: boolean;
    refusals?: Record<string, string>;
    choice?: { question: string; options: { value: string; label: string }[] };
    textedCode?: { textTo: string };
  }[],
  /** What the Workspace's snapshot calls each source (issue 927). */
  sourceNames: {} as Record<string, string> | undefined,
  /** What a connection's history read answers with, or that it fails (issue 1140). */
  history: [] as unknown[] | 'fails',
  /** Whether that read says older lines remain than it carries (issue 1145). */
  olderRemain: false,
  /** The connection each history read was for. */
  historyAskedFor: [] as string[],
  /** The Items a press on a named Item asked to open (issue 1141). */
  opened: [] as string[],
  /** What the two requests that connect a phone answer, and what each was sent (issue 1335). */
  phone: {
    code: { status: 200, body: {} as unknown },
    confirm: { status: 200, body: {} as unknown, connects: null as SourceAccount | null },
    sent: [] as { which: 'code' | 'confirm'; json: Record<string, string> }[],
    /** Whether a request fails before an answer arrives. */
    unreachable: false,
  },
}));

vi.mock('../../../src/itemForm', () => ({
  useOpenItem: () => (itemId: string) => {
    held.opened.push(itemId);
  },
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  useCheckConnectionNow: vi.fn(),
  refusalFrom: (command: { error: unknown }) =>
    command.error ? 'That did not reach the server. Try again.' : null,
  // The Workspace's snapshot, of which the window reads only what each source is called.
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ sourceNames: held.sourceNames }),
  }),
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
            ':connectorId': {
              phone: {
                code: {
                  $post: ({ json }: { json: Record<string, string> }) => {
                    held.phone.sent.push({ which: 'code', json });
                    if (held.phone.unreachable) return Promise.reject(new TypeError('network'));
                    return Promise.resolve(Response.json(held.phone.code.body, { status: held.phone.code.status }));
                  },
                },
                confirm: {
                  $post: ({ json }: { json: Record<string, string> }) => {
                    held.phone.sent.push({ which: 'confirm', json });
                    if (held.phone.unreachable) return Promise.reject(new TypeError('network'));
                    if (held.phone.confirm.status === 200 && held.phone.confirm.connects) {
                      held.sourceAccounts = [...held.sourceAccounts, held.phone.confirm.connects];
                    }
                    return Promise.resolve(Response.json(held.phone.confirm.body, { status: held.phone.confirm.status }));
                  },
                },
              },
            },
            ':sourceAccountId': {
              history: {
                $get: ({ param }: { param: { sourceAccountId: string } }) => {
                  held.historyAskedFor.push(param.sourceAccountId);
                  return Promise.resolve(
                    held.history === 'fails'
                      ? new Response('', { status: 500 })
                      : new Response(JSON.stringify({ lines: held.history, olderRemain: held.olderRemain })),
                  );
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
  filesByName: false,
};

const MICHAEL: SourceAccount = {
  id: 'account-michael',
  connectorId: 'teams',
  displayName: 'Michael',
  connectedAt: '2026-09-18T09:05:00.000Z',
  lastTestedAt: null,
  failingBecause: null,
  filesByName: false,
};

let sent: ReturnType<typeof vi.fn>;
/** The connections a press on Check now asked for (issue 1143), and whether the request reaches the server. */
let checkedNow: string[] = [];
let checkNowReaches = true;

function showWindow(outcome?: ConnectOutcome, guest = false, because?: RefusedBecause) {
  sent = vi.fn();
  // Cast through `unknown`: the window reads a few of a mutation's fields and
  // a whole `UseMutationResult` would be thirty lines of stand-in for the
  // ones it never touches.
  vi.mocked(useCommand).mockReturnValue({
    mutate: sent,
    mutateAsync: (args: unknown) => {
      (sent as (sent: unknown) => void)(args);
      return Promise.resolve();
    },
    reset: vi.fn(),
    isPending: false,
    error: null,
    variables: undefined,
  } as unknown as ReturnType<typeof useCommand>);
  vi.mocked(useCheckConnectionNow).mockReturnValue({
    mutate: (id: string, opts: { onSuccess?: () => void; onError?: () => void }) => {
      checkedNow.push(id);
      if (checkNowReaches) opts.onSuccess?.();
      else opts.onError?.();
    },
    isPending: false,
  } as unknown as ReturnType<typeof useCheckConnectionNow>);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManageConnections
        workspaceId="ws-work"
        workspaceName="Work"
        {...(outcome ? { outcome } : {})}
        {...(because ? { because } : {})}
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
  held.history = [];
  held.olderRemain = false;
  held.historyAskedFor = [];
  held.opened = [];
  checkedNow = [];
  checkNowReaches = true;
  held.phone.code = { status: 200, body: { number: '+32470123456' } };
  held.phone.confirm = { status: 200, body: { number: '+32470123456' }, connects: null };
  held.phone.sent = [];
  held.phone.unreachable = false;
  held.sourceNames = { teams: 'Microsoft Teams', gmail: 'Gmail' };
  vi.restoreAllMocks();
});

describe('Connector management', () => {
  describe('the window shows what this workspace has connected, and never a credential', () => {
    it('lists each connected account by the name the source gave it', async () => {
      held.sourceAccounts = [ADA, MICHAEL];

      showWindow();

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.getByText('Michael')).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByText('Microsoft Teams')).toHaveLength(3));
    });

    /** "Take source names out of the shared contract", issue 927. */
    it.each([
      {
        situation: 'a source the environment no longer registers reads as its id',
        account: { ...ADA, connectorId: 'outlook' },
        reads: 'outlook',
      },
      {
        situation: 'a source that follows something says it in its own words',
        account: { ...ADA, connectorId: 'outlook', follows: 'folder-7', followsLabel: 'folder Follow up' },
        names: { outlook: 'Outlook' },
        reads: 'Outlook · folder Follow up',
      },
      {
        situation: 'a row from a release that sent no words for what it follows reads the value itself',
        account: { ...ADA, connectorId: 'outlook', follows: 'folder-7' },
        names: { outlook: 'Outlook' },
        reads: 'Outlook · folder-7',
      },
      {
        situation: 'a stored copy from before the names were carried reads each as its id',
        account: ADA,
        names: undefined,
        reads: 'teams',
      },
    ])('$situation', async ({ account, reads, ...rest }) => {
      if ('names' in rest) held.sourceNames = rest.names;
      held.sourceAccounts = [account];

      showWindow();

      expect(await screen.findByText(reads)).toBeInTheDocument();
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

    it.each([
      {
        situation: 'a reason the connector listed',
        because: { connectorId: 'notion', code: 'no-offline' },
        says: 'Notion did not let Cockpit stay signed in. Nothing was stored.',
      },
      {
        situation: 'a reason its listing does not hold',
        because: { connectorId: 'notion', code: 'typed-into-the-address' },
        says: /^That did not connect\. Nothing was stored\. Try again\.$/,
      },
      {
        situation: 'a code that is a name every object has',
        because: { connectorId: 'notion', code: 'constructor' },
        says: /^That did not connect\. Nothing was stored\. Try again\.$/,
      },
      {
        situation: 'a connector that is not listed',
        because: { connectorId: 'nobody', code: 'no-offline' },
        says: /^That did not connect\. Nothing was stored\. Try again\.$/,
      },
    ])('back from a source whose own step refused the grant, with $situation, it says what the listing gives', async ({ because, says }) => {
      held.registry = [
        { id: 'notion', displayName: 'Notion', cardText: 'Pages.', asksFirst: false, refusals: { 'no-offline': 'Notion did not let Cockpit stay signed in. Nothing was stored.' } },
      ];
      showWindow('refused', false, because);

      expect(await screen.findByText(says)).toBeInTheDocument();
    });
  });

  /** "Ask a connection's one choice on connecting, and change it later", issue 942. */
  describe('a connector’s one choice is asked before Connect and changed from the connection’s row', () => {
    const NOTION_CARD = {
      id: 'notion',
      displayName: 'Notion',
      cardText: 'Pages arrive as items.',
      asksFirst: true,
      choice: {
        question: 'Bring in',
        options: [
          { value: 'starred', label: 'Starred pages' },
          { value: 'all', label: 'Every page' },
        ],
      },
    };
    const PAGES: SourceAccount = {
      ...ADA,
      id: 'account-pages',
      connectorId: 'notion',
      displayName: 'Ada’s pages',
      follows: 'starred',
      followsLabel: 'Starred pages',
    };

    beforeEach(() => {
      held.registry = [TEAMS_CARD, NOTION_CARD];
      held.sourceNames = { ...held.sourceNames, notion: 'Notion' };
    });

    it('asks the question before navigating, then connects with the option picked', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

      const asked = await screen.findByRole('dialog', { name: 'Connect Notion' });
      expect(leaving).not.toHaveBeenCalled();
      expect(within(asked).getByRole('radio', { name: 'Starred pages' })).toBeChecked();
      await userEvent.click(within(asked).getByRole('radio', { name: 'Every page' }));
      await userEvent.click(within(asked).getByRole('button', { name: 'Connect' }));
      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/notion/connect?choice=all');
    });

    it('cancelling the question goes nowhere', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();
      await userEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));

      await userEvent.click(within(await screen.findByRole('dialog', { name: 'Connect Notion' })).getByRole('button', { name: 'Cancel' }));

      expect(leaving).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Notion' })).toBeNull());
    });

    it('a connector that declares no choice navigates at once, as before', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Microsoft Teams' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/teams/connect');
      expect(screen.queryByRole('dialog', { name: /^Connect / })).toBeNull();
    });

    it('the row shows the label of the choice it was connected under', async () => {
      held.sourceAccounts = [PAGES];

      showWindow();

      expect(await screen.findByText('Notion · Starred pages')).toBeInTheDocument();
    });

    it.each([
      { situation: 'choosing the other option sends the change for this workspace and this row', choose: 'Every page', sends: 'all' },
      { situation: 'Save with the option unchanged sends nothing', choose: null, sends: null },
    ])('$situation', async ({ choose, sends }) => {
      held.sourceAccounts = [PAGES];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada’s pages' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Change…' }));
      const changing = await screen.findByRole('dialog', { name: 'Change Ada’s pages' });
      expect(within(changing).getByRole('radio', { name: 'Starred pages' })).toBeChecked();
      if (choose) await userEvent.click(within(changing).getByRole('radio', { name: choose }));
      await userEvent.click(within(changing).getByRole('button', { name: 'Save' }));

      if (sends) {
        expect(sent).toHaveBeenCalledTimes(1);
        expect(sent.mock.calls[0]![0]).toMatchObject({
          name: 'set_connection_choice',
          payload: { workspaceId: 'ws-work', sourceAccountId: 'account-pages', choice: sends },
        });
      } else {
        expect(sent).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change Ada’s pages' })).toBeNull());
      }
    });

    it('Change… is offered only on a row whose connector declares a choice', async () => {
      held.sourceAccounts = [ADA];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }));

      expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Change…' })).toBeNull();
    });
  });

  /** "File Outlook mail on the Panel named after its category", issue 1146. */
  describe('the tick box appears for a connector that reports names, and says what it saves', () => {
    const MAIL_CARD = {
      id: 'outlook',
      displayName: 'Outlook',
      cardText: 'Messages you flag arrive as items.',
      asksFirst: true,
      choice: { question: 'Bring in messages', options: [{ value: 'flag', label: 'Flagged' }] },
      names: { noun: 'category', example: 'a message with the category' },
    };
    const PAGES_CARD = {
      id: 'notion',
      displayName: 'Notion',
      cardText: 'Pages arrive as items.',
      asksFirst: true,
      choice: { question: 'Bring in', options: [{ value: 'starred', label: 'Starred pages' }] },
    };
    const MAIL: SourceAccount = {
      ...ADA,
      id: 'account-mail',
      connectorId: 'outlook',
      displayName: 'Ada’s mail',
      lastTestedAt: '2026-10-16T09:00:00.000Z',
      follows: 'flag',
      followsLabel: 'Flagged',
    };
    const PAGES: SourceAccount = { ...ADA, id: 'account-pages', connectorId: 'notion', displayName: 'Ada’s pages', follows: 'starred' };
    const TICK_BOX = 'File it on the panel named after its category';

    beforeEach(() => {
      held.registry = [MAIL_CARD, PAGES_CARD];
      held.sourceNames = { ...held.sourceNames, outlook: 'Outlook', notion: 'Notion' };
    });

    async function change(displayName: string): Promise<HTMLElement> {
      await userEvent.click(await screen.findByRole('button', { name: `Actions for ${displayName}` }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Change…' }));
      return screen.findByRole('dialog', { name: `Change ${displayName}` });
    }

    it('offers it in the connector’s own noun, with the line saying what it does, on a connector that reports names', async () => {
      held.sourceAccounts = [MAIL];
      showWindow();

      const changing = await change('Ada’s mail');

      expect(within(changing).getByRole('checkbox', { name: TICK_BOX })).not.toBeChecked();
      expect(
        within(changing).getByText(
          'So a message with the category Customer Atlas lands on the Customer Atlas panel instead of the Inbox. A category that matches no panel, or panels on two dashboards, leaves it in the Inbox.',
        ),
      ).toBeInTheDocument();
    });

    /** "File Gmail conversations on the Panel named after their label", issue 1148. */
    it('says label for Gmail, from the connector’s own noun, in the box, the line under it and the row', async () => {
      const GMAIL_CARD = {
          id: 'gmail',
          displayName: 'Gmail',
          cardText: 'Conversations you label Cockpit arrive as items.',
          asksFirst: true,
          choice: { question: 'Bring in conversations', options: [{ value: 'label', label: 'Labelled Cockpit' }] },
          names: { noun: 'label', example: 'a conversation labelled' },
      };
      held.registry = [GMAIL_CARD];
      held.sourceAccounts = [
        {
          ...MAIL,
          id: 'account-gmail',
          connectorId: 'gmail',
          displayName: 'Ada’s Gmail',
          follows: 'label',
          followsLabel: 'Labelled Cockpit',
          filesByName: true,
        },
      ];
      showWindow();

      expect(await screen.findByText(/^Gmail · Labelled Cockpit · files by label · last checked /)).toBeInTheDocument();
      const changing = await change('Ada’s Gmail');

      expect(within(changing).getByRole('checkbox', { name: 'File it on the panel named after its label' })).toBeChecked();
      expect(
        within(changing).getByText(
          'So a conversation labelled Customer Atlas lands on the Customer Atlas panel instead of the Inbox. A label that matches no panel, or panels on two dashboards, leaves it in the Inbox.',
        ),
      ).toBeInTheDocument();
    });

    it('offers none on a connector that reports no names', async () => {
      held.sourceAccounts = [PAGES];
      showWindow();

      const changing = await change('Ada’s pages');

      expect(within(changing).queryByRole('checkbox')).toBeNull();
    });

    it.each([
      { situation: 'opened while on, Save with nothing changed sends nothing', on: true, tick: false, sends: null },
      { situation: 'opened while off, Save with nothing changed sends nothing', on: false, tick: false, sends: null },
      { situation: 'ticked and saved, it sends the switch on for this workspace and this row', on: false, tick: true, sends: true },
      { situation: 'unticked and saved, it sends the switch off', on: true, tick: true, sends: false },
    ])('$situation', async ({ on, tick, sends }) => {
      held.sourceAccounts = [{ ...MAIL, filesByName: on }];
      showWindow();

      const changing = await change('Ada’s mail');
      const box = within(changing).getByRole('checkbox', { name: TICK_BOX });
      expect((box as HTMLInputElement).checked).toBe(on);
      if (tick) await userEvent.click(box);
      await userEvent.click(within(changing).getByRole('button', { name: 'Save' }));

      if (sends === null) expect(sent).not.toHaveBeenCalled();
      else {
        expect(sent).toHaveBeenCalledTimes(1);
        expect(sent.mock.calls[0]![0]).toMatchObject({
          name: 'set_connection_files_by_name',
          payload: { workspaceId: 'ws-work', sourceAccountId: 'account-mail', filesByName: sends },
        });
      }
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change Ada’s mail' })).toBeNull());
    });

    it.each([
      { situation: 'a row filing by name says so, in the connector’s noun', on: true, says: /^Outlook · Flagged · files by category · last checked / },
      { situation: 'a row not filing by name says nothing of it', on: false, says: /^Outlook · Flagged · last checked / },
    ])('$situation', async ({ on, says }) => {
      held.sourceAccounts = [{ ...MAIL, filesByName: on }];

      showWindow();

      expect(await screen.findByText(says)).toBeInTheDocument();
    });
  });

  /** "Ask on Connect whether a mail connection files by label or category", issue 1147. */
  describe('Connect asks whether the connection files by name, and Reconnect starts at the row’s own answer', () => {
    const MAIL_CARD = {
      id: 'outlook',
      displayName: 'Outlook',
      cardText: 'Messages you flag arrive as items.',
      asksFirst: true,
      choice: { question: 'Bring in messages', options: [{ value: 'flag', label: 'Flagged' }] },
      names: { noun: 'category', example: 'a message with the category' },
    };
    const NAMES_ONLY_CARD = { ...MAIL_CARD, id: 'names-only', displayName: 'Names only', choice: undefined };
    const PAGES_CARD = {
      id: 'notion',
      displayName: 'Notion',
      cardText: 'Pages arrive as items.',
      asksFirst: true,
      choice: { question: 'Bring in', options: [{ value: 'starred', label: 'Starred pages' }] },
    };
    const FAILING_MAIL: SourceAccount = {
      ...ADA,
      id: 'account-mail',
      connectorId: 'outlook',
      displayName: 'Ada’s mail',
      follows: 'flag',
      followsLabel: 'Flagged',
      failingBecause: 'Microsoft no longer accepts the sign-in.',
    };
    const TICK_BOX = 'File it on the panel named after its category';

    beforeEach(() => {
      held.registry = [TEAMS_CARD, MAIL_CARD, NAMES_ONLY_CARD, PAGES_CARD];
      held.sourceNames = { ...held.sourceNames, outlook: 'Outlook', notion: 'Notion', 'names-only': 'Names only' };
    });

    function leavingTo(): ReturnType<typeof vi.fn> {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      return leaving;
    }

    it.each([
      { situation: 'left unticked, Connect carries a no', tick: false, leaves: '/v1/workspaces/ws-work/connections/outlook/connect?choice=flag&filesByName=false' },
      { situation: 'ticked, Connect carries a yes', tick: true, leaves: '/v1/workspaces/ws-work/connections/outlook/connect?choice=flag&filesByName=true' },
    ])('Connect starts unticked and, $situation', async ({ tick, leaves }) => {
      const leaving = leavingTo();
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Outlook' }));
      const asked = await screen.findByRole('dialog', { name: 'Connect Outlook' });
      const box = within(asked).getByRole('checkbox', { name: TICK_BOX });
      expect(box).not.toBeChecked();
      if (tick) await userEvent.click(box);
      expect(leaving).not.toHaveBeenCalled();
      await userEvent.click(within(asked).getByRole('button', { name: 'Connect' }));

      expect(leaving).toHaveBeenCalledWith(leaves);
    });

    it('asks even where the connector has no choice to ask, and carries the answer alone', async () => {
      const leaving = leavingTo();
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Names only' }));
      const asked = await screen.findByRole('dialog', { name: 'Connect Names only' });
      await userEvent.click(within(asked).getByRole('checkbox', { name: TICK_BOX }));
      await userEvent.click(within(asked).getByRole('button', { name: 'Connect' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/names-only/connect?filesByName=true');
    });

    it.each([
      { situation: 'a row filing by name starts ticked, and keeps it', on: true, leaves: 'filesByName=true' },
      { situation: 'a row not filing by name starts unticked', on: false, leaves: 'filesByName=false' },
    ])('Reconnect on $situation', async ({ on, leaves }) => {
      const leaving = leavingTo();
      held.sourceAccounts = [{ ...FAILING_MAIL, filesByName: on }];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada’s mail' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));
      const asked = await screen.findByRole('dialog', { name: 'Connect Outlook' });
      expect((within(asked).getByRole('checkbox', { name: TICK_BOX }) as HTMLInputElement).checked).toBe(on);
      await userEvent.click(within(asked).getByRole('button', { name: 'Connect' }));

      expect(leaving).toHaveBeenCalledWith(`/v1/workspaces/ws-work/connections/outlook/connect?choice=flag&${leaves}`);
    });

    it('Reconnect carries the answer given on that Reconnect, not the row’s', async () => {
      const leaving = leavingTo();
      held.sourceAccounts = [{ ...FAILING_MAIL, filesByName: true }];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada’s mail' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));
      const asked = await screen.findByRole('dialog', { name: 'Connect Outlook' });
      await userEvent.click(within(asked).getByRole('checkbox', { name: TICK_BOX }));
      await userEvent.click(within(asked).getByRole('button', { name: 'Connect' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/outlook/connect?choice=flag&filesByName=false');
    });

    it('a connector that reports no names asks no tick box', async () => {
      leavingTo();
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));
      const asked = await screen.findByRole('dialog', { name: 'Connect Notion' });

      expect(within(asked).queryByRole('checkbox')).toBeNull();
    });
  });

  /** "Switch Gmail onto the generic host, and take it out of the core", issue 944. */
  describe('a failing connection says why, and its row offers Reconnect, which signs in again under the choice it holds', () => {
    const GMAIL_CARD = {
      id: 'gmail',
      displayName: 'Gmail',
      cardText: 'Sign in with Google.',
      asksFirst: true,
      choice: {
        question: 'Bring in conversations',
        options: [
          { value: 'label', label: 'Labelled Cockpit' },
          { value: 'star', label: 'Starred (flagged in Outlook)' },
        ],
      },
    };
    const ANNA: SourceAccount = {
      ...ADA,
      id: 'account-anna',
      connectorId: 'gmail',
      displayName: 'anna@example.com',
      failingBecause: 'Gmail connects a new way now. Reconnect it to carry on.',
    };

    beforeEach(() => {
      held.registry = [TEAMS_CARD, GMAIL_CARD];
    });

    it.each([
      {
        situation: 'a row that made no choice starts the question at the first option',
        account: ANNA,
        starts: 'Labelled Cockpit',
        leaves: '/v1/workspaces/ws-work/connections/gmail/connect?choice=label',
      },
      {
        situation: 'a row that made one starts the question at it',
        account: { ...ANNA, follows: 'star', followsLabel: 'Starred (flagged in Outlook)' },
        starts: 'Starred (flagged in Outlook)',
        leaves: '/v1/workspaces/ws-work/connections/gmail/connect?choice=star',
      },
    ])('$situation', async ({ account, starts, leaves }) => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      held.sourceAccounts = [account];
      showWindow();

      expect(await screen.findByText(`Failing: ${ANNA.failingBecause}`)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Actions for anna@example.com' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));
      const asked = await screen.findByRole('dialog', { name: 'Connect Gmail' });
      expect(within(asked).getByRole('radio', { name: starts })).toBeChecked();
      expect(leaving).not.toHaveBeenCalled();
      await userEvent.click(within(asked).getByRole('button', { name: 'Connect' }));

      expect(leaving).toHaveBeenCalledWith(leaves);
    });

    it('a failing row of a connector that asks nothing leaves for its sign-in at once', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      held.sourceAccounts = [{ ...ADA, failingBecause: 'Microsoft no longer accepts the sign-in.' }];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reconnect' }));

      expect(leaving).toHaveBeenCalledWith('/v1/workspaces/ws-work/connections/teams/connect');
    });

    it.each([
      { situation: 'a row that is not failing', account: { ...ANNA, failingBecause: null } },
      { situation: 'a failing row of a source this environment cannot sign in to', account: { ...ANNA, connectorId: 'outlook' } },
    ])('offers no Reconnect on $situation', async ({ account }) => {
      held.sourceAccounts = [account];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: `Actions for ${account.displayName}` }));

      expect(screen.getByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Reconnect' })).toBeNull();
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
  });

  describe('the guest is offered no way to connect, disconnect or test, only how to connect their own', () => {
    it('says to sign in with Google in place of every Connect', async () => {
      showWindow(undefined, true);

      await screen.findByText(/Nothing connected yet/);
      expect(screen.getAllByText('Sign in with Google to connect your own')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /^Connect / })).toBeNull();
    });

    it('offers nothing to do to a connection the guest is shown', async () => {
      held.sourceAccounts = [ADA];

      showWindow(undefined, true);

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
    it('offers Teams to add when nothing is connected, and no Claude Code routine', async () => {
      showWindow();

      expect(await screen.findByText(/Nothing connected yet/)).toBeInTheDocument();
      // Nothing is connected, so each connector's name appears exactly once -
      // on its own Add-a-connection row.
      expect(await screen.findByText('Microsoft Teams')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Claude Code' })).toBeNull();
    });

    it('draws one card per registered connector, named and described as its manifest gives, and none for one the registry lacks', async () => {
      held.registry = [{ id: 'notion', displayName: 'Notion', cardText: 'Pages arrive as items.', asksFirst: false }];

      showWindow();

      expect(await screen.findByRole('button', { name: 'Connect Notion' })).toBeInTheDocument();
      expect(screen.getByText('Pages arrive as items.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Microsoft Teams' })).toBeNull();
      // No source is drawn that the registry does not hold.
      expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull();
    });

    it('shows Teams’ card with its manifest’s text', async () => {
      showWindow();

      expect(await screen.findByText(TEAMS_CARD.cardText)).toBeInTheDocument();
    });
  });
});

/** "Connect a phone in Settings by confirming a code texted to it", issue 1335. */
describe('Connector management', () => {
  const TEXT_MESSAGES_CARD = {
    id: 'twilio',
    displayName: 'Text messages',
    cardText: 'Text a note to Cockpit from your phone.',
    asksFirst: false,
    textedCode: { textTo: '+32460000000' },
  };
  const PHONE: SourceAccount = {
    id: 'account-phone',
    connectorId: 'twilio',
    displayName: '+32470123456',
    connectedAt: '2026-10-20T09:00:00.000Z',
    lastTestedAt: '2026-10-20T09:00:00.000Z',
    failingBecause: null,
    filesByName: false,
  };

  beforeEach(() => {
    held.registry = [TEAMS_CARD, TEXT_MESSAGES_CARD];
    held.sourceNames = { teams: 'Microsoft Teams', twilio: 'Text messages' };
  });

  /** Opens the form from the card and types a number into it. */
  async function typeANumber(number = '0470 12 34 56') {
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Text messages' }));
    await userEvent.type(await screen.findByLabelText('Mobile number'), number);
  }

  describe('the Text messages entry goes from number to code to connected', () => {
    it('asks for a number rather than leaving, and shows the code field once a code is sent', async () => {
      const leaving = vi.fn();
      vi.spyOn(window, 'location', 'get').mockReturnValue({ assign: leaving } as unknown as Location);
      showWindow();
      await typeANumber();
      expect(screen.queryByLabelText('Code')).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Send code' }));

      expect(await screen.findByLabelText('Code')).toBeInTheDocument();
      expect(held.phone.sent).toEqual([{ which: 'code', json: { number: '0470 12 34 56' } }]);
      expect(leaving).not.toHaveBeenCalled();
    });

    it('lists the number with the Cockpit number to text once the code is confirmed', async () => {
      held.phone.confirm.connects = PHONE;
      showWindow();
      await typeANumber();
      await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
      await userEvent.type(await screen.findByLabelText('Code'), '123456');

      await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));

      expect(await screen.findByText(/is connected\. Text \+32460000000/)).toBeInTheDocument();
      expect(held.phone.sent.at(-1)).toEqual({
        which: 'confirm',
        json: { number: '0470 12 34 56', code: '123456' },
      });
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(await screen.findByText('+32470123456')).toBeInTheDocument();
      expect(screen.getByText(/^Text messages · text \+32460000000 to add a note/)).toBeInTheDocument();
    });

    it.each([
      {
        situation: 'a number the server refuses',
        arrange: () => {
          held.phone.code = { status: 400, body: { error: 'Only Belgian mobile numbers can be connected, like +32 470 12 34 56.' } };
        },
        says: 'Only Belgian mobile numbers can be connected, like +32 470 12 34 56.',
        codeField: false,
      },
      {
        situation: 'an hour’s codes already asked for',
        arrange: () => {
          held.phone.code = { status: 429, body: { error: 'Too many codes were asked for in the last hour. Try again later.' } };
        },
        says: 'Too many codes were asked for in the last hour. Try again later.',
        codeField: false,
      },
      {
        situation: 'Twilio failing to send',
        arrange: () => {
          held.phone.code = { status: 502, body: { error: 'Twilio could not be reached. Try again shortly.' } };
        },
        says: 'Twilio could not be reached. Try again shortly.',
        codeField: false,
      },
      {
        situation: 'a code the server refuses',
        arrange: () => {
          held.phone.confirm = { status: 400, body: { error: 'That is not the code. Check it and try again.' }, connects: null };
        },
        says: 'That is not the code. Check it and try again.',
        codeField: true,
      },
      {
        situation: 'Twilio unreachable on Confirm',
        arrange: () => {
          held.phone.confirm = { status: 502, body: { error: 'Twilio could not be reached. Try again shortly.' }, connects: null };
        },
        says: 'Twilio could not be reached. Try again shortly.',
        codeField: true,
      },
      {
        situation: 'a server that cannot be reached at all',
        arrange: () => {
          held.phone.unreachable = true;
        },
        says: 'That did not reach the server. Try again.',
        codeField: false,
      },
    ])('says $situation under the field, with the number and code kept as typed', async ({ arrange, says, codeField }) => {
      showWindow();
      await typeANumber('0471 99 99 99');
      if (codeField) {
        await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
        await userEvent.type(await screen.findByLabelText('Code'), '654321');
      }
      arrange();

      await userEvent.click(screen.getByRole('button', { name: codeField ? 'Confirm' : 'Send code' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(says);
      expect(screen.getByLabelText('Mobile number')).toHaveValue('0471 99 99 99');
      if (codeField) expect(screen.getByLabelText('Code')).toHaveValue('654321');
      expect(screen.queryByText(/is connected\./)).toBeNull();
    });

    it('offers a connected phone Disconnect and nothing that signs in again', async () => {
      held.sourceAccounts = [PHONE];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for +32470123456' }));

      expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Reconnect' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Change…' })).toBeNull();
    });

    it('offers no Text messages where the environment has not configured it', async () => {
      held.registry = [TEAMS_CARD];

      showWindow();

      expect(await screen.findByRole('button', { name: 'Connect Microsoft Teams' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect Text messages' })).toBeNull();
    });
  });
});

/** "See when a pulled connection was checked, and why it failed, from its row's History…", issue 1140. */
describe('Connector management', () => {
  const ANNA: SourceAccount = {
    id: 'account-anna',
    connectorId: 'gmail',
    displayName: 'anna@example.com',
    connectedAt: '2026-10-01T09:00:00.000Z',
    lastTestedAt: '2026-10-16T12:20:00.000Z',
    filesByName: false,
    failingBecause: null,
    keepsHistory: true,
    pulled: true,
  };
  /** A Teams connection: the source pushes to it, so it keeps a history and has nothing to check (issue 1144). */
  const PUSHED: SourceAccount = { ...ADA, keepsHistory: true };
  /** A moment of the day, in this machine's own time, as the view reads it. */
  const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute).toISOString();
  const none = { count: 0, items: [] as { id: string; title: string | null; dismissed: boolean }[] };
  const didNothing = { broughtIn: none, closed: none, sentBack: none, refused: none };
  const line = (over: Record<string, unknown>) => ({
    id: crypto.randomUUID(),
    outcome: 'worked',
    reason: 'scheduled',
    message: null,
    messageCut: false,
    status: null,
    count: 1,
    firstAt: at(16, 9, 5),
    lastAt: at(16, 9, 5),
    did: didNothing,
    ...over,
  });

  async function openHistory(account: SourceAccount = ANNA) {
    await userEvent.click(await screen.findByRole('button', { name: `Actions for ${account.displayName}` }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'History…' }));
    return screen.findByRole('region', { name: `History of ${account.displayName}` });
  }

  describe('History… is on the menu of a connection that keeps a history, and its Failing: line opens it', () => {
    it.each([
      { situation: 'a connected Gmail row', account: ANNA, offered: true },
      { situation: 'a connected Outlook row', account: { ...ANNA, connectorId: 'outlook' }, offered: true },
      { situation: 'a Teams row, which pushes and keeps a history', account: PUSHED, offered: true },
      { situation: 'a row of a connector that keeps none', account: ADA, offered: false },
    ])('$situation', async ({ account, offered }) => {
      held.sourceAccounts = [account];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: `Actions for ${account.displayName}` }));

      expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'History…' }) !== null).toBe(offered);
    });

    it('opens the history of a failing row from its Failing: line', async () => {
      held.sourceAccounts = [{ ...ANNA, failingBecause: 'Google refused the sign-in' }];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Failing: Google refused the sign-in' }));

      expect(await screen.findByRole('region', { name: 'History of anna@example.com' })).toBeInTheDocument();
      expect(held.historyAskedFor).toEqual(['account-anna']);
    });

    it('goes back to the Connections of the same workspace with ‹ Connections', async () => {
      held.sourceAccounts = [ANNA];
      showWindow();
      await openHistory();
      expect(screen.queryByText('Add a connection')).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: '‹ Connections' }));

      expect(await screen.findByText('Add a connection')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Actions for anna@example.com' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /^History of/ })).toBeNull();
    });
  });

  describe('Check now is on the menu and at the head of the history of a connection that keeps one, and nowhere else', () => {
    it.each([
      { situation: 'a connected Gmail row', account: ANNA, offered: true },
      { situation: 'a connected Outlook row', account: { ...ANNA, connectorId: 'outlook' }, offered: true },
      { situation: 'a Teams row, which is pushed to and has nothing to check', account: PUSHED, offered: false },
      { situation: 'a row of a connector that keeps no history', account: ADA, offered: false },
    ])('$situation', async ({ account, offered }) => {
      held.sourceAccounts = [account];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: `Actions for ${account.displayName}` }));

      expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Check now' }) !== null).toBe(offered);
    });

    it('has no Check now at the head of a pushed connection’s history', async () => {
      held.sourceAccounts = [PUSHED];
      showWindow();

      const history = await openHistory(PUSHED);

      expect(within(history).queryByRole('button', { name: 'Check now' })).toBeNull();
      expect(await within(history).findByText('Nothing delivered yet.')).toBeInTheDocument();
    });

    it('asks for the check of the row it was pressed on, and says so on the list', async () => {
      held.sourceAccounts = [ANNA];
      showWindow();

      await userEvent.click(await screen.findByRole('button', { name: 'Actions for anna@example.com' }));
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Check now' }));

      expect(checkedNow).toEqual(['account-anna']);
      expect(await screen.findByRole('status')).toHaveTextContent('Checking anna@example.com now.');
    });

    it('asks for the check from the head of the history it is open on, and says so there', async () => {
      held.sourceAccounts = [ANNA];
      showWindow();
      const history = await openHistory();

      await userEvent.click(within(history).getByRole('button', { name: 'Check now' }));

      expect(checkedNow).toEqual(['account-anna']);
      expect(await within(history).findByRole('status')).toHaveTextContent('Checking anna@example.com now.');
    });

    it('says when the request did not reach the server', async () => {
      checkNowReaches = false;
      held.sourceAccounts = [ANNA];
      showWindow();
      const history = await openHistory();

      await userEvent.click(within(history).getByRole('button', { name: 'Check now' }));

      expect(await within(history).findByRole('alert')).toHaveTextContent('That did not reach the server. Try again.');
    });
  });

  describe('a connection’s history is grouped by day, newest first, and says each outcome in words', () => {
    beforeEach(() => {
      // Only the clock, so the reads still settle on their own.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 16, 14, 0));
      held.sourceAccounts = [ANNA];
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('heads today’s lines Today and yesterday’s Yesterday', async () => {
      held.history = [line({ lastAt: at(16, 9, 5), firstAt: at(16, 9, 5) }), line({ lastAt: at(15, 22, 0), firstAt: at(15, 22, 0) })];
      showWindow();
      const history = await openHistory();

      expect(within(history).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Today', 'Yesterday']);
      expect(within(within(history).getByRole('region', { name: 'Yesterday' })).getByText('Worked')).toBeInTheDocument();
    });

    it('names the year of a day from another year, and keeps the same date a year apart as two days', async () => {
      const lastYear = new Date(2025, 9, 5, 9, 0).toISOString();
      const yearBefore = new Date(2024, 9, 5, 9, 0).toISOString();
      held.history = [
        line({ firstAt: lastYear, lastAt: lastYear }),
        line({ outcome: 'failed', message: 'unavailable', firstAt: yearBefore, lastAt: yearBefore }),
      ];
      showWindow();
      const history = await openHistory();

      const headings = within(history).getAllByRole('heading', { level: 4 }).map((h) => h.textContent!);
      expect(headings).toHaveLength(2);
      expect(headings[0]).toContain('2025');
      expect(headings[1]).toContain('2024');
    });

    it.each([
      {
        situation: 'a single check that worked, with why it ran',
        held: line({ reason: 'follow-up' }),
        says: 'Worked',
        detail: ' · Follow-up',
      },
      {
        situation: 'a single check a person asked for',
        held: line({ reason: 'check-now' }),
        says: 'Worked',
        detail: ' · Check now',
      },
      {
        situation: 'a folded quiet line, with its span',
        held: line({ count: 40, firstAt: at(16, 9, 5), lastAt: at(16, 12, 20) }),
        says: 'Checked 40 times, nothing new',
        detail: null,
        span: true,
      },
      {
        situation: 'a single failure, with why it ran and its message',
        held: line({ outcome: 'failed', message: 'unavailable' }),
        says: 'Failed',
        detail: ' · Scheduled · unavailable',
      },
      {
        situation: 'a folded failure, with its span and message',
        held: line({ outcome: 'failed', message: 'unavailable', count: 41, firstAt: at(16, 8, 50), lastAt: at(16, 12, 10) }),
        says: 'Failed 41 times',
        detail: ' · unavailable',
        span: true,
      },
      {
        situation: 'a failure whose message was cut, marked so',
        held: line({ outcome: 'failed', message: 'a long story', messageCut: true }),
        says: 'Failed',
        detail: ' · Scheduled · a long story…',
      },
      {
        situation: 'a failure with a status and a message, the status first',
        held: line({ outcome: 'failed', message: 'unavailable', status: 503 }),
        says: 'Failed',
        detail: ' · Scheduled · HTTP 503 · unavailable',
      },
      {
        situation: 'a failure with a status and no message, the status alone',
        held: line({ outcome: 'failed', status: 403 }),
        says: 'Failed',
        detail: ' · Scheduled · HTTP 403',
      },
      {
        situation: 'a failure that said nothing',
        held: line({ outcome: 'failed', reason: 'a reason from a later release' }),
        says: 'Failed',
        detail: null,
      },
    ])('$situation', async ({ held: one, says, detail, span }) => {
      held.history = [one];
      showWindow();
      const history = await openHistory();

      const shown = within(history).getByText(says);
      const row = shown.closest('li')!;
      expect(row.textContent).toBe(`${row.firstChild!.textContent}${says}${detail ?? ''}`);
      expect(row.firstChild!.textContent!.includes('–')).toBe(span === true);
    });

    it('lists what a check did, each Item named and opening its form, a dismissed one and one not held left unopenable', async () => {
      held.history = [
        line({
          did: {
            ...didNothing,
            broughtIn: { count: 2, items: [{ id: 'item-1', title: 'Invoice 2026-118 from Acme', dismissed: false }, { id: 'item-2', title: 'Re: Q4 planning', dismissed: false }] },
            sentBack: { count: 1, items: [{ id: 'item-3', title: 'Lunch on Thursday?', dismissed: true }] },
            refused: { count: 1, items: [{ id: 'item-4', title: null, dismissed: false }] },
          },
        }),
      ];
      showWindow();
      const history = await openHistory();

      const row = within(history).getByText('Worked').closest('li')!;
      expect(row.textContent).toContain('Worked · Scheduled · Brought in 2, Sent back 1, Refused 1');
      expect(row.textContent).toContain('New: Invoice 2026-118 from Acme, Re: Q4 planning');
      expect(row.textContent).toContain('Sent back: Lunch on Thursday? (dismissed)');
      expect(row.textContent).toContain('Refused: an Item no longer in Cockpit');
      await userEvent.click(within(row).getByRole('button', { name: 'Re: Q4 planning' }));
      expect(held.opened).toEqual(['item-2']);
      expect(within(row).queryByRole('button', { name: 'an Item no longer in Cockpit' })).toBeNull();
      expect(within(row).queryByRole('button', { name: /Lunch on Thursday/ })).toBeNull();
    });

    it('says how many more a count holds than the Items the line names', async () => {
      held.history = [
        line({ did: { ...didNothing, closed: { count: 60, items: [{ id: 'item-1', title: 'One', dismissed: false }] } } }),
      ];
      showWindow();
      const history = await openHistory();

      expect(within(history).getByText('Worked').closest('li')!.textContent).toContain('Closed: One and 59 more');
    });

    it('says No checks yet where there are none', async () => {
      showWindow();
      const history = await openHistory();

      expect(await within(history).findByText('No checks yet.')).toBeInTheDocument();
    });

    it('offers the load failure’s way to try again where the read fails, and reads again', async () => {
      held.history = 'fails';
      showWindow();
      const history = await openHistory();

      const retry = await within(history).findByRole('button', { name: 'Try again' });
      held.history = [line({})];
      await userEvent.click(retry);

      expect(await within(history).findByText('Worked')).toBeInTheDocument();
      expect(held.historyAskedFor).toEqual(['account-anna', 'account-anna']);
    });

    it('reads it again on opening it again, never drawing the read before', async () => {
      held.history = [line({})];
      showWindow();
      expect(await within(await openHistory()).findByText('Worked')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '‹ Connections' }));

      held.history = 'fails';
      const again = await openHistory();

      expect(await within(again).findByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(within(again).queryByText('Worked')).toBeNull();
      expect(held.historyAskedFor).toEqual(['account-anna', 'account-anna']);
    });
  });

  /** "Keep a connection's history 30 days, and fold a quiet past day into one line", issue 1145. */
  describe('a past day with no failure folds into one line that expands, and the history says where older days remain', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 9, 16, 14, 0));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const broughtIn = (id: string) => ({
      did: { ...didNothing, broughtIn: { count: 1, items: [{ id, title: `Item ${id}`, dismissed: false }] } },
    });
    /** A day's lines, newest first: 285 quiet checks around three that each brought an Item in. */
    const aQuietDay = (day: number, over: Record<string, unknown> = {}) => [
      line({ firstAt: at(day, 18, 0), lastAt: at(day, 23, 55), count: 200 }),
      line({ firstAt: at(day, 17, 55), lastAt: at(day, 17, 55), ...broughtIn(`${day}-c`) }),
      line({ firstAt: at(day, 12, 0), lastAt: at(day, 12, 0), ...broughtIn(`${day}-b`), ...over }),
      line({ firstAt: at(day, 9, 0), lastAt: at(day, 9, 0), ...broughtIn(`${day}-a`) }),
      line({ firstAt: at(day, 0, 0), lastAt: at(day, 8, 55), count: 85 }),
    ];
    const failed = { outcome: 'failed', message: 'unavailable', did: didNothing };
    const hhmm = (moment: string) => new Date(moment).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    /** Yesterday's quiet day, its first quiet checks folded on from the evening before. */
    const begunTheEveningBefore = aQuietDay(15).map((one, index, all) =>
      index === all.length - 1 ? { ...one, firstAt: at(14, 20, 0) } : one,
    );

    it.each([
      { situation: 'yesterday, every check worked', lines: aQuietDay(15), day: 'Yesterday', folds: true },
      {
        situation: 'yesterday, its first quiet checks begun the evening before',
        lines: begunTheEveningBefore,
        day: 'Yesterday',
        folds: true,
      },
      { situation: 'yesterday, with one failure', lines: aQuietDay(15, failed), day: 'Yesterday', folds: false },
      { situation: 'today, every check worked', lines: aQuietDay(16), day: 'Today', folds: false },
      { situation: 'yesterday, a single line', lines: aQuietDay(15).slice(0, 1), day: 'Yesterday', folds: false },
      {
        situation: 'yesterday, the oldest day shown, where older lines remain than the history shows',
        lines: aQuietDay(15),
        day: 'Yesterday',
        folds: false,
        olderRemain: true,
      },
      {
        situation: 'yesterday, a pushed connection’s deliveries',
        lines: aQuietDay(15).slice(1, 4).map((one) => ({ ...one, reason: 'delivery' })),
        day: 'Yesterday',
        folds: false,
        account: PUSHED,
      },
    ])('$situation', async ({ lines, day, folds, account = ANNA, olderRemain = false }) => {
      held.sourceAccounts = [account];
      held.history = lines;
      held.olderRemain = olderRemain;
      showWindow();
      const history = await openHistory(account);

      const shown = within(await within(history).findByRole('region', { name: day })).getAllByRole('listitem');
      if (folds) {
        expect(shown).toHaveLength(1);
        // The span is the day's own, from its midnight however early its first quiet checks began.
        expect(shown[0]!.textContent).toBe(
          `${hhmm(at(15, 0, 0))}–${hhmm(at(15, 23, 55))}Checked 288 times · 3 brought something in · show them`,
        );
      } else {
        expect(shown).toHaveLength(lines.length);
        expect(within(history).queryByRole('button', { name: 'show them' })).toBeNull();
      }
    });

    it('shows the day’s own lines when show them is pressed, and folds them again with hide them', async () => {
      held.sourceAccounts = [ANNA];
      held.history = [...aQuietDay(16), ...aQuietDay(15)];
      showWindow();
      const history = await openHistory();
      const yesterday = await within(history).findByRole('region', { name: 'Yesterday' });

      await userEvent.click(within(yesterday).getByRole('button', { name: 'show them' }));

      expect(within(yesterday).getAllByRole('listitem')).toHaveLength(6);
      expect(within(yesterday).getByRole('button', { name: 'Item 15-b' })).toBeInTheDocument();
      expect(within(within(history).getByRole('region', { name: 'Today' })).getAllByRole('listitem')).toHaveLength(5);
      await userEvent.click(within(yesterday).getByRole('button', { name: 'hide them' }));
      expect(within(yesterday).getAllByRole('listitem')).toHaveLength(1);
    });

    it.each([
      {
        situation: 'older lines remain than the read carries',
        olderRemain: true,
        says: `Older days follow, back to ${new Date(2026, 8, 16).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`,
      },
      { situation: 'the read carries every line', olderRemain: false, says: null },
    ])('ends saying how far back older days go only where $situation', async ({ olderRemain, says }) => {
      held.sourceAccounts = [ANNA];
      held.history = [line({})];
      held.olderRemain = olderRemain;
      showWindow();
      const history = await openHistory();
      await within(history).findByText('Worked');

      expect(within(history).queryByText(/^Older days follow/)?.textContent ?? null).toBe(says);
    });
  });
});