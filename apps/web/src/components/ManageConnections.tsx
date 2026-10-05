import { useRef, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  CLAUDE_CODE,
  GMAIL,
  TEAMS,
  connectorNamed,
  sourceAccountListSchema,
  uuidv7,
  type SourceAccount,
  type SourceAccountList,
} from '@cockpit/shared';
import { api, refusal } from '../api/client';
import { refusalFrom, useCommand, useConnectClaudeCode, useTestClaudeCodeConnection } from '../api/queries';
import type { ConnectOutcome } from '../connections';
import { ConnectClaudeCode } from './ConnectClaudeCode';
import { ConnectGmail } from './ConnectGmail';
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
 * Connecting a Teams account is a navigation, not a request: the browser
 * leaves for Microsoft and comes back to a page, so there is nothing here to
 * await and nothing to parse - the same shape `SIGN_IN_PATH` (`api/client.ts`)
 * has, and the same reason.
 *
 * It comes back to `/w/<workspaceId>?connections=connected|refused`, which is
 * what reopens this window over the Workspace it was started from.
 */
function connectTeamsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/teams/connect`;
}

/**
 * The connectors a workspace can add ("Connect a workspace to Claude Code",
 * issue 569): what the Add-a-connection list offers, whether or not anything
 * of that kind is connected yet. A plain constant, the same way the Teams
 * card was hardcoded here before it - adding another means adding it here,
 * nowhere else.
 */
const AVAILABLE_CONNECTORS = [GMAIL, TEAMS, CLAUDE_CODE] as const;

/** What each card says it does - for Gmail, that the label and the task stay in step (issue 724). */
const CARD_TEXT: Record<(typeof AVAILABLE_CONNECTORS)[number], string> = {
  [GMAIL]:
    'Label a conversation Cockpit in Gmail and it becomes a task here. Finishing the task takes the label off. Cockpit reads labelled mail only.',
  [TEAMS]: 'Sign in with Microsoft. Cockpit reads who you are and nothing else.',
  [CLAUDE_CODE]: 'A routine that starts a Claude Code session on this workspace’s items.',
};

/** What a connected row says under its name, beside the source. */
function rowDetail(account: SourceAccount): string {
  // The label is fixed, and the row says so ("Connect a Gmail account to a
  // workspace, and disconnect it", issue 724) - and when the mailbox was last
  // checked, once it has been ("Bring in the conversations already labelled
  // Cockpit as tasks", issue 725).
  if (account.connectorId === GMAIL) {
    return account.lastTestedAt
      ? `Gmail · label Cockpit · last checked ${new Date(account.lastTestedAt).toLocaleString()}`
      : 'Gmail · label Cockpit';
  }
  return account.lastTestedAt
    ? `${connectorNamed(account.connectorId)} · last worked ${new Date(account.lastTestedAt).toLocaleString()}`
    : connectorNamed(account.connectorId);
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
  open,
  onClose,
  returnFocusTo,
  only,
  picker,
}: {
  /**
   * These kinds of connection only - Gmail and Teams under Connections,
   * Claude Code under Agent settings (Settings, `SettingsWindow.tsx`).
   * Absent, every kind is shown.
   */
  only?: readonly string[] | undefined;
  /** What picks the workspace, drawn under the intro. */
  picker?: React.ReactNode;
  workspaceId: string;
  workspaceName: string;
  outcome?: ConnectOutcome | undefined;
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
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [claudeCodeForm, setClaudeCodeForm] = useState(false);
  const [claudeCodeFormPending, setClaudeCodeFormPending] = useState(false);
  const [claudeCodeMessage, setClaudeCodeMessage] = useState<string | null>(null);
  const [gmailSteps, setGmailSteps] = useState(false);
  const gmailOpenedFrom = useRef<HTMLElement | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const claudeCodeOpenedFrom = useRef<HTMLElement | null>(null);
  /**
   * The window itself, which the focus goes back to once a disconnect has
   * taken the row's menu with the row - the reason `ManageTypes` keeps one.
   */
  const list = useRef<HTMLDivElement>(null);
  const command = useCommand();
  const testClaudeCode = useTestClaudeCodeConnection(workspaceId);

  const connected = (data?.sourceAccounts ?? []).filter((account) => !only || only.includes(account.connectorId));
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
    setGmailSteps(false);
    onClose();
  };

  /**
   * Leaves the application for Microsoft, and comes back to this Workspace
   * with this window open over it - a whole-page navigation like signing in,
   * rather than a popup nothing else in this app uses.
   */
  const connectTeams = () => {
    window.location.assign(connectTeamsPath(workspaceId));
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
      {/* No count: the conversations are brought in after this, not before
          (issue 724). */}
      {outcome === 'gmail-connected' && (
        <p role="status" className="pt-3 text-sm text-ink-soft">
          Connected. Conversations labelled Cockpit arrive in this workspace’s Inbox within a minute.
        </p>
      )}
      {outcome === 'refused' && (
        <p role="alert" className="pt-3 text-sm text-over">
          That did not connect. Nothing was stored. Try again.
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
                  <p className="text-sm text-ink-faint">{rowDetail(account)}</p>
                  {/* Why Claude last refused to start a session through it,
                      until one starts again ("Drop an agent on an item to
                      start a Claude Code session on it", issue 571). */}
                  {account.failingBecause && (
                    <p className="text-sm text-over-deep">Failing: {account.failingBecause}</p>
                  )}
                </div>
                <RowMenu
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
                    {
                      label: 'Disconnect',
                      destructive: true,
                      onSelect: (openedFrom) => startDisconnecting(account, openedFrom),
                    },
                  ]}
                />
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
          <p role="alert" className="px-4 py-2 text-sm text-over">
            {claudeCodeMessage}
          </p>
        )}
      </section>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Add a connection
      </h3>
      <div className="mt-2 flex flex-col gap-2">
        {AVAILABLE_CONNECTORS.filter((connectorId) => !only || only.includes(connectorId)).map((connectorId) => (
          <div
            key={connectorId}
            className="flex items-center gap-3 rounded-md border border-shade/10 p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{connectorNamed(connectorId)}</p>
              <p className="text-sm text-ink-faint">{CARD_TEXT[connectorId]}</p>
            </div>
            {connectorId === CLAUDE_CODE && claudeCodeConnected ? (
              <span className="shrink-0 text-sm text-ink-faint">Connected - one per workspace</span>
            ) : (
              <button
                type="button"
                // Two rows both reading "Connect" need two names for anyone
                // not reading them side by side - a screen reader, or a test.
                aria-label={`Connect ${connectorNamed(connectorId)}`}
                onClick={(event) => {
                  if (connectorId === TEAMS) connectTeams();
                  else if (connectorId === GMAIL) {
                    gmailOpenedFrom.current = event.currentTarget;
                    setGmailSteps(true);
                  } else openClaudeCodeForm(event.currentTarget);
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

      <ConnectClaudeCode
        open={claudeCodeForm}
        workspaceId={workspaceId}
        connectionId={claudeCodeConnected?.id}
        returnFocusTo={claudeCodeOpenedFrom.current}
        onClose={() => setClaudeCodeForm(false)}
        onPendingChange={setClaudeCodeFormPending}
      />

      <ConnectGmail
        open={gmailSteps}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        returnFocusTo={gmailOpenedFrom.current}
        onClose={() => setGmailSteps(false)}
      />

      <CloseWindow disabled={command.isPending || testClaudeCode.isPending || claudeCodeFormPending} />
    </ManageWindow>
  );
}
