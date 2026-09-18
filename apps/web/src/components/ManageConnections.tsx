import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { connectorNamed, uuidv7, type SourceAccount } from '@cockpit/shared';
import { connectTeamsPath } from '../api/client';
import { refusalFrom, sourceAccountsQuery, useCommand } from '../api/queries';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';

/**
 * Where a Workspace's source accounts are managed ("Connect a Microsoft Teams
 * source account", issue 485): what is connected, a card to connect a Teams
 * account, and Disconnect on each row.
 *
 * **Workspace-scoped, unlike `ManageTypes` beside it.** A connection belongs
 * to the Workspace that made it and no other Workspace ever sees it, which is
 * why it is opened from the Workspace's own tab rather than from the header's
 * menu, and why every read and every change here names a Workspace.
 *
 * **What it shows is always what is stored.** The list is never served from a
 * copy (`sourceAccountsQuery`) and nothing here is drawn before the server has
 * agreed to it: connecting comes back from Microsoft as a fresh read, and
 * disconnecting waits for the row to be gone. An optimistic row is the one
 * thing this window must not draw - it would say a credential exists.
 */
export function ManageConnections({
  workspaceId,
  workspaceName,
  /** How the last connect attempt went, where the browser has just come back from one. */
  outcome,
  open,
  onClose,
  returnFocusTo,
}: {
  workspaceId: string;
  workspaceName: string;
  outcome?: 'connected' | 'refused' | undefined;
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
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The window itself, which the focus goes back to once a disconnect has
   * taken the row's menu with the row - the reason `ManageTypes` keeps one.
   */
  const list = useRef<HTMLDivElement>(null);
  const command = useCommand();

  const connected = data?.sourceAccounts ?? [];
  /**
   * Saying "nothing connected" is a claim about what this Workspace holds, so
   * it needs an answer to have arrived - the same lie `ManageTypes` records,
   * where `?? []` made a failed read look like an empty account.
   */
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;
  const beingDisconnected = connected.find((account) => account.id === disconnecting);

  const startDisconnecting = (account: SourceAccount, openedFrom: HTMLElement | null) => {
    command.reset();
    askedFrom.current = openedFrom;
    setDisconnecting(account.id);
  };

  const stopAsking = () => {
    setDisconnecting(null);
    command.reset();
  };

  /**
   * Closing drops the disconnect being asked about as well as shutting the
   * window, so what the tabs unmount is never a question left half-answered
   * over a row nobody has touched.
   */
  const close = () => {
    stopAsking();
    onClose();
  };

  /**
   * Leaves the application for Microsoft, and comes back to this Workspace
   * with this window open over it - a whole-page navigation like signing in,
   * rather than a popup nothing else in this app uses.
   */
  const connect = () => {
    window.location.assign(connectTeamsPath(workspaceId));
  };

  const refusal = refusalFrom(command);

  return (
    <ManageWindow
      title={`Connections of ${workspaceName}`}
      open={open}
      onClose={close}
      canClose={!command.isPending}
      returnFocusTo={returnFocusTo}
      ref={list}
    >
      <p className="mt-2 text-sm text-ink-faint">
        The accounts this workspace is connected to. Only this workspace can see them.
      </p>

      {/* Above the list, where every other management window puts the control
          that makes something: the list has no ceiling, so a card below it
          would be a control whose reachability depends on how much is already
          connected - and it is the one control a workspace with nothing needs
          most. */}
      <div className="mt-4 flex items-center gap-3 rounded-md border border-black/10 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{connectorNamed('teams')}</p>
          <p className="text-sm text-ink-faint">
            Sign in with Microsoft. Cockpit reads who you are and nothing else.
          </p>
        </div>
        <button
          type="button"
          onClick={connect}
          disabled={command.isPending}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
        >
          Connect
        </button>
      </div>

      {/* What the trip to Microsoft came back with. Said here rather than on
          the card, because it is about the journey rather than about the
          control - and it says nothing about *why*: every reason names
          something an attacker got wrong or something only an operator can
          fix, and the one thing that helps is pressing Connect again. */}
      {outcome === 'refused' && (
        <p role="alert" className="pt-3 text-sm text-over">
          That did not connect. Nothing was stored. Try again.
        </p>
      )}

      <section className="-mx-2 mt-4 min-h-0 flex-1 overflow-y-auto">
        <ul>
          {connected.map((account) => (
            <li key={account.id} className="border-b border-black/5 px-4 py-2 last:border-b-0">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{account.displayName}</span>
                <span className="shrink-0 text-sm text-ink-faint">
                  {connectorNamed(account.connectorId)}
                </span>
                <RowMenu
                  label={`Actions for ${account.displayName}`}
                  entries={[
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
            question={`Disconnect ${beingDisconnected.displayName}? Cockpit forgets the sign-in it was connected with.`}
            confirmLabel={`Yes, disconnect ${beingDisconnected.displayName}`}
            confirmText="Disconnect"
            canConfirm={!command.isPending}
            refusal={refusal}
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
          <p className="px-4 py-4 text-sm text-ink-faint">
            Nothing connected yet. Connect one above.
          </p>
        )}
      </section>
      <CloseWindow disabled={command.isPending} />
    </ManageWindow>
  );
}
