import { useRef, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  registeredConnectorListSchema,
  sourceAccountListSchema,
  uuidv7,
  type RegisteredConnectorList,
  type SourceAccount,
  type SourceAccountList,
} from '@cockpit/shared';
import { api, refusal } from '../api/client';
import { refusalFrom, snapshotQuery, useCommand, useConnectClaudeCode, useTestClaudeCodeConnection } from '../api/queries';
import type { ConnectOutcome, RefusedBecause } from '../connections';
import { sourceNamed, type SourceNames } from '../itemSource';
import { ConnectEngine } from './engines';
import { ChangeConnectionChoice, ConnectWithChoice, type ConnectorChoice } from './ConnectionChoice';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';

/**
 * The source accounts one Workspace has connected, oldest first. Kept here
 * rather than in `api/client.ts`/`api/queries.ts` with every other read - the
 * one thing this window alone asks for is the one thing worth this chunk's
 * own weight rather than the initial bundle's (`bundle:budget`).
 */
async function fetchSourceAccounts(workspaceId: string): Promise<SourceAccountList> {
  const res = await api.v1.workspaces[':workspaceId'].connections.$get({ param: { workspaceId } });
  if (!res.ok) throw refusal('connections', res.status);
  return sourceAccountListSchema.parse(await res.json());
}

/** The connectors the registry holds, which the Add-a-connection cards are drawn from (issue 894). */
async function fetchRegisteredConnectors(): Promise<RegisteredConnectorList> {
  const res = await api.v1.connectors.$get();
  if (!res.ok) throw refusal('connectors', res.status);
  return registeredConnectorListSchema.parse(await res.json());
}

/**
 * What a trip that did not connect says where its connector gave no sentence
 * of its own: trying again is the whole advice.
 */
const REFUSED = 'That did not connect. Nothing was stored. Try again.';

/**
 * **Never served from a copy.** The window says what is connected *now*, and
 * the two moments it is read are the two where a copy would be wrong: coming
 * back from Microsoft, where the row was made a redirect ago, and reopening
 * it after a disconnect made in another tab. The issue asks for exactly
 * this - "Reopening Manage Connections always shows current stored state,
 * never an optimistic guess."
 *
 * The query key (`['sourceAccounts', workspaceId]`) is matched by
 * `api/queries.ts`'s own `afterChanging` invalidation on
 * `disconnect_source_account`, and by `useConnectClaudeCode`/
 * `useTestClaudeCodeConnection`'s own invalidation there.
 */
const sourceAccountsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ['sourceAccounts', workspaceId],
    queryFn: () => fetchSourceAccounts(workspaceId),
    staleTime: 0,
  });

/**
 * Connecting a registered source is a navigation, not a request: the browser
 * leaves for Microsoft and comes back to a page, so there is nothing here to
 * await and nothing to parse - the same shape `SIGN_IN_PATH` (`api/client.ts`)
 * has, and the same reason.
 *
 * It comes back to `/w/<workspaceId>?connections=connected|refused`, which is
 * what reopens this window over the Workspace it was started from.
 */
function connectPath(workspaceId: string, connectorId: string, choice?: string): string {
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectorId)}/connect`;
  // The answer to the connector's one question, which the Worker carries
  // through the source in the attempt it keeps (issue 942).
  return choice === undefined ? path : `${path}?choice=${encodeURIComponent(choice)}`;
}

/**
 * The one source the registry does not hold, named here and nowhere else in
 * this app: Claude Code, until "Decide how Claude Code and other outbound
 * integrations sit behind a boundary" (issue 879). Every other card comes from
 * the registry ("List the registry's connectors in the Connections window",
 * issue 894), and every name a row says from the Workspace's snapshot ("Take
 * source names out of the shared contract", issue 927), so adding a source
 * touches no file in this app.
 */
const CLAUDE_CODE = 'claude-code';
const CLAUDE_CODE_CARD: Card = {
  id: CLAUDE_CODE,
  name: 'Claude Code',
  text: 'A routine that starts a Claude Code session on this workspace’s items.',
};

/** One connector Add a connection offers. */
interface Card {
  id: string;
  name: string;
  text: string;
  /** What its connector asks before Connect leaves, where it asks anything (issue 942). */
  choice?: ConnectorChoice | undefined;
}

/** What the guest is told in place of every way to connect. */
const GUEST_SENTENCE = 'Sign in with Google to connect your own';

/**
 * What a connected row says under its name: the source, the choice it made
 * where its connector asks one, in the connector's own words (issue 942), and
 * when it last worked - for a connection that made a choice, when it was last
 * checked (issue 725).
 */
function rowDetail(account: SourceAccount, names: SourceNames): string {
  const source = sourceNamed(names, account.connectorId);
  const what = account.follows ? `${source} · ${account.followsLabel ?? account.follows}` : source;
  if (!account.lastTestedAt) return what;
  return `${what} · ${account.follows ? 'last checked' : 'last worked'} ${new Date(account.lastTestedAt).toLocaleString()}`;
}

/**
 * Where a Workspace's source accounts are managed ("Connect a Microsoft Teams
 * source account", issue 485; "Connect a workspace to Claude Code", issue
 * 569): what is connected, and what can be added.
 *
 * **Two lists, not a list with one connector's card fixed above it.** What is
 * connected can be acted on - Disconnect for Teams, and for Claude Code also
 * Test again and Edit…; what can be added is a compact row per connector,
 * each offering Connect except Claude Code once one is already held, a
 * workspace being allowed only one (rule 6).
 *
 * **Workspace-scoped, unlike `ManageTypes` beside it.** A connection belongs
 * to the Workspace that made it and no other Workspace ever sees it, which is
 * why it is opened from the Workspace's own tab rather than from the header's
 * menu, and why every read and every change here names a Workspace.
 *
 * **What it shows is always what is stored.** The list is never served from a
 * copy (`sourceAccountsQuery`) and nothing here is drawn before the server has
 * agreed to it: connecting Teams comes back from Microsoft as a fresh read,
 * connecting or testing Claude Code waits for the server's own answer, and
 * disconnecting waits for the row to be gone. An optimistic row is the one
 * thing this window must not draw - it would say a credential exists.
 */
export default function ManageConnections({
  workspaceId,
  workspaceName,
  /** How the last connect attempt went, where the browser has just come back from one. */
  outcome,
  because,
  open,
  onClose,
  returnFocusTo,
  section,
  picker,
  guest = false,
}: {
  /**
   * Which cards and rows: the sources under Connections (what the registry
   * holds), Claude Code under Agent settings (Settings,
   * `SettingsWindow.tsx`). Absent, every kind is shown.
   */
  section?: 'sources' | 'agents' | undefined;
  /**
   * The shared guest, who connects nothing: the server refuses it anyway
   * (`auth/guest-connections.ts`), so this offers the way to connect one's own
   * in place of every Connect, Disconnect, Test and Edit (issue 772).
   */
  guest?: boolean | undefined;
  /** What picks the workspace, drawn under the intro. */
  picker?: React.ReactNode;
  workspaceId: string;
  workspaceName: string;
  outcome?: ConnectOutcome | undefined;
  /** Which connector refused the grant, and the code it gave, where its own account step did. */
  because?: RefusedBecause | undefined;
  open: boolean;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data, error, refetch, isFetching } = useQuery({
    ...sourceAccountsQuery(workspaceId),
    // Said rather than assumed: the tabs only render this while it is open
    // (`WorkspaceTabs.tsx`), and a list read for a shut window would be a
    // request nobody asked for.
    enabled: open,
  });
  // What each source is called, from the Workspace's own snapshot, which is
  // read anyway - and kept, so the rows are named offline too. Never stale
  // here, so opening this window never re-reads the whole snapshot (which
  // also counts as a guest opening Dashboards); the Workspace's own readers
  // keep it current.
  const { data: names } = useQuery({
    ...snapshotQuery(workspaceId),
    enabled: open,
    staleTime: Infinity,
    select: (snapshot) => snapshot.sourceNames,
  });
  const registry = useQuery({
    queryKey: ['registeredConnectors'],
    queryFn: fetchRegisteredConnectors,
    // Only Connections draws from it.
    enabled: open && section !== 'agents',
  });
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [claudeCodeForm, setClaudeCodeForm] = useState(false);
  const [claudeCodeFormPending, setClaudeCodeFormPending] = useState(false);
  const [claudeCodeMessage, setClaudeCodeMessage] = useState<string | null>(null);
  /**
   * The card whose connector's question is being asked before Connect leaves
   * (issue 942) - and the option to start at, where a row is being reconnected.
   */
  const [asking, setAsking] = useState<(Card & { choice: ConnectorChoice; startAt?: string | undefined }) | null>(null);
  const askingOpenedFrom = useRef<HTMLElement | null>(null);
  /** The row whose choice is being changed with *Change…* (issue 942). */
  const [changingChoice, setChangingChoice] = useState<SourceAccount | null>(null);
  const choiceOpenedFrom = useRef<HTMLElement | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const claudeCodeOpenedFrom = useRef<HTMLElement | null>(null);
  /**
   * The window itself, which the focus goes back to once a disconnect has
   * taken the row's menu with the row - the reason `ManageTypes` keeps one.
   */
  const list = useRef<HTMLDivElement>(null);
  const command = useCommand();
  const testClaudeCode = useTestClaudeCodeConnection(workspaceId);

  const registered = (registry.data?.connectors ?? [])
    // The named card wins over a registered connector of the same id.
    .filter((connector) => connector.id !== CLAUDE_CODE)
    .map((connector): Card => ({
      id: connector.id,
      name: connector.displayName,
      text: connector.cardText,
      choice: connector.choice,
    }));
  /** The connector's own sentence for why it refused, where the listing holds one for the code. */
  const refusalGiven = because
    ? Object.entries(
        registry.data?.connectors.find((connector) => connector.id === because.connectorId)?.refusals ?? {},
      ).find(([code]) => code === because.code)?.[1]
    : undefined;
  const cards = [
    ...(section !== 'agents' ? registered : []),
    ...(section !== 'sources' ? [CLAUDE_CODE_CARD] : []),
  ];
  const connected = (data?.sourceAccounts ?? []).filter(
    (account) =>
      !section || (section === 'agents') === (account.connectorId === CLAUDE_CODE),
  );
  /**
   * Saying "nothing connected" is a claim about what this Workspace holds, so
   * it needs an answer to have arrived - the same lie `ManageTypes` records,
   * where `?? []` made a failed read look like an empty account.
   */
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;
  const beingDisconnected = connected.find((account) => account.id === disconnecting);
  const claudeCodeConnected = connected.find((account) => account.connectorId === CLAUDE_CODE);

  const startDisconnecting = (account: SourceAccount, openedFrom: HTMLElement | null) => {
    command.reset();
    askedFrom.current = openedFrom;
    setDisconnecting(account.id);
  };

  const stopAsking = () => {
    setDisconnecting(null);
    command.reset();
  };

  const openClaudeCodeForm = (openedFrom: HTMLElement | null) => {
    claudeCodeOpenedFrom.current = openedFrom;
    setClaudeCodeMessage(null);
    setClaudeCodeForm(true);
  };

  /**
   * Closing drops the disconnect being asked about and the Claude Code form,
   * as well as shutting the window, so what the tabs unmount is never a
   * question or a form left half-answered.
   */
  const close = () => {
    stopAsking();
    setClaudeCodeForm(false);
    setAsking(null);
    setChangingChoice(null);
    onClose();
  };

  /**
   * Leaves the application for the source, and comes back to this Workspace
   * with this window open over it - a whole-page navigation like signing in,
   * rather than a popup nothing else in this app uses.
   */
  const connectRegistered = (connectorId: string, choice?: string) => {
    window.location.assign(connectPath(workspaceId, connectorId, choice));
  };
  /** What a connected row's connector asks, where it asks anything - and so whether the row offers *Change…*. */
  const choiceOf = (connectorId: string): ConnectorChoice | undefined =>
    registry.data?.connectors.find((connector) => connector.id === connectorId)?.choice;
  /**
   * Signs a failing row in again through its connector: the question first
   * where it asks one, starting at the row's own answer, and the same trip as
   * Connect - which stores the new sign-in on the same row, ending what said
   * it was failing (issue 944).
   */
  const reconnect = (account: SourceAccount, openedFrom: HTMLElement | null) => {
    const card = registered.find((one) => one.id === account.connectorId);
    if (!card) return;
    if (card.choice) {
      askingOpenedFrom.current = openedFrom;
      setAsking({ ...card, choice: card.choice, startAt: account.follows });
    } else connectRegistered(card.id);
  };

  // Named apart from the imported `refusal` above, which builds an Error from
  // a failed read rather than the string this reads off a failed command.
  const commandRefusal = refusalFrom(command);

  return (
    <ManageWindow
      title={`Connections of ${workspaceName}`}
      open={open}
      onClose={close}
      canClose={!command.isPending && !testClaudeCode.isPending && !claudeCodeFormPending}
      returnFocusTo={returnFocusTo}
      ref={list}
    >
      <p className="mt-2 text-sm text-ink-faint">
        The accounts this workspace is connected to. No other workspace sees them.
      </p>
      {picker}

      {outcome === 'connected' && (
        <p role="status" className="pt-3 text-sm text-ink-soft">
          Connected.
        </p>
      )}
      {outcome === 'refused' && (
        <p role="alert" className="pt-3 text-sm text-over-ink">
          {refusalGiven ?? REFUSED}
        </p>
      )}

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Connected
      </h3>
      <section className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto">
        <ul>
          {connected.map((account) => (
            <li key={account.id} className="border-b border-shade/5 px-4 py-2 last:border-b-0">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{account.displayName}</p>
                  <p className="text-sm text-ink-faint">{rowDetail(account, names)}</p>
                  {/* Why Claude last refused to start a session through it,
                      until one starts again ("Drop an agent on an item to
                      start a Claude Code session on it", issue 571). */}
                  {account.failingBecause && (
                    <p className="text-sm text-over-ink">Failing: {account.failingBecause}</p>
                  )}
                </div>
                {!guest && <RowMenu
                  label={`Actions for ${account.displayName}`}
                  entries={[
                    ...(account.connectorId === CLAUDE_CODE
                      ? [
                          {
                            label: 'Test again',
                            keepsFocus: true,
                            onSelect: () => {
                              setClaudeCodeMessage(null);
                              testClaudeCode.mutate(account.id, {
                                onSuccess: (result) => {
                                  if (!result.accepted) setClaudeCodeMessage(result.message);
                                },
                                // The request itself failing (offline, a 5xx,
                                // the row having just been disconnected
                                // elsewhere) is not the same as Claude
                                // refusing the test, but both leave the row
                                // exactly as it was - so both get the same
                                // one line rather than one of them getting
                                // none at all (found in review).
                                onError: () =>
                                  setClaudeCodeMessage('That did not reach the server. Try again.'),
                              });
                            },
                          },
                          {
                            label: 'Edit…',
                            onSelect: (openedFrom: HTMLElement | null) => openClaudeCodeForm(openedFrom),
                          },
                        ]
                      : []),
                    // A failing row of a connector this environment can sign
                    // in to: signing in again is what ends it (issue 944).
                    ...(account.failingBecause && registered.some((card) => card.id === account.connectorId)
                      ? [
                          {
                            label: 'Reconnect',
                            onSelect: (openedFrom: HTMLElement | null) => reconnect(account, openedFrom),
                          },
                        ]
                      : []),
                    // The connector's own choice, changed without signing in
                    // again (issue 942).
                    ...(account.connectorId !== CLAUDE_CODE && choiceOf(account.connectorId)
                      ? [
                          {
                            label: 'Change…',
                            onSelect: (openedFrom: HTMLElement | null) => {
                              choiceOpenedFrom.current = openedFrom;
                              setChangingChoice(account);
                            },
                          },
                        ]
                      : []),
                    {
                      label: 'Disconnect',
                      destructive: true,
                      onSelect: (openedFrom) => startDisconnecting(account, openedFrom),
                    },
                  ]}
                />}
              </div>
            </li>
          ))}
        </ul>
        {beingDisconnected && (
          <DeleteQuestion
            open
            question={`Disconnect ${beingDisconnected.displayName}? Cockpit forgets ${
              beingDisconnected.connectorId === CLAUDE_CODE
                ? 'the routine trigger it was connected with'
                : 'the sign-in it was connected with'
            }.`}
            confirmLabel={`Yes, disconnect ${beingDisconnected.displayName}`}
            confirmText="Disconnect"
            canConfirm={!command.isPending}
            refusal={commandRefusal}
            returnFocusTo={askedFrom.current}
            onCancel={stopAsking}
            onConfirm={() =>
              command.mutate(
                {
                  name: 'disconnect_source_account',
                  payload: {
                    commandId: uuidv7(),
                    issuedAt: new Date().toISOString(),
                    workspaceId,
                    sourceAccountId: beingDisconnected.id,
                  },
                },
                { onSuccess: () => setDisconnecting(null) },
              )
            }
          />
        )}
        {listFailed && (
          <div className="px-4 py-4">
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        )}
        {answered && connected.length === 0 && !isFetching && (
          <p className="px-4 py-4 text-sm text-ink-faint">Nothing connected yet. Add one below.</p>
        )}
        {claudeCodeMessage && (
          <p role="alert" className="px-4 py-2 text-sm text-over-ink">
            {claudeCodeMessage}
          </p>
        )}
      </section>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Add a connection
      </h3>
      <div className="mt-2 flex flex-col gap-2">
        {cards.map((card) => (
          <div
            key={card.id}
            className="flex items-center gap-3 rounded-md border border-shade/10 p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{card.name}</p>
              <p className="text-sm text-ink-faint">{card.text}</p>
            </div>
            {guest ? (
              <span className="shrink-0 text-sm text-ink-faint">{GUEST_SENTENCE}</span>
            ) : card.id === CLAUDE_CODE && claudeCodeConnected ? (
              <span className="shrink-0 text-sm text-ink-faint">Connected - one per workspace</span>
            ) : (
              <button
                type="button"
                // Two rows both reading "Connect" need two names for anyone
                // not reading them side by side - a screen reader, or a test.
                aria-label={`Connect ${card.name}`}
                onClick={(event) => {
                  if (card.id === CLAUDE_CODE) openClaudeCodeForm(event.currentTarget);
                  else if (card.choice) {
                    askingOpenedFrom.current = event.currentTarget;
                    setAsking({ ...card, choice: card.choice });
                  } else connectRegistered(card.id);
                }}
                disabled={command.isPending || testClaudeCode.isPending || claudeCodeFormPending}
                className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Connect
              </button>
            )}
          </div>
        ))}
      </div>

      <ConnectEngine
        open={claudeCodeForm}
        workspaceId={workspaceId}
        connectionId={claudeCodeConnected?.id}
        returnFocusTo={claudeCodeOpenedFrom.current}
        onClose={() => setClaudeCodeForm(false)}
        onPendingChange={setClaudeCodeFormPending}
      />

      <ConnectWithChoice
        connector={asking ? { displayName: asking.name, choice: asking.choice, startAt: asking.startAt } : null}
        onConnect={(value) => asking && connectRegistered(asking.id, value)}
        onClose={() => setAsking(null)}
        returnFocusTo={askingOpenedFrom.current}
      />

      <ChangeConnectionChoice
        account={changingChoice}
        choice={changingChoice ? (choiceOf(changingChoice.connectorId) ?? null) : null}
        workspaceId={workspaceId}
        returnFocusTo={choiceOpenedFrom.current}
        onClose={() => setChangingChoice(null)}
      />

      <CloseWindow disabled={command.isPending || testClaudeCode.isPending || claudeCodeFormPending} />
    </ManageWindow>
  );
}
