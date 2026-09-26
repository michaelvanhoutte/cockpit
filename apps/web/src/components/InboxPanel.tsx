import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { filingsThatFile, itemsInTheInbox } from '../filing';
import { ItemList } from './ItemList';
import { RowMenu } from './Menu';
import { RewriteHistoryWindow } from './RewriteHistoryWindow';
import { HOW_TO_FILE_FROM_THE_INBOX } from '../whatThingsAre';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { INBOX_KEY } from '../inboxCollapsed';
import { restedLongEnough } from '../switchWhileDragging';

/** How many items the Inbox holds, or null until the snapshot has arrived. */
function useInboxCount(workspaceId: string): number | null {
  const { data } = useQuery(snapshotQuery(workspaceId));
  return data
    ? itemsInTheInbox(data.items, filingsThatFile(data.filings ?? [], data.panels ?? [])).length
    : null;
}

/**
 * The collapsed Inbox: a chip in the leftmost slot of the Dashboard bar with its
 * name, its count and the way back ("Collapse the Inbox to its heading, and open
 * it again with one press", issue 535).
 *
 * **A row held on it opens the Inbox, and it is never a place to land** - the
 * same gesture that switches dashboards on a tab (`DashboardBar.tsx`): a rest of
 * the full dwell opens the column and the drag carries on into its list, and a
 * row let go on the chip does nothing rather than being followed as a link.
 * `className` is the bar's own tab look, so the bar is the height it is with the
 * column open.
 */
export function InboxChip({
  workspaceId,
  onOpen,
  className,
}: {
  workspaceId: string;
  onOpen: () => void;
  className: string;
}) {
  const count = useInboxCount(workspaceId);
  /** Since when a row has rested here; a ref, for the reason the tabs' is. */
  const restingSince = useRef<number | null>(null);
  return (
    <button
      type="button"
      className={className}
      title={`Open the Inbox (${INBOX_KEY.toUpperCase()})`}
      onClick={onOpen}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
        event.preventDefault();
        const now = Date.now();
        if (restingSince.current === null) {
          restingSince.current = now;
          return;
        }
        if (!restedLongEnough(restingSince.current, now)) return;
        restingSince.current = null;
        onOpen();
      }}
      onDragLeave={() => {
        restingSince.current = null;
      }}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) event.preventDefault();
        restingSince.current = null;
      }}
    >
      <span className="flex min-h-9 items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-[0.11em]">Inbox</span>
        {count !== null && <span className="text-xs tabular-nums">{count}</span>}
        <span aria-hidden="true">»</span>
      </span>
    </button>
  );
}

/**
 * The Inbox's name and how much is in it, drawn wherever the Inbox is headed:
 * in the dashboard band above the column, where there is room for a column
 * (pages/Layout.tsx), and on the screen the tab opens where there is not
 * (pages/WorkspacePage.tsx).
 *
 * **Separate from the panel below it** because on a wide screen the two are not
 * in the same place: the heading sits on the band beside the dashboard tabs and
 * the list sits on the sheet under it, which is what says the Inbox is the
 * workspace's rather than one of its dashboards ("Cockpit Shell Explorations",
 * artboard 2c).
 *
 * It costs no request of its own: the count is the same view over the same
 * snapshot the column below is already reading.
 */
export function InboxHeading({
  workspaceId,
  id,
  onCollapse,
}: {
  workspaceId: string;
  id?: string;
  /** Where the column can be collapsed: given only beside the dashboards, not on the phone's screen of its own. */
  onCollapse?: () => void;
}) {
  const count = useInboxCount(workspaceId);

  /** The account-wide rewrite history, opened from this heading's own menu ("See the history of what Cockpit proposed for the Inbox's items", issue 444). */
  const [historyOpen, setHistoryOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  return (
    <>
      <div className="flex items-baseline gap-2">
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title={`Collapse the Inbox (${INBOX_KEY.toUpperCase()})`}
            aria-label="Collapse the Inbox"
            className="-ml-1 rounded px-1 text-xs text-ink-faint hover:text-ink"
          >
            «
          </button>
        )}
        <h2
          id={id}
          className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
        >
          Inbox
        </h2>
        <div className="ml-auto flex items-center gap-0.5">
          {/* Nothing where the snapshot has not arrived, rather than a zero: an
              Inbox that has not been read yet is not an empty one. */}
          {count !== null && (
            <span className="text-xs tabular-nums text-ink-faint">{count}</span>
          )}
          <RowMenu
            label="Actions for the Inbox"
            entries={[
              {
                label: 'Rewrite history…',
                onSelect: (openedFrom) => {
                  opener.current = openedFrom;
                  setHistoryOpen(true);
                },
              },
            ]}
          />
        </div>
      </div>
      <RewriteHistoryWindow
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        returnFocusTo={opener.current}
        workspaceId={workspaceId}
      />
    </>
  );
}

/**
 * One workspace's Inbox, holding every item still to deal with. Which items that is, is a view over the snapshot evaluated in
 * the client (architecture, "The read model: persisted snapshot, revalidate,
 * push"): the wire carries the workspace's open items and nothing about how
 * they are grouped.
 *
 * **It is rendered in two places and is the same Inbox in both** ("Show the
 * Inbox beside the dashboards instead of as a tab", issue 117): a column down
 * the left of the shell where there is room for one, and a screen of its own
 * where there is not. Nothing here knows which - what changes is the width it
 * is given.
 *
 * **What is in it is what is filed nowhere** ("Panels hold the items filed into
 * them, and the Inbox holds the rest", issue 36): every item still to deal with
 * that no panel holds. That is what makes filing an item the thing that takes
 * it out of the Inbox, rather than a status change nobody made.
 */
export function InboxPanel({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, error } = useQuery(snapshotQuery(workspaceId));

  /**
   * **The column never says the workspace could not be read**, however badly
   * it went. The shell says it once for the whole window (pages/Layout.tsx)
   * where there is a stored copy to keep painting behind it, and the screen
   * beside this column says it where there is not - and the Inbox adding a
   * second voice is what put the same notice on screen twice, in two different
   * widths, for one failed read.
   */
  if (error && !data) return null;
  if (isLoading || !data) {
    return <p className="px-4 py-3 text-ink-faint">Loading…</p>;
  }

  // Everything still yours to handle that is on no panel. `?? []` because a
  // snapshot can be older than the field: the stored copy is rehydrated from
  // IndexedDB without being parsed again (main.tsx), so somebody who had
  // Cockpit open before this landed opens it afterwards holding a snapshot with
  // no filings at all — which should be an Inbox holding everything, the way it
  // was, rather than a blank screen.
  // A filing onto a Filter is no filing at all (`filingsThatFile`), so the item
  // it names is still here - which is the whole of what makes one harmless.
  const filed = filingsThatFile(data.filings ?? [], data.panels ?? []);
  const inbox = itemsInTheInbox(data.items, filed);

  /**
   * The other end of the gesture the empty panel explains (`PanelCard.tsx`),
   * and it exists only while both halves do: something to file, and nothing
   * filed yet anywhere in this workspace. It goes for good the first time
   * anything is filed, because the gesture has then been done rather than read
   * about.
   */
  const showHowToFile = inbox.length > 0 && filed.length === 0;

  /* No box of its own and no heading: the column it is drawn in is the hollow
     in the sheet (pages/Layout.tsx), and the name and count are up in the band
     above it. What is left here is what the Inbox actually holds. */
  return (
    // At least as tall as the column it is drawn in, so the list takes what the
    // form above it leaves: as tall as the whole column, it overflowed by the
    // form's own height and always scrolled.
    <div className="flex min-h-full flex-col">
      {showHowToFile && (
        <p className="border-b border-black/5 px-4 py-2 text-sm text-ink-faint">
          {HOW_TO_FILE_FROM_THE_INBOX}
        </p>
      )}

      <ItemList
        workspaceId={workspaceId}
        items={inbox}
        // The Inbox is beside the dashboards rather than one of them, so
        // there is no dashboard here for the picker to offer first.
        openDashboardId={null}
        emptyMessage="Nothing to deal with."
        fillsTheRestOfItsColumn
      />
    </div>
  );
}
