import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueries } from '@tanstack/react-query';
import { uuidv7, type Workspace } from '@cockpit/shared';
import { refusalFrom, snapshotQuery, useSendCommand, whyNotDone } from '../api/queries';
import { matchingPanels, newPanelOffer, panelsToFileOn, type FileOnOption } from '../fileOn';
import { browserStore, rememberedIn } from '../lastVisited';
import { refuseWhileOffline } from '../offline';
import { useUndo } from '../undo';

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
 *
 * **Picking a Panel closes the list** and leaves the cursor on the field, which
 * then reads *Add another Panel…*; a click or a typed character (which starts the
 * search) opens it again, focus alone does not, and leaving it without a pick
 * (a click outside, Tab past it) closes it and drops what was typed. **Closing
 * only hides the list**: the search stays mounted, so reopening never reads a
 * Workspace snapshot again.
 */
export default function FileOnSearch({
  where,
  from,
  workspaces,
  chosen,
  instantly = false,
  onPick,
  opened = true,
  disabled = false,
  closedPlaceholder,
}: {
  where: string | null;
  /** The Workspace Capture was opened from, whose Dashboard a plain name is made on under *Any workspace*. */
  from: string | null;
  workspaces: readonly Workspace[];
  chosen: readonly string[];
  /**
   * Picks a Panel it makes at the click, before the server has answered, where
   * Capture waits for it: the Item form's filing joins the queue behind the Panel
   * (issue 1364), while a capture is sent outside the queue and needs the Panel
   * to be there.
   */
  instantly?: boolean;
  onPick: (option: FileOnOption) => void;
  /** Whether the list is open from the start, and opens it where it turns true later: a click loaded the search, where focus alone (Tab) did not. */
  opened?: boolean;
  /** Disables the closed field and the options, as Capture does while it is pending or the form is saving. */
  disabled?: boolean;
  /** What the closed field reads, said by the line that knows whether a Panel is chosen. */
  closedPlaceholder: string;
}) {
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(opened);
  useEffect(() => {
    if (opened) setOpen(true);
  }, [opened]);
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  /** What the screen holds now, for an answer that arrives later. */
  const live = useRef({ open, typed });
  live.current = { open, typed };
  const send = useSendCommand();
  const offerToUndo = useUndo();
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

  /** Hides the list and drops what was typed. The search itself stays, so reopening reads nothing again. */
  const close = () => {
    setOpen(false);
    setTyped('');
    setRefusal(null);
  };

  const pick = (option: FileOnOption) => {
    onPick(option);
    close();
    // A pick from an option button would otherwise leave the cursor nowhere once the button is gone, but never pull it back from elsewhere.
    if (root.current?.contains(document.activeElement)) field.current?.focus();
  };

  const makePanel = async () => {
    if (offer?.kind !== 'make' || makingNow.current || disabled) return;
    makingNow.current = true;
    setMaking(true);
    setRefusal(null);
    const sentText = typed;
    const panelId = uuidv7();
    const option = {
      panelId,
      name: offer.name,
      dashboardName: offer.dashboardName,
      workspaceId: offer.workspaceId,
      workspaceName: offer.workspaceName,
    };
    try {
      refuseWhileOffline();
      const made = send({
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
      if (instantly) {
        // Picked at the click, the filing behind the Panel in the queue: a refusal
        // takes both back and is said once, in the undo bar.
        made.catch((failure: unknown) => offerToUndo({ what: `The panel “${option.name}” was not added. ${whyNotDone(failure)}` }));
        pick({ ...option, made });
      } else {
        await made;
        pick(option);
      }
    } catch (error) {
      // The text stays, so the name can be edited and tried again; an answer for a list since closed or text since changed is not shown.
      if (live.current.open && live.current.typed === sentText) setRefusal(refusalFrom({ error }));
    } finally {
      makingNow.current = false;
      setMaking(false);
    }
  };

  return (
    <div
      ref={root}
      className="relative w-full min-w-0 sm:w-72"
      // Pressing anything here but the field keeps the cursor where it is, so pressing an option or its text is not leaving the list.
      onMouseDown={(event) => {
        if (event.target !== field.current) event.preventDefault();
      }}
      onBlur={(event) => {
        // Leaving the field and its list closes it; moving between its own parts, or the window losing focus, does not.
        if (open && document.hasFocus() && !event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <input
        ref={field}
        type={open ? 'search' : 'text'}
        disabled={!open && disabled}
        autoFocus
        value={typed}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          // A character typed on the closed field opens the list with it in the search.
          setOpen(true);
          setTyped(event.target.value);
          // A refusal is about the text it was given.
          setRefusal(null);
        }}
        onKeyDown={(event) => {
          // Closed, Enter is the form's own.
          if (!open) return;
          // Never the form's: Enter here adds a Panel, it does not capture.
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            // Nothing typed is not a choice: the first of the list is no match.
            const top = typed.trim() === '' ? undefined : matches[0];
            if (top && !disabled) pick(top);
          } else if (event.key === 'Escape' && typed !== '') {
            event.stopPropagation();
            setTyped('');
          }
        }}
        placeholder={open ? 'Find a Panel…' : closedPlaceholder}
        aria-label="Find a Panel to file on"
        autoComplete="off"
        className="min-h-9 w-full rounded-md border border-shade/10 bg-field px-3 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none sm:min-h-0 sm:py-1 sm:text-[13px]"
      />
      {open && (
      <ul
        aria-label="Panels to file on"
        className="mt-1 max-h-56 overflow-y-auto rounded-md border border-shade/10 bg-surface text-sm shadow-field empty:hidden"
      >
        {matches.slice(0, 50).map((option) => (
          <li key={option.panelId}>
            <button
              type="button"
              disabled={disabled}
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
              disabled={offer.kind === 'ask' || !online}
              // Not `disabled` while making: that would blur the focused option and close the list under its own refusal.
              aria-disabled={making || disabled || undefined}
              onClick={() => void makePanel()}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-accent-tint hover:text-accent-deep focus-visible:bg-accent-tint focus-visible:outline-none disabled:text-ink-faint disabled:hover:bg-transparent aria-disabled:opacity-60"
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
      )}
      {open && refusal && (
        <p role="alert" className="pt-1 text-sm text-over-ink">
          {refusal}
        </p>
      )}
      {open && matches.length === 0 && !offer && typed.trim() !== '' && !reading && (
        <p className="pt-1 text-xs text-ink-faint">Nothing called “{typed.trim()}”.</p>
      )}
      {open && leftOut.length > 0 && !reading && (
        <p role="status" className="pt-1 text-xs text-ink-faint">
          Not read yet, so left out: {leftOut.join(', ')}.
        </p>
      )}
    </div>
  );
}
