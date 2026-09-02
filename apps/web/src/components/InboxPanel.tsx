import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { CaptureForm } from './CaptureForm';
import { LoadFailure } from './LoadFailure';
import { ItemRow } from './ItemRow';

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
 * It narrows back to unprocessed items only when panels hold items - a panel is
 * a box with a title until then ("Render actions in panels, backed by one
 * shared action list", issue 36).
 */
export function InboxPanel({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const headingId = useId();

  // Nothing of this workspace to show, so the failure is the whole view.
  if (error && !data) {
    return <LoadFailure error={error} onRetry={() => void refetch()} canTakeOver />;
  }
  if (isLoading || !data) {
    return <p className="text-ink-faint">Loading…</p>;
  }

  // Everything that is still yours to handle. Dismissed items never reach the
  // client at all — the snapshot leaves them out server-side.
  const inbox = data.items.filter((i) => i.status !== 'done' && i.status !== 'dismissed');

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

        {inbox.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-faint">Nothing to deal with.</p>
        ) : (
          <ul>
            {inbox.map((item) => (
              <ItemRow key={item.id} item={item} workspaceId={workspaceId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
