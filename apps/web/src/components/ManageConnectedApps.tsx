import { useRef, useState } from 'react';
import type { ConnectedApp } from '@cockpit/shared';
import { useConnectedApps, useDisconnectApp } from '../api/connectedApps';
import { whyNotDone } from '../api/queries';
import { dateTimeLabel } from '../dateFormat';
import { useUndo } from '../undo';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';
import { SettingsPanel } from './SettingsPanel';

/** Where an app is pointed to reach this Cockpit: this environment's own origin, then `/mcp`. */
export const connectAddress = () => `${window.location.origin}/mcp`;

const when = dateTimeLabel;

/** What a row says under the app's name: when it was connected, what it may do, and when it last did it. */
function whatItDid(app: ConnectedApp): string {
  const connected = `Connected ${when(app.connectedAt)}`;
  if (app.kind === 'reads-panels') {
    return `${connected} · Reads your Panels · ${app.lastReadAt ? `last read ${when(app.lastReadAt)}` : 'nothing read yet'}`;
  }
  return `${connected} · ${app.lastCapturedAt ? `last captured ${when(app.lastCapturedAt)}` : 'nothing captured yet'}`;
}

/**
 * The apps allowed into your Cockpit, and the address to paste into claude.ai
 * ("See the apps connected to your Cockpit, and disconnect one", issue 600) -
 * each saying what it may do: capture items, or only read your Panels (issue
 * 1445).
 *
 * **Yours, not the account's**: an app somebody else allowed is not listed,
 * and Disconnect ends exactly the access you gave. The Items it captured stay.
 *
 * **The address is shown whether or not anything is connected**, because the
 * first app is connected by pasting it, which is when this is wanted most.
 *
 * **A disconnect shows at the click** ("Show a connected app or user change the
 * moment you make it", issue 1371): the question closes and the row is gone
 * with the server still to answer. One the server refuses brings the row back,
 * and the undo bar says why, since the question closed at the click.
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
  const { data, error, refetch, isFetching } = useConnectedApps(open);
  const disconnect = useDisconnectApp();
  const offerToUndo = useUndo();
  const [asking, setAsking] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const askedFrom = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const apps = data?.apps ?? [];
  const answered = data !== undefined;
  const beingAsked = apps.find((app) => app.id === asking);
  const address = connectAddress();

  const stopAsking = () => setAsking(null);
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
    askedFrom.current = openedFrom;
    setAsking(app.id);
  };

  /**
   * Disconnects at the click: the question closes and the row is gone at once.
   * Refused, the row comes back and the undo bar says why.
   */
  const end = (app: ConnectedApp) => {
    disconnect(app.id).catch((failure: unknown) => {
      offerToUndo({ what: `“${app.name}” was not disconnected. ${whyNotDone(failure)}` });
    });
    setAsking(null);
    // The row's menu went with the row: the focus has to land somewhere, once the question has gone.
    setTimeout(() => list.current?.focus(), 0);
  };

  return (
    <ManageWindow title="Connected apps" open={open} onClose={close} returnFocusTo={returnFocusTo} ref={list}>
      <p className="mt-1 text-sm text-ink-soft">
        Apps you allowed into your Cockpit: to capture and read your items, or only to read your Panels.
      </p>
      <SettingsPanel name="Address" hint="Paste it into claude.ai to connect Claude.">
        <div className="flex items-center gap-3">
          <code className="min-w-0 flex-1 select-all break-all text-sm">{address}</code>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-md border border-shade/20 px-2 py-1 text-xs text-ink hover:bg-accent-tint"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </SettingsPanel>

      <SettingsPanel className="mt-6" name="Connected apps" hint="Only the ones you allowed are listed." flush>
      <section>
        <ul>
          {apps.map((app) => (
            <li key={app.id} className="border-b border-shade/10 px-4 py-2.5 last:border-b-0">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{app.name}</p>
                  <p className="text-sm text-ink-faint">{whatItDid(app)}</p>
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
            returnFocusTo={askedFrom.current}
            onCancel={stopAsking}
            onConfirm={() => end(beingAsked)}
          />
        )}
        {Boolean(error) && !answered && (
          <div className="px-4 py-4">
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        )}
        {answered && apps.length === 0 && !isFetching && (
          <p className="px-4 py-4 text-sm text-ink-faint">No connected apps</p>
        )}
      </section>
      </SettingsPanel>

      <CloseWindow />
    </ManageWindow>
  );
}
