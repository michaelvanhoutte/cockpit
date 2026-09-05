import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { itemsInTheInbox } from '../filing';
import { CaptureForm } from './CaptureForm';
import { ItemList } from './ItemList';

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
export function InboxHeading({ workspaceId, id }: { workspaceId: string; id?: string }) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const inbox = data ? itemsInTheInbox(data.items, data.filings ?? []) : null;

  return (
    <div className="flex items-baseline gap-2">
      <h2
        id={id}
        className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
      >
        Inbox
      </h2>
      {/* Nothing where the snapshot has not arrived, rather than a zero: an
          Inbox that has not been read yet is not an empty one. */}
      {inbox && (
        <span className="ml-auto text-xs tabular-nums text-ink-faint">{inbox.length}</span>
      )}
    </div>
  );
}

/**
 * One workspace's Inbox, holding every item still to deal with, with capture as
 * its first row. Which items that is, is a view over the snapshot evaluated in
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
  const inbox = itemsInTheInbox(data.items, data.filings ?? []);

  /* No box of its own and no heading: the column it is drawn in is the hollow
     in the sheet (pages/Layout.tsx), and the name and count are up in the band
     above it. What is left here is what the Inbox actually holds. */
  return (
    <>
      {/* Writing something down and seeing where it landed are the same
          place: the box is the Inbox's first row. */}
      <div className="border-b border-black/5 px-4 py-3">
        <CaptureForm
          workspaceId={workspaceId}
          // `?? []` for the reason the filings above carry one: a stored
          // snapshot can predate the field, and capture with no types to
          // offer is a box you can type a name into rather than a crash.
          types={data.itemTypes ?? []}
          items={data.items}
        />
      </div>

      <ItemList
        workspaceId={workspaceId}
        items={inbox}
        // The Inbox is beside the dashboards rather than one of them, so
        // there is no dashboard here for the picker to offer first.
        openDashboardId={null}
        emptyMessage="Nothing to deal with."
      />
    </>
  );
}
