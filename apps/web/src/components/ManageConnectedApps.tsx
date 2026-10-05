import { useRef, useState } from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appDisconnectedSchema, connectedAppListSchema, type ConnectedApp } from '@cockpit/shared';
import { api, refusal } from '../api/client';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';

/**
 * Its own chunk's own reads, kept here rather than in `api/client.ts` with the
 * rest, for the reason `ManageConnections` keeps its list here: the one thing
 * this window alone asks for is worth its own weight rather than the initial
 * bundle's (`bundle:budget`).
 */
const connectedAppsQuery = queryOptions({
  queryKey: ['connectedApps'],
  queryFn: async () => {
    const res = await api.v1['connected-apps'].$get();
    if (!res.ok) throw refusal('connected apps', res.status);
    return connectedAppListSchema.parse(await res.json());
  },
  // What is connected *now*, never a copy: another tab may have disconnected one.
  staleTime: 0,
});

async function disconnect(appId: string): Promise<void> {
  const res = await api.v1['connected-apps'][':appId'].$delete({ param: { appId } });
  // Already gone, from another tab: the list is simply out of date.
  if (res.status === 404) return;
  if (!res.ok) throw refusal('disconnecting an app', res.status);
  appDisconnectedSchema.parse(await res.json());
}

/** Where an app is pointed to reach this Cockpit: this environment's own origin, then `/mcp`. */
export const connectAddress = () => `${window.location.origin}/mcp`;

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * The apps allowed into your Cockpit, and the address to paste into claude.ai
 * ("See the apps connected to your Cockpit, and disconnect one", issue 600).
 *
 * **Yours, not the account's**: an app somebody else allowed is not listed,
 * and Disconnect ends exactly the access you gave. The Items it captured stay.
 *
 * **The address is shown whether or not anything is connected**, because the
 * first app is connected by pasting it, which is when this is wanted most.
 */
export default function ManageConnectedApps({
  open,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data, error, refetch, isFetching } = useQuery({ ...connectedAppsQuery, enabled: open });
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const askedFrom = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const ending = useMutation({
    mutationFn: disconnect,
    onSuccess: async () => {
      setAsking(null);
      await queryClient.invalidateQueries({ queryKey: connectedAppsQuery.queryKey });
      // The row's menu went with the row: the focus has to land somewhere.
      list.current?.focus();
    },
  });

  const apps = data?.apps ?? [];
  const answered = data !== undefined;
  const beingAsked = apps.find((app) => app.id === asking);
  const address = connectAddress();

  const stopAsking = () => {
    setAsking(null);
    ending.reset();
  };
  const close = () => {
    stopAsking();
    setCopied(false);
    onClose();
  };
  const copy = () => {
    // Clipboard access can be refused; the address is on screen to select.
    void navigator.clipboard?.writeText(address).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  const startAsking = (app: ConnectedApp, openedFrom: HTMLElement | null) => {
    ending.reset();
    askedFrom.current = openedFrom;
    setAsking(app.id);
  };

  return (
    <ManageWindow
      title="MCP connections"
      open={open}
      onClose={close}
      canClose={!ending.isPending}
      returnFocusTo={returnFocusTo}
      ref={list}
    >
      <p className="mt-2 text-sm text-ink-faint">
        Apps you allowed to capture items into your Cockpit. To connect Claude, paste this address into
        claude.ai.
      </p>
      <div className="mt-3 flex items-center gap-3 rounded-md border border-shade/10 p-3">
        <code className="min-w-0 flex-1 select-all break-all text-sm">{address}</code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">Connected</h3>
      <section className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto">
        <ul>
          {apps.map((app) => (
            <li key={app.id} className="border-b border-shade/5 px-4 py-2 last:border-b-0">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{app.name}</p>
                  <p className="text-sm text-ink-faint">
                    Connected {when(app.connectedAt)} ·{' '}
                    {app.lastCapturedAt ? `last captured ${when(app.lastCapturedAt)}` : 'nothing captured yet'}
                  </p>
                </div>
                <RowMenu
                  label={`Actions for ${app.name}`}
                  entries={[
                    {
                      label: 'Disconnect',
                      destructive: true,
                      onSelect: (openedFrom) => startAsking(app, openedFrom),
                    },
                  ]}
                />
              </div>
            </li>
          ))}
        </ul>
        {beingAsked && (
          <DeleteQuestion
            open
            question={`Disconnect ${beingAsked.name}? It can no longer reach your Cockpit until you allow it again. The items it captured stay.`}
            confirmLabel={`Yes, disconnect ${beingAsked.name}`}
            confirmText="Disconnect"
            canConfirm={!ending.isPending}
            refusal={ending.error ? 'That did not reach the server. Try again.' : null}
            returnFocusTo={askedFrom.current}
            onCancel={stopAsking}
            onConfirm={() => ending.mutate(beingAsked.id)}
          />
        )}
        {Boolean(error) && !answered && (
          <div className="px-4 py-4">
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        )}
        {answered && apps.length === 0 && !isFetching && (
          <p className="px-4 py-4 text-sm text-ink-faint">No MCP connections</p>
        )}
      </section>

      <CloseWindow disabled={ending.isPending} />
    </ManageWindow>
  );
}
