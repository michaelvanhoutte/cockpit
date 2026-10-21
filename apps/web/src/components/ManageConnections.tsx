import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  registeredConnectorListSchema,
  sourceAccountListSchema,
  uuidv7,
  type RegisteredConnectorList,
  type SourceAccount,
  type SourceAccountList,
} from '@cockpit/shared';
import { api, refusal } from '../api/client';
import {
  refusalFrom,
  snapshotQuery,
  useCheckConnectionNow,
  useCommand,
} from '../api/queries';
import type { ConnectOutcome, RefusedBecause } from '../connections';
import { whenCaptured } from '../duplicates';
import { sourceNamed, type SourceNames } from '../itemSource';
import { ChangeConnectionChoice, ConnectWithChoice, type ConnectAnswer, type ConnectorChoice, type ConnectorNames } from './ConnectionChoice';
import { ConnectionHistory } from './ConnectionHistory';
import { ConnectPhone, type PhoneConnector } from './ConnectPhone';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';
import { SourceMark } from './SourceMark';

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
function connectPath(workspaceId: string, connectorId: string, answer: ConnectAnswer = {}): string {
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectorId)}/connect`;
  // The answers to the connector's one question and to whether it files by
  // name, which the Worker carries through the source in the attempt it keeps
  // (issues 942, 1147).
  const asked = new URLSearchParams();
  if (answer.choice !== undefined) asked.set('choice', answer.choice);
  if (answer.filesByName !== undefined) asked.set('filesByName', String(answer.filesByName));
  const query = asked.toString();
  return query ? `${path}?${query}` : path;
}

/** One connector Add a connection offers. */
interface Card {
  id: string;
  name: string;
  text: string;
  /** What its connector asks before Connect leaves, where it asks anything (issue 942). */
  choice?: ConnectorChoice | undefined;
  /** How its connector speaks of names, where it reports any: Connect asks whether to file by them too (issue 1147). */
  names?: ConnectorNames | undefined;
  /** Present where its connector connects a phone by a texted code rather than by leaving: Connect asks for a number (issue 1335). */
  textedCode?: { textTo: string } | undefined;
}

/** What the guest is told in place of every way to connect. */
const GUEST_SENTENCE = 'Sign in with Google to connect your own';

/**
 * What a connection card calls its source: the connector's own name where its
 * listing has loaded and the names map knows the source - the map calls an Item
 * of it what the Item is ("Text message"), not what the entry is.
 */
function sourceLine(account: SourceAccount, names: SourceNames, connectorName?: string): string {
  const named = sourceNamed(names, account.connectorId);
  return connectorName && named !== account.connectorId ? connectorName : named;
}

/**
 * The badge on a connection card ("Show each connection as its own card",
 * issue 1349): **Healthy** for one Cockpit checks, **Listening** for one that
 * sends to Cockpit, both with a pulsing dot, or **Needs attention**.
 */
function StatusPill({ account }: { account: SourceAccount }) {
  if (account.failingBecause)
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-over/10 px-2 py-0.5 text-xs font-medium text-over-ink">
        <span className="size-1.5 rounded-full bg-over" />
        Needs attention
      </span>
    );
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-cat-green-tint px-2 py-0.5 text-xs font-medium text-ink">
      <span className="size-1.5 rounded-full bg-cat-green motion-safe:animate-pulse" />
      {account.pulled ? 'Healthy' : 'Listening'}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-shade/10 bg-shade/5 px-1.5 py-0.5 text-xs text-ink-soft">{children}</span>
  );
}

/** A card's button for the two things done to it most, always drawn rather than revealed under the pointer. */
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {children}
      </svg>
    </button>
  );
}

/** The header's one button that offers every source, each with its mark and its sentence clamped to two lines. */
function AddConnection({
  cards,
  disabled,
  onPick,
}: {
  cards: Card[];
  disabled: boolean;
  onPick: (card: Card, openedFrom: HTMLElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const chose = useRef(false);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        ref={trigger}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-50"
      >
        <span aria-hidden className="text-base leading-none">
          +
        </span>{' '}
        Add connection
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          // Every entry opens a window that takes the focus, so the restore to this
          // button is skipped after a pick and kept on a plain dismiss (`RowMenu`'s rule).
          onCloseAutoFocus={(event) => {
            if (!chose.current) return;
            chose.current = false;
            event.preventDefault();
          }}
          className="z-floating w-[24rem] max-w-[calc(100vw-2rem)] rounded-xl border border-shade/10 bg-surface p-1.5 shadow-lg"
        >
          {cards.map((card) => (
            <DropdownMenu.Item
              key={card.id}
              // Named for what it does, as the gallery's Connect is.
              aria-label={`Connect ${card.name}`}
              onSelect={() => {
                chose.current = true;
                onPick(card, trigger.current);
              }}
              className="flex cursor-pointer items-start gap-3 rounded-lg p-2.5 outline-none data-[highlighted]:bg-accent-tint"
            >
              <SourceMark connectorId={card.id} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-strong">{card.name}</span>
                <span className="line-clamp-2 text-xs text-ink-faint">{card.text}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Where a Workspace's source accounts are managed ("Connect a Microsoft Teams
 * source account", issue 485; "Connect a workspace to Claude Code", issue
 * 569): what is connected, and what can be added.
 *
 * **A card per connection, and one way to add** ("Show each connection as its
 * own card", issue 1349). Each card says its health and carries its fix; what
 * can be added is the header's Add connection menu once anything is connected,
 * and a gallery of every source before.
 *
 * **Workspace-scoped.** A connection belongs
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
  picker,
  guest = false,
}: {
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
    enabled: open,
  });
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  /**
   * The card whose connector's question is being asked before Connect leaves
   * (issue 942) - and the option to start at, where a row is being reconnected.
   */
  const [asking, setAsking] = useState<(Card & { startAt?: string | undefined; startFilesByName?: boolean | undefined }) | null>(null);
  const askingOpenedFrom = useRef<HTMLElement | null>(null);
  /** The row whose choice is being changed with *Change…* (issue 942). */
  const [changingChoice, setChangingChoice] = useState<SourceAccount | null>(null);
  /** The row whose history is drawn in place of the list (issue 1140). */
  const [historyOf, setHistoryOf] = useState<SourceAccount | null>(null);
  const choiceOpenedFrom = useRef<HTMLElement | null>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The window itself, which the focus goes back to once a disconnect has
   * taken the row's menu with the row.
   */
  const list = useRef<HTMLDivElement>(null);
  /** The card whose phone is being connected with a texted code, and what to focus when it closes (issue 1335). */
  const [connectingPhone, setConnectingPhone] = useState<PhoneConnector | null>(null);
  const phoneOpenedFrom = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  const command = useCommand();
  const checkNow = useCheckConnectionNow(workspaceId);
  /** What pressing *Check now* last came to, said where the person is looking (issue 1143). */
  const [checkNowNote, setCheckNowNote] = useState<{ ok: boolean; text: string } | null>(null);

  const registered = (registry.data?.connectors ?? []).map((connector): Card => ({
      id: connector.id,
      name: connector.displayName,
      text: connector.cardText,
      choice: connector.choice,
      names: connector.names,
      textedCode: connector.textedCode,
    }));
  /** The connector's own sentence for why it refused, where the listing holds one for the code. */
  const refusalGiven = because
    ? Object.entries(
        registry.data?.connectors.find((connector) => connector.id === because.connectorId)?.refusals ?? {},
      ).find(([code]) => code === because.code)?.[1]
    : undefined;
  const cards = registered;
  const connected = data?.sourceAccounts ?? [];
  /**
   * Saying "nothing connected" is a claim about what this Workspace holds, so
   * it needs an answer to have arrived: `?? []` would make a failed read look
   * like an empty workspace.
   */
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;
  const beingDisconnected = connected.find((account) => account.id === disconnecting);
  const failingCount = connected.filter((account) => account.failingBecause).length;
  /** Read once per render, so every card says its time against the same moment. */
  const now = Date.now();

  const startDisconnecting = (account: SourceAccount, openedFrom: HTMLElement | null) => {
    command.reset();
    askedFrom.current = openedFrom;
    setDisconnecting(account.id);
  };

  const openHistory = (account: SourceAccount) => {
    setCheckNowNote(null);
    setHistoryOf(account);
  };

  /** Asks for the connection's check at once; the line it writes arrives over the stream, so nothing here waits for it. */
  const pressCheckNow = (account: SourceAccount) => {
    setCheckNowNote(null);
    checkNow.mutate(account.id, {
      onSuccess: () =>
        setCheckNowNote({ ok: true, text: `Checking ${account.displayName} now.` }),
      onError: () => setCheckNowNote({ ok: false, text: 'That did not reach the server. Try again.' }),
    });
  };

  const stopAsking = () => {
    setDisconnecting(null);
    command.reset();
  };

  /**
   * Closing drops the disconnect being asked about as well as shutting the
   * window, so what the tabs unmount is never a question left half-answered.
   */
  const close = () => {
    stopAsking();
    setAsking(null);
    setChangingChoice(null);
    setConnectingPhone(null);
    setHistoryOf(null);
    setCheckNowNote(null);
    onClose();
  };

  /**
   * Leaves the application for the source, and comes back to this Workspace
   * with this window open over it - a whole-page navigation like signing in,
   * rather than a popup nothing else in this app uses.
   */
  const connectRegistered = (connectorId: string, answer?: ConnectAnswer) => {
    window.location.assign(connectPath(workspaceId, connectorId, answer));
  };
  /** What a connected row's connector asks, where it asks anything - and so whether the row offers *Change…*. */
  const choiceOf = (connectorId: string): ConnectorChoice | undefined =>
    registry.data?.connectors.find((connector) => connector.id === connectorId)?.choice;
  /** What a connected row's connector is called in Settings, which is not always what one of its Items is called. */
  const connectorNameOf = (connectorId: string): string | undefined =>
    registry.data?.connectors.find((connector) => connector.id === connectorId)?.displayName;
  /** The number a connected row's connector has a phone text, where it connects phones (issue 1335). */
  const textToOf = (connectorId: string): string | undefined =>
    registry.data?.connectors.find((connector) => connector.id === connectorId)?.textedCode?.textTo;
  /** How a connected row's connector speaks of names, where it reports any - which also offers *Change…* (issue 1146). */
  const namesOf = (connectorId: string): ConnectorNames | undefined =>
    registry.data?.connectors.find((connector) => connector.id === connectorId)?.names;
  /**
   * What picking a source does from Add connection, or Connect on a card that
   * asks something: a phone asks for its number, every other source opens its
   * Connect window - the sentence, then its question where it has one.
   */
  const connectCard = (card: Card, openedFrom: HTMLElement | null) => {
    if (card.textedCode) {
      phoneOpenedFrom.current = openedFrom;
      setConnectingPhone({ id: card.id, displayName: card.name, textTo: card.textedCode.textTo });
    } else {
      askingOpenedFrom.current = openedFrom;
      setAsking({ ...card });
    }
  };
  /**
   * Signs a failing row in again through its connector: the question first
   * where it asks one, starting at the row's own answer, and the same trip as
   * Connect - which stores the new sign-in on the same row, ending what said
   * it was failing (issue 944).
   */
  const reconnect = (account: SourceAccount, openedFrom: HTMLElement | null) => {
    const card = registered.find((one) => one.id === account.connectorId);
    if (!card) return;
    if (card.choice || card.names) {
      askingOpenedFrom.current = openedFrom;
      setAsking({ ...card, startAt: account.follows, startFilesByName: account.filesByName });
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
      canClose={!command.isPending}
      returnFocusTo={returnFocusTo}
      ref={list}
    >
      {historyOf ? (
        <ConnectionHistory
          workspaceId={workspaceId}
          account={historyOf}
          namesNoun={namesOf(historyOf.connectorId)?.noun}
          onCheckNow={() => pressCheckNow(historyOf)}
          checkNowPending={checkNow.isPending}
          checkNowNote={checkNowNote}
          onBack={() => {
            setHistoryOf(null);
            setCheckNowNote(null);
            list.current?.focus();
          }}
        />
      ) : (
        <>
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

          {/* A header that says how things stand, and adds from one button; the Settings
              pane scrolls the whole section, so the list has no scroll box of its own
              (issue 1349). */}
          <div className="mt-5 flex items-center gap-3">
            <p className="flex-1 text-sm text-ink-soft">
              {answered && (
                <>
                  <span className="font-semibold text-ink-strong">{connected.length}</span> connected
                  {failingCount > 0 && (
                    <>
                      {' · '}
                      <span className="font-semibold text-over-ink">
                        {failingCount} {failingCount === 1 ? 'needs' : 'need'} attention
                      </span>
                    </>
                  )}
                </>
              )}
            </p>
            {answered &&
              connected.length > 0 &&
              (guest ? (
                <span className="shrink-0 text-sm text-ink-faint">{GUEST_SENTENCE}</span>
              ) : (
                <AddConnection cards={cards} disabled={command.isPending} onPick={connectCard} />
              ))}
          </div>
          <section className="mt-3">
            <ul className="flex flex-col gap-3">
              {connected.map((account) => {
                const failing = Boolean(account.failingBecause);
                const noun = namesOf(account.connectorId)?.noun;
                const textTo = textToOf(account.connectorId);
                // A failing row of a connector this environment can sign in to:
                // signing in again is what ends it (issue 944).
                const canReconnect =
                  failing && !guest && registered.some((card) => card.id === account.connectorId);
                return (
                  <li
                    key={account.id}
                    className={`relative overflow-hidden rounded-xl border bg-surface p-4 shadow-sm transition-shadow hover:shadow-md ${failing ? 'border-over/40' : 'border-shade/10'}`}
                  >
                    {failing && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-over" />}
                    <div className="flex items-start gap-4">
                      <SourceMark connectorId={account.connectorId} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[15px] font-semibold text-ink-strong">{account.displayName}</p>
                          <StatusPill account={account} />
                        </div>
                        <p className="text-xs text-ink-faint">
                          {sourceLine(account, names, connectorNameOf(account.connectorId))}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {account.follows && <Chip>{account.followsLabel ?? account.follows}</Chip>}
                          {account.filesByName && noun && <Chip>Files by {noun}</Chip>}
                          {/* A connected phone says which number to text, since that is what it is for (issue 1335). */}
                          {textTo !== undefined && (
                            <span className="text-xs text-ink-faint">Text {textTo} to add a note</span>
                          )}
                          {account.lastTestedAt ? (
                            <span
                              className="text-xs text-ink-faint"
                              title={new Date(account.lastTestedAt).toLocaleString()}
                            >
                              {account.follows ? 'Checked' : 'Worked'} {whenCaptured(account.lastTestedAt, now)}
                            </span>
                          ) : (
                            !account.pulled &&
                            textTo === undefined && (
                              <span className="text-xs text-ink-faint">Sends to Cockpit as it happens</span>
                            )
                          )}
                        </div>
                        {failing && (
                          <div className="mt-3 flex items-center gap-3 rounded-lg bg-over/10 px-3 py-2">
                            {/* A connection that keeps a history opens it from here, where its checks
                                say when it began failing (issue 1140); one that keeps none is plain text. */}
                            {account.keepsHistory ? (
                              <button
                                type="button"
                                onClick={() => openHistory(account)}
                                className="min-w-0 flex-1 text-left text-sm text-over-ink underline-offset-2 hover:underline"
                              >
                                {account.failingBecause}
                              </button>
                            ) : (
                              <p className="min-w-0 flex-1 text-sm text-over-ink">{account.failingBecause}</p>
                            )}
                            {canReconnect && (
                              <button
                                type="button"
                                onClick={(event) => reconnect(account, event.currentTarget)}
                                className="shrink-0 rounded-md bg-over-deep px-3 py-1 text-sm font-medium text-white hover:opacity-90"
                              >
                                Reconnect
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {account.pulled && !guest && (
                          <IconButton label={`Check ${account.displayName} now`} onClick={() => pressCheckNow(account)}>
                            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
                          </IconButton>
                        )}
                        {account.keepsHistory && (
                          <IconButton label={`History of ${account.displayName}`} onClick={() => openHistory(account)}>
                            <path d="M12 7v5l3 2M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
                          </IconButton>
                        )}
                        {!guest && (
                          <RowMenu
                            label={`Actions for ${account.displayName}`}
                            entries={[
                              ...(canReconnect
                                ? [
                                    {
                                      label: 'Reconnect',
                                      onSelect: (openedFrom: HTMLElement | null) => reconnect(account, openedFrom),
                                    },
                                  ]
                                : []),
                              // Its check made due at once, and when it was checked and
                              // why it failed (issues 1143, 1140).
                              ...(account.pulled
                                ? [{ label: 'Check now', onSelect: () => pressCheckNow(account) }]
                                : []),
                              ...(account.keepsHistory
                                ? [{ label: 'History…', onSelect: () => openHistory(account) }]
                                : []),
                              // The connector's own choice, changed without signing in
                              // again (issue 942).
                              ...(choiceOf(account.connectorId) || namesOf(account.connectorId)
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
                          />
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {beingDisconnected && (
              <DeleteQuestion
                open
                question={`Disconnect ${beingDisconnected.displayName}? ${
                  // A phone has no sign-in to forget (issue 1335).
                  textToOf(beingDisconnected.connectorId) !== undefined
                    ? 'Cockpit forgets the number.'
                    : 'Cockpit forgets the sign-in it was connected with.'
                }`}
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
              <div className="py-4">
                <LoadFailure error={error} onRetry={() => void refetch()} />
              </div>
            )}
            {answered && connected.length === 0 && !isFetching && (
              <p className="py-4 text-sm text-ink-faint">Nothing connected yet. Add one below.</p>
            )}
            {checkNowNote && (
              <p
                role={checkNowNote.ok ? 'status' : 'alert'}
                className={`py-2 text-sm ${checkNowNote.ok ? 'text-ink-soft' : 'text-over-ink'}`}
              >
                {checkNowNote.text}
              </p>
            )}
          </section>

          {/* Once anything is connected, adding is the header's button; before, a gallery of what
              can be connected. Not drawn while the list is still being read, which would show
              it to a Workspace that has connections. */}
          {(answered ? connected.length === 0 : listFailed) && (
            <>
              <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Add a connection
              </h3>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {cards.map((card) => (
                  <div
                    key={card.id}
                    className="flex flex-col gap-3 rounded-xl border border-shade/10 bg-surface p-4 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-center gap-3">
                      <SourceMark connectorId={card.id} />
                      <p className="text-[15px] font-semibold text-ink-strong">{card.name}</p>
                    </div>
                    <p className="flex-1 text-sm text-ink-faint">{card.text}</p>
                    {guest ? (
                      <span className="shrink-0 text-sm text-ink-faint">{GUEST_SENTENCE}</span>
                    ) : (
                      <button
                        type="button"
                        // Two rows both reading "Connect" need two names for anyone
                        // not reading them side by side - a screen reader, or a test.
                        aria-label={`Connect ${card.name}`}
                        onClick={(event) => {
                          // A connector that asks nothing leaves at once from here; picked from the
                          // header's menu it opens its window first, so the person is told what it is.
                          if (card.textedCode || card.choice || card.names) connectCard(card, event.currentTarget);
                          else connectRegistered(card.id);
                        }}
                        disabled={command.isPending}
                        className="self-start rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
                      >
                        Connect
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <ConnectWithChoice
        connector={
          asking
            ? {
                displayName: asking.name,
                text: asking.text,
                choice: asking.choice,
                names: asking.names,
                startAt: asking.startAt,
                startFilesByName: asking.startFilesByName,
              }
            : null
        }
        onConnect={(answer) => asking && connectRegistered(asking.id, answer)}
        onClose={() => setAsking(null)}
        returnFocusTo={askingOpenedFrom.current}
      />

      <ConnectPhone
        connector={connectingPhone}
        workspaceId={workspaceId}
        onConnected={() => void queryClient.invalidateQueries({ queryKey: ['sourceAccounts', workspaceId] })}
        onClose={() => setConnectingPhone(null)}
        returnFocusTo={phoneOpenedFrom.current}
      />

      <ChangeConnectionChoice
        account={changingChoice}
        choice={changingChoice ? (choiceOf(changingChoice.connectorId) ?? null) : null}
        names={changingChoice ? (namesOf(changingChoice.connectorId) ?? null) : null}
        workspaceId={workspaceId}
        returnFocusTo={choiceOpenedFrom.current}
        onClose={() => setChangingChoice(null)}
      />

      <CloseWindow disabled={command.isPending} />
    </ManageWindow>
  );
}
