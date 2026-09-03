import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { itemsInTheInbox } from '../filing';
import { CaptureForm } from './CaptureForm';
import { LoadFailure } from './LoadFailure';
import { ItemList } from './ItemList';

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
  const { data, isLoading, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const headingId = useId();

  // Nothing of this workspace to show, so the failure is the whole view.
  if (error && !data) {
    return <LoadFailure error={error} onRetry={() => void refetch()} />;
  }
  if (isLoading || !data) {
    return <p className="text-ink-faint">Loading…</p>;
  }

  // Everything still yours to handle that is on no panel. `?? []` because a
  // snapshot can be older than the field: the stored copy is rehydrated from
  // IndexedDB without being parsed again (main.tsx), so somebody who had
  // Cockpit open before this landed opens it afterwards holding a snapshot with
  // no filings at all — which should be an Inbox holding everything, the way it
  // was, rather than a blank screen.
  const inbox = itemsInTheInbox(data.items, data.filings ?? []);

  return (
    <div className="flex flex-col gap-6">
      {/* The stored copy stays on screen behind this: reading what you already
          have is what the local copy is for (functional definition, "Offline /
          local-first behavior"), so a failed refresh reports itself instead of
          blanking the workspace. */}
      {error && <LoadFailure error={error} onRetry={() => void refetch()} />}

      <section aria-labelledby={headingId} className="rounded-lg bg-surface shadow-panel">
        <header className="flex items-baseline gap-2 border-b border-black/5 px-4 py-3">
          <h2 id={headingId} className="text-base font-semibold">
            Inbox
          </h2>
          <span className="text-xs text-ink-faint">still to deal with</span>
          <span className="ml-auto rounded-full bg-accent-tint px-2 text-xs tabular-nums text-accent-deep">
            {inbox.length}
          </span>
        </header>

        {/* Writing something down and seeing where it landed are the same
            place: the box is the Inbox's first row. */}
        <div className="border-b border-black/5 px-4 py-3">
          <CaptureForm workspaceId={workspaceId} />
        </div>

        <ItemList
          workspaceId={workspaceId}
          items={inbox}
          // The Inbox is beside the dashboards rather than one of them, so
          // there is no dashboard here for the picker to offer first.
          openDashboardId={null}
          emptyMessage="Nothing to deal with."
        />
      </section>
    </div>
  );
}
