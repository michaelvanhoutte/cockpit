import { useRef, useState, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';
import { uuidv7, type Workspace } from '@cockpit/shared';
import { refusalFrom, snapshotQuery, useSendCommand } from '../api/queries';
import { matchingPanels, newPanelOffer, panelsToFileOn, type FileOnOption } from '../fileOn';
import { browserStore, rememberedIn } from '../lastVisited';

/** Said on the option while there is no connection, since the Panel is made when chosen. */
export const NEW_PANEL_NEEDS_A_CONNECTION = 'Needs a connection to make a Panel.';

const subscribeToConnection = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

/**
 * The type-ahead behind Capture's *File on* ("File a note on Panels from
 * Capture, skipping the Inbox", issue 1101). **Loaded on first focus**
 * (`FileOnLine.tsx`), so the initial bundle carries only the line and its chips.
 *
 * Reads the snapshot of each Workspace in scope the way Go to panel does: the
 * chosen one, or every one under *Any workspace*, and offline only those already
 * held are searchable - which it says.
 *
 * **Its last option makes a Panel** ("Make a new Panel from Capture's File on",
 * issue 1103): **+ New panel “…”**, where `newPanelOffer` says, made when chosen
 * with the command **Move to…**'s + sends and then picked like any other, so a
 * capture later undone leaves it standing. Offline it is shown and unavailable.
 */
export default function FileOnSearch({
  where,
  from,
  workspaces,
  chosen,
  onPick,
}: {
  where: string | null;
  /** The Workspace Capture was opened from, whose Dashboard a plain name is made on under *Any workspace*. */
  from: string | null;
  workspaces: readonly Workspace[];
  chosen: readonly string[];
  onPick: (option: FileOnOption) => void;
}) {
  const [typed, setTyped] = useState('');
  const send = useSendCommand();
  const online = useSyncExternalStore(
    subscribeToConnection,
    () => navigator.onLine !== false,
    () => true,
  );
  /** Why the Panel could not be made, said under the field, gone once the text is edited. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** That the Panel is being made, so the option cannot be pressed twice. */
  const [making, setMaking] = useState(false);
  const makingNow = useRef(false);
  const reads = useQueries({
    queries: workspaces.map((workspace) => ({
      ...snapshotQuery(workspace.id),
      enabled: where === null || workspace.id === where,
    })),
  });
  const held = workspaces.map((workspace, at) => ({ workspace, snapshot: reads[at]?.data }));
  const { options, leftOut } = panelsToFileOn(held, where);
  const matches = matchingPanels(options, typed, chosen);
  const reading = reads.some((read, at) => read.isPending && read.fetchStatus !== 'idle' && !held[at]?.snapshot);

  const offer = newPanelOffer(typed, held, where, from, (workspaceId, dashboards) => {
    const remembered = rememberedIn(browserStore(), workspaceId);
    return dashboards.find((dashboard) => dashboard.id === remembered)?.id ?? null;
  });

  const pick = (option: FileOnOption) => {
    onPick(option);
    setTyped('');
    setRefusal(null);
  };

  const makePanel = async () => {
    if (offer?.kind !== 'make' || makingNow.current) return;
    makingNow.current = true;
    setMaking(true);
    setRefusal(null);
    const panelId = uuidv7();
    try {
      await send({
        name: 'add_panel',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: offer.workspaceId,
          dashboardId: offer.dashboardId,
          panelId,
          name: offer.name,
          kind: 'items',
        },
      });
    } catch (error) {
      // The text stays, so the name can be edited and tried again.
      setRefusal(refusalFrom({ error }));
      return;
    } finally {
      makingNow.current = false;
      setMaking(false);
    }
    pick({
      panelId,
      name: offer.name,
      dashboardName: offer.dashboardName,
      workspaceId: offer.workspaceId,
      workspaceName: offer.workspaceName,
    });
  };

  return (
    <div className="relative w-full min-w-0 sm:w-72">
      <input
        type="search"
        autoFocus
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          // A refusal is about the text it was given.
          setRefusal(null);
        }}
        onKeyDown={(event) => {
          // Never the form's: Enter here adds a Panel, it does not capture.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            // Nothing typed is not a choice: the first of the list is no match.
            const top = typed.trim() === '' ? undefined : matches[0];
            if (top) pick(top);
          } else if (event.key === 'Escape' && typed !== '') {
            event.stopPropagation();
            setTyped('');
          }
        }}
        placeholder="Find a Panel…"
        aria-label="Find a Panel to file on"
        autoComplete="off"
        className="min-h-9 w-full rounded-md border border-shade/10 bg-field px-3 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none sm:min-h-0 sm:py-1 sm:text-[13px]"
      />
      <ul
        aria-label="Panels to file on"
        className="mt-1 max-h-56 overflow-y-auto rounded-md border border-shade/10 bg-surface text-sm shadow-field empty:hidden"
      >
        {matches.slice(0, 50).map((option) => (
          <li key={option.panelId}>
            <button
              type="button"
              onClick={() => pick(option)}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent-tint hover:text-accent-deep focus-visible:bg-accent-tint focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              <span className="shrink-0 text-xs text-ink-faint">
                {where === null ? `${option.workspaceName} ▸ ${option.dashboardName}` : option.dashboardName}
              </span>
            </button>
          </li>
        ))}
        {offer && (
          <li>
            <button
              type="button"
              disabled={offer.kind === 'ask' || !online || making}
              onClick={() => void makePanel()}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent-tint hover:text-accent-deep focus-visible:bg-accent-tint focus-visible:outline-none disabled:text-ink-faint disabled:hover:bg-transparent"
            >
              {offer.kind === 'ask' ? (
                <span className="min-w-0 flex-1">+ New panel: {offer.reason}</span>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">+ New panel “{offer.name}”</span>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {!online
                      ? NEW_PANEL_NEEDS_A_CONNECTION
                      : where === null
                        ? `${offer.workspaceName} ▸ ${offer.dashboardName}`
                        : offer.dashboardName}
                  </span>
                </>
              )}
            </button>
          </li>
        )}
      </ul>
      {refusal && (
        <p role="alert" className="pt-1 text-sm text-over-ink">
          {refusal}
        </p>
      )}
      {matches.length === 0 && !offer && typed.trim() !== '' && !reading && (
        <p className="pt-1 text-xs text-ink-faint">Nothing called “{typed.trim()}”.</p>
      )}
      {leftOut.length > 0 && !reading && (
        <p role="status" className="pt-1 text-xs text-ink-faint">
          Not read yet, so left out: {leftOut.join(', ')}.
        </p>
      )}
    </div>
  );
}
